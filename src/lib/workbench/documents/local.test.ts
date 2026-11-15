// SOURCING: none — bun:test over ./documents with ./local over the local store, a fault-injecting
// in-memory database (../layout/test-storage) and the environment's stub host; a reload is a second
// documents owner over the same database nodes
import { describe, expect, test } from 'bun:test'
import {
  FakeLive,
  op,
  stubHost,
  testEnvironment,
} from '../environment/test-host'
import { createLocalStore } from '../layout/checkpoint'
import { domError, memoryDatabase } from '../layout/test-storage'
import type { Revision } from '../wire/Revision'
import { createDocuments } from './documents'
import type { DocumentEvent } from './documents'
import { createDraftStore } from './local'

const seq = (value: number): Revision => ({ scheme: 'seq', value })
const ALL = [
  op('documents.open'),
  op('documents.edit'),
  op('documents.save'),
  op('documents.close'),
  op('documents.reconcile'),
]

async function setup() {
  const host = stubHost(ALL)
  const state = { revision: 1, text: 'hello' }
  const handlers = new Map<
    string,
    (request: Record<string, unknown>) => unknown
  >()
  const calls: string[] = []
  const method =
    (name: string, fallback: (request: Record<string, unknown>) => unknown) =>
    async (request: Record<string, unknown>) => {
      calls.push(name)
      const handler = handlers.get(name)
      return handler ? handler(request) : fallback(request)
    }
  const head = () => ({
    document_id: 'd1',
    revision: state.revision,
    content_hash: 'c',
    disk_hash: 'c',
    text: state.text,
  })
  host.client = {
    ...host.client,
    documentSessions: {
      open: method('open', head),
      head: method('head', head),
      edit: method('edit', (request) => {
        state.revision = (request.base_revision as number) + 1
        return head()
      }),
      save: method('save', () => ({})),
      close: method('close', () => ({})),
      reconcile: method('reconcile', () => ({})),
    },
  } as never
  const { environment } = testEnvironment(host, new FakeLive())
  await environment.settled()
  const database = memoryDatabase()
  const owner = (db = database) => {
    const store = createLocalStore({
      directory: 'd',
      account: 't1:p1',
      open: async () => db,
    })
    const drafts = createDraftStore({
      store,
      workspaceId: 'w1',
      now: () => 4242,
    })
    return createDocuments(environment, { drafts })
  }
  const open = async (documents = owner(), path = 'a.txt') => {
    const done = await documents.open({ requestId: `open-${path}`, path })
    if (done.outcome !== 'accepted') throw new Error(`open ${done.outcome}`)
    return done.value
  }
  const count = (name: string) => calls.filter((call) => call === name).length
  const accountOwner = (account: string) => {
    const store = createLocalStore({
      directory: 'd',
      account,
      open: async () => database,
    })
    return createDocuments(environment, {
      drafts: createDraftStore({ store, workspaceId: 'w1' }),
    })
  }
  return {
    state,
    database,
    environment,
    accountOwner,
    owner,
    open,
    count,
    on: (
      name: string,
      handler: (request: Record<string, unknown>) => unknown,
    ) => void handlers.set(name, handler),
  }
}

const insert = (text: string) => [{ start: 0, end: 0, insert: text }]
const lost = () => {
  throw new Error('socket closed')
}
const kept = (database: ReturnType<typeof memoryDatabase>) =>
  [...database.nodes.keys()].filter((id) => id.includes(':draft:'))

describe('the three states of a document (spec 11)', () => {
  test('nothing unaccepted is accepted, and no local copy is kept', async () => {
    const { open, database } = await setup()
    const doc = await open()
    expect(doc.state.local).toEqual({ state: 'accepted' })
    expect(await doc.flushLocal()).toEqual({ state: 'accepted' })
    expect(kept(database)).toEqual([])
  })

  test('an edit is a draft at once, and checkpointed only when the database commits it, before the host answers', async () => {
    const { open, on, database } = await setup()
    const doc = await open()
    const events: DocumentEvent[] = []
    doc.on((event) => events.push(event))
    let answer!: () => void
    const answered = new Promise<void>((resolve) => (answer = resolve))
    on('edit', async () => {
      await answered
      return {
        document_id: 'd1',
        revision: 2,
        content_hash: 'c',
        disk_hash: 'c',
        text: 'xhello',
      }
    })
    const sending = doc.edit({
      requestId: 'r',
      operationId: 'op-1',
      baseRevision: seq(1),
      edits: insert('x'),
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    // The host has not answered, and the database has already committed the edit: write-ahead.
    expect(await doc.flushLocal()).toEqual({
      state: 'checkpointed',
      savedAtMs: 4242,
      recovered: false,
    })
    expect(kept(database)).toHaveLength(1)
    answer()
    expect((await sending).outcome).toBe('accepted')
    // Accepted by the authority: the local copy is no longer needed and is removed.
    expect(await doc.flushLocal()).toEqual({ state: 'accepted' })
    expect(kept(database)).toEqual([])
    expect(
      events
        .filter((event) => event.kind === 'local')
        .map((event) => event.local.state),
    ).toEqual(['draft', 'checkpointed', 'accepted'])
  })
})

describe('AC-16: a reload brings the checkpointed draft back, never as accepted', () => {
  async function reloaded() {
    const ctx = await setup()
    ctx.on('edit', lost)
    const before = await ctx.open()
    const done = await before.edit({
      requestId: 'r',
      operationId: 'typed-1',
      baseRevision: seq(1),
      edits: insert('typed '),
    })
    expect(done.outcome).toBe('uncertain')
    await before.flushLocal()
    // The page reloads: a new owner, the same database, the host still at revision 1.
    ctx.on('edit', (request) => {
      ctx.state.revision = (request.base_revision as number) + 1
      return {
        document_id: 'd1',
        revision: ctx.state.revision,
        content_hash: 'c',
        disk_hash: 'c',
        text: ctx.state.text,
      }
    })
    const after = await ctx.open(ctx.owner())
    return { ...ctx, after }
  }

  test('the pending edit and its metadata recover through the owner, shown as locally checkpointed and recovered', async () => {
    const { after } = await reloaded()
    expect(after.state.local).toEqual({
      state: 'checkpointed',
      savedAtMs: 4242,
      recovered: true,
    })
    expect(after.state.dirty).toBe(true)
    expect(after.state.pending).toHaveLength(1)
    expect(after.state.pending[0]).toMatchObject({
      operationId: 'typed-1',
      baseRevision: seq(1),
      edits: insert('typed '),
      state: 'restored',
    })
    // The authority's text is untouched: the edit is not applied by being recovered.
    expect(after.state.text).toBe('hello')
  })

  test('no further edit is sent until the recovered one is reconciled', async () => {
    const { after, count } = await reloaded()
    const editsBefore = count('edit')
    const refused = await after.edit({
      requestId: 'r2',
      operationId: 'typed-2',
      baseRevision: seq(1),
      edits: insert('more '),
    })
    expect(refused).toMatchObject({
      outcome: 'refused',
      code: 'unreconciled_local_draft',
    })
    expect(count('edit')).toBe(editsBefore)
    // The caller deals with it (here: drops it and types again), and only then does an edit go out.
    after.settle('typed-1')
    expect(await after.flushLocal()).toEqual({ state: 'accepted' })
    const sent = await after.edit({
      requestId: 'r3',
      operationId: 'typed-3',
      baseRevision: seq(1),
      edits: insert('again '),
    })
    expect(sent.outcome).toBe('accepted')
    expect(count('edit')).toBe(editsBefore + 1)
  })

  test('a recovered edit whose document has moved on says so and is still held, never rebased here', async () => {
    const ctx = await setup()
    ctx.on('edit', lost)
    const before = await ctx.open()
    await before.edit({
      requestId: 'r',
      operationId: 'typed-1',
      baseRevision: seq(1),
      edits: insert('a'),
    })
    await before.flushLocal()
    ctx.state.revision = 5
    ctx.state.text = 'changed elsewhere'
    const after = await ctx.open(ctx.owner())
    expect(after.state.revision).toEqual(seq(5))
    expect(after.state.pending[0]).toMatchObject({
      baseRevision: seq(1),
      state: 'restored',
    })
    expect(after.state.pending[0]!.reason).toContain('revision 1')
    expect(after.state.pending[0]!.reason).toContain('revision 5')
  })
})

describe('AC-17: storage failure is honest', () => {
  test('quota exceeded: the draft stays in memory and nothing claims it is saved locally', async () => {
    const { open, on, database } = await setup()
    on('edit', lost)
    database.failWrite = domError('QuotaExceededError')
    const doc = await open()
    await doc.edit({
      requestId: 'r',
      operationId: 'op-1',
      baseRevision: seq(1),
      edits: insert('x'),
    })
    expect(await doc.flushLocal()).toMatchObject({
      state: 'draft',
      problem: { code: 'storage_quota_exceeded' },
    })
    // Recoverable as far as memory allows: the edit is still held, for a named export or retry.
    expect(doc.state.pending[0]).toMatchObject({
      operationId: 'op-1',
      edits: insert('x'),
    })
    expect(kept(database)).toEqual([])
  })

  test.each([
    ['denied', domError('SecurityError', 'denied'), 'storage_denied'],
    ['blocked', domError('NoModificationAllowedError'), 'storage_blocked'],
    ['unavailable', domError('NotSupportedError'), 'storage_unavailable'],
  ])(
    '%s storage is a stated draft, never checkpointed',
    async (_name, error, code) => {
      const { open, on, database } = await setup()
      on('edit', lost)
      database.failWrite = error
      const doc = await open()
      await doc.edit({
        requestId: 'r',
        operationId: 'op-1',
        baseRevision: seq(1),
        edits: insert('x'),
      })
      expect(await doc.flushLocal()).toMatchObject({
        state: 'draft',
        problem: { code },
      })
    },
  )

  test('a failed transaction is a failed checkpoint with its reason; an unknown commit is not claimed', async () => {
    const failed = await setup()
    failed.on('edit', lost)
    failed.database.failWrite = new Error('transaction aborted')
    const a = await failed.open()
    await a.edit({
      requestId: 'r',
      operationId: 'op-1',
      baseRevision: seq(1),
      edits: insert('x'),
    })
    expect(await a.flushLocal()).toEqual({
      state: 'draft',
      problem: { code: 'checkpoint_failed', reason: 'transaction aborted' },
    })

    const unknown = await setup()
    unknown.on('edit', lost)
    unknown.database.failWrite = new Error(
      'chunk_store_browser_commit_state_unknown',
    )
    const b = await unknown.open()
    await b.edit({
      requestId: 'r',
      operationId: 'op-1',
      baseRevision: seq(1),
      edits: insert('x'),
    })
    expect(await b.flushLocal()).toMatchObject({
      state: 'draft',
      problem: { code: 'checkpoint_uncertain' },
    })
  })

  test('when storage works again the next write checkpoints the whole draft', async () => {
    const { open, on, database } = await setup()
    on('edit', lost)
    database.failWrite = domError('QuotaExceededError')
    const doc = await open()
    await doc.edit({
      requestId: 'r1',
      operationId: 'op-1',
      baseRevision: seq(1),
      edits: insert('x'),
    })
    expect((await doc.flushLocal()).state).toBe('draft')
    database.failWrite = undefined
    await doc.edit({
      requestId: 'r2',
      operationId: 'op-2',
      baseRevision: seq(1),
      edits: insert('y'),
    })
    expect((await doc.flushLocal()).state).toBe('checkpointed')
    expect(kept(database)).toHaveLength(1)
  })

  test('an owner with no local store holds drafts in memory and says so', async () => {
    const ctx = await setup()
    ctx.on('edit', lost)
    const doc = await ctx.open(createDocuments(ctx.environment))
    await doc.edit({
      requestId: 'r',
      operationId: 'op-1',
      baseRevision: seq(1),
      edits: insert('x'),
    })
    expect(doc.state.local).toMatchObject({
      state: 'draft',
      problem: { code: 'no_local_store' },
    })
    expect(await doc.flushLocal()).toMatchObject({ state: 'draft' })
  })

  test('a corrupt local draft does not stop the document opening, and is not read as a clean one', async () => {
    const ctx = await setup()
    ctx.database.nodes.set('theorem-workbench:draft:w1:a.txt', {
      id: 'theorem-workbench:draft:w1:a.txt',
      labels: ['WorkbenchDraft'],
      properties: {
        accountId: 't1:p1',
        revision: 1,
        draft: '{nope',
        savedAtMs: 1,
      },
    })
    const doc = await ctx.open()
    expect(doc.state.text).toBe('hello')
    expect(doc.state.local).toMatchObject({
      state: 'accepted',
      problem: { code: 'checkpoint_corrupt' },
    })
  })

  test('storage that cannot be read at open is stated, not assumed empty', async () => {
    const ctx = await setup()
    ctx.database.failRead = domError('NotSupportedError')
    const doc = await ctx.open()
    expect(doc.state.local).toMatchObject({
      state: 'accepted',
      problem: { code: 'storage_unavailable' },
    })
  })
})

describe('AC-50: another account does not see these drafts', () => {
  test('a draft kept by one account is refused to the next, and the document opens without it', async () => {
    const ctx = await setup()
    ctx.on('edit', lost)
    const before = await ctx.open(ctx.accountOwner('t1:p1'))
    await before.edit({
      requestId: 'r',
      operationId: 'op-1',
      baseRevision: seq(1),
      edits: insert('secret'),
    })
    expect((await before.flushLocal()).state).toBe('checkpointed')
    // The same database reached by another account's store (a wrong directory, a shared profile).
    const next = await ctx.open(ctx.accountOwner('t2:p2'))
    expect(next.state.pending).toEqual([])
    expect(next.state.local).toMatchObject({
      state: 'accepted',
      problem: { code: 'wrong_account' },
    })
    expect(JSON.stringify(next.state)).not.toContain('secret')
  })
})
