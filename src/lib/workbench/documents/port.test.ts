// SOURCING: none — bun:test over ./port, with the real documents owner on the environment's test host
import { describe, expect, test } from 'bun:test'
import {
  FakeLive,
  op,
  stubHost,
  testEnvironment,
} from '../environment/test-host'
import { accepted, refused } from '../environment/result'
import type { Effect, HostMessage, Revision } from '../wire'
import { createDocuments } from './documents'
import { createLocalStore } from '../layout/checkpoint'
import { memoryDatabase } from '../layout/test-storage'
import { createDraftStore } from './local'
import type { DraftStore } from './local'
import { createDocumentsPort } from './port'

const ALL = [
  'documents.open',
  'documents.edit',
  'documents.save',
  'documents.close',
  'documents.reconcile',
].map((name) => op(name))

const seq = (value: number): Revision => ({ scheme: 'seq', value })
const resource = (path = 'a.txt') => ({
  type: 'document' as const,
  workspace: 'w1',
  resourceId: path,
})

async function setup(operations = ALL, drafts?: DraftStore) {
  const host = stubHost(operations)
  const calls: { name: string; request: Record<string, unknown> }[] = []
  const state: {
    revision: number
    text: string
    gate?: Promise<void>
    openFails?: boolean
  } = {
    revision: 1,
    text: 'hello',
  }
  const head = () => ({
    document_id: 'd1',
    revision: state.revision,
    content_hash: 'c',
    disk_hash: 'c',
    text: state.text,
  })
  const method =
    (name: string, answer: (request: Record<string, unknown>) => unknown) =>
    async (request: Record<string, unknown>) => {
      calls.push({ name, request })
      return answer(request)
    }
  host.client = {
    ...host.client,
    documentSessions: {
      open: method('open', () => {
        if (state.openFails) throw new Error('the host could not open it')
        return head()
      }),
      head: method('head', head),
      edit: method('edit', async (request) => {
        await state.gate
        state.revision = (request.base_revision as number) + 1
        return head()
      }),
      save: method('save', () => ({})),
      close: method('close', () => ({})),
      reconcile: method('reconcile', () => ({})),
    },
  } as never
  const live = new FakeLive()
  const { environment } = testEnvironment(host, live)
  await environment.settled()
  const created: object[] = []
  const deleted: string[] = []
  /** Paths the checkout already has: the host refuses to create over one, as it does. */
  const existing = new Set<string>()
  const port = createDocumentsPort({
    documents: createDocuments(environment, drafts ? { drafts } : {}),
    files: {
      create: async (request) => {
        created.push(request)
        if (existing.has(request.path))
          return refused(
            { workspaceId: 'w1', requestId: request.requestId },
            'exists',
            `${request.path} already exists`,
          )
        return accepted(
          { workspaceId: 'w1', requestId: request.requestId },
          { path: request.path },
        )
      },
      delete: async (request) => {
        deleted.push(request.path)
        return accepted(
          { workspaceId: 'w1', requestId: request.requestId },
          { path: request.path },
        )
      },
    },
  })
  const heard: HostMessage[] = []
  /** The `documentLocal` messages, apart: the other tests look at what else was said. */
  const locals: HostMessage[] = []
  port.subscribe?.((message) =>
    (message.type === 'documentLocal' ? locals : heard).push(message),
  )
  let id = 0
  const perform = (
    kind: Effect['kind'],
    extra: Record<string, unknown> = {},
    path = 'a.txt',
  ) =>
    port.perform(
      { id: (id += 1), resource: resource(path), kind, ...extra } as never,
      `req-${id}`,
    )
  const count = (name: string) =>
    calls.filter((call) => call.name === name).length
  return {
    port,
    perform,
    live,
    heard,
    locals,
    calls,
    count,
    created,
    deleted,
    existing,
    state,
  }
}

describe('document tokens', () => {
  const later = () => new Promise((resolve) => setTimeout(resolve, 5))

  test('an open sends the spans of its revision after the answer, once per revision, in UTF-16 units', async () => {
    const { perform, heard, state } = await setup()
    state.text = 'const a = 1\n'
    await perform('documentOpen', { payload: {} }, 'a.ts')
    expect(heard.filter((m) => m.type === 'documentTokens')).toEqual([])
    await later()
    const sent = heard.filter((m) => m.type === 'documentTokens')
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({
      type: 'documentTokens',
      resource: resource('a.ts'),
      revision: seq(1),
      encoding: 'utf16_code_units',
    })
    expect((sent[0] as { spans: unknown[] }).spans.length).toBeGreaterThan(0)
  })

  test('a file with no grammar sends no tokens', async () => {
    const { perform, heard } = await setup()
    await perform('documentOpen', { payload: {} }, 'notes.xyz')
    await later()
    expect(heard.filter((m) => m.type === 'documentTokens')).toEqual([])
  })
})

describe('read only', () => {
  test('an open says why when the host lists documents.edit as unavailable, and says nothing otherwise', async () => {
    const plain = await setup()
    expect(
      await plain.perform('documentOpen', { payload: {} }),
    ).not.toHaveProperty('value.readOnly')
    const locked = await setup([
      ...ALL.filter((entry) => entry.operation !== 'documents.edit'),
      op('documents.edit', { granted: false, reason: 'no write access' }),
    ])
    expect(await locked.perform('documentOpen', { payload: {} })).toMatchObject(
      {
        value: {
          readOnly: { reason: expect.stringContaining('no write access') },
        },
      },
    )
  })
})

describe('open', () => {
  test('answers documentOpened with the owner text and revision, and a second open does not call the host', async () => {
    const { perform, count } = await setup()
    const first = await perform('documentOpen', { payload: {} })
    expect(first).toMatchObject({
      outcome: 'accepted',
      value: {
        type: 'documentOpened',
        text: 'hello',
        revision: seq(1),
        savedRevision: seq(1),
        dirty: false,
      },
      revision: seq(1),
    })
    await perform('documentOpen', { payload: {} })
    expect(count('open')).toBe(1)
  })

  test('a seed is refused: the owner opens a file as it is', async () => {
    const { perform, count } = await setup()
    expect(
      await perform('documentOpen', { payload: { seedText: 'x' } }),
    ).toMatchObject({ outcome: 'refused', code: 'unsupported_seed' })
    expect(count('open')).toBe(0)
  })

  test('create makes the file with its seed, then opens it', async () => {
    const { perform, created, count } = await setup()
    const done = await perform(
      'documentCreate',
      { payload: { path: 'n.txt', seedText: 'seed' } },
      'n.txt',
    )
    expect(created).toEqual([
      { requestId: 'req-1:create', path: 'n.txt', kind: 'file', text: 'seed' },
    ])
    expect(count('open')).toBe(1)
    expect(done).toMatchObject({ outcome: 'accepted' })
  })

  test('a failed open after create removes the file this call created and reports the open failure', async () => {
    const { perform, state, deleted } = await setup()
    state.openFails = true
    const done = await perform(
      'documentCreate',
      { payload: { path: 'n.txt' } },
      'n.txt',
    )
    expect(done.outcome).not.toBe('accepted')
    expect(deleted).toEqual(['n.txt'])
  })

  test('a failed open on a path that already existed deletes nothing', async () => {
    const { perform, state, deleted, existing } = await setup()
    existing.add('old.txt')
    state.openFails = true
    const done = await perform(
      'documentCreate',
      { payload: { path: 'old.txt' } },
      'old.txt',
    )
    expect(done).toMatchObject({ outcome: 'refused', code: 'exists' })
    expect(deleted).toEqual([])
  })

  test('revert answers documentReconciled and settle is accepted with no payload', async () => {
    const { perform } = await setup()
    await perform('documentOpen', { payload: {} })
    expect(await perform('documentRevert')).toMatchObject({
      outcome: 'accepted',
      value: { type: 'documentReconciled', text: 'hello' },
    })
    expect(
      await perform('documentSettle', { payload: { operationId: 'op1' } }),
    ).toEqual({ outcome: 'accepted' })
  })

  test('a resource that is not a document is refused', async () => {
    const { port } = await setup()
    expect(
      await port.perform(
        {
          id: 1,
          resource: { type: 'workspace', workspace: 'w1' },
          kind: 'documentOpen',
          payload: {},
        },
        'r',
      ),
    ).toMatchObject({ outcome: 'refused', code: 'wrong_resource' })
  })
})

describe('edit, save, reconcile and close', () => {
  const payload = (operationId: string, unit = 'utf16') => ({
    operationId,
    unit,
    edits: [{ start: 0, end: 0, insert: 'x' }],
  })

  test('an edit goes against the effect revision and answers documentEdited with the operation id', async () => {
    const { perform, calls } = await setup()
    await perform('documentOpen', { payload: {} })
    const done = await perform('documentEdit', {
      revision: seq(1),
      payload: payload('op-1'),
    })
    expect(done).toMatchObject({
      outcome: 'accepted',
      value: { type: 'documentEdited', operationId: 'op-1', revision: seq(2) },
      revision: seq(2),
    })
    const sent = calls.find((call) => call.name === 'edit')
    expect(sent?.request.base_revision).toBe(1)
  })

  test('a stale base is refused as a conflict that carries the current text and the pending edit', async () => {
    const { perform, live, count } = await setup()
    await perform('documentOpen', { payload: {} })
    live.emit('document.changed', {
      document_id: 'd1',
      resource_id: 'a.txt',
      revision: 2,
      operation_id: 'remote',
      actor: 'someone',
      edits: [{ start: 5, end: 5, insert: '!', removed: '' }],
    })
    const done = await perform('documentEdit', {
      revision: seq(1),
      payload: payload('op-1'),
    })
    expect(done).toMatchObject({
      outcome: 'refused',
      code: 'conflict',
      value: {
        type: 'documentConflicted',
        operationId: 'op-1',
        baseRevision: seq(1),
        current: { revision: seq(2), text: 'hello!' },
        pending: [{ operationId: 'op-1', state: 'conflicted' }],
      },
    })
    expect(count('edit')).toBe(0)
  })

  test('an edit in another unit, or with no revision, is refused before the owner', async () => {
    const { perform, count } = await setup()
    await perform('documentOpen', { payload: {} })
    expect(
      await perform('documentEdit', {
        revision: seq(1),
        payload: payload('o', 'scalar'),
      }),
    ).toMatchObject({ outcome: 'refused', code: 'unsupported_unit' })
    expect(
      await perform('documentEdit', { payload: payload('o') }),
    ).toMatchObject({ outcome: 'refused', code: 'revision_required' })
    expect(count('edit')).toBe(0)
  })

  test('a document that was never opened is refused', async () => {
    const { perform } = await setup()
    expect(await perform('documentSave')).toMatchObject({
      outcome: 'refused',
      code: 'document_not_open',
    })
  })

  test('a document two panels opened stays open until the second lets go', async () => {
    const { perform, count } = await setup()
    await perform('documentOpen', { payload: {} })
    await perform('documentOpen', { payload: {} })
    expect(count('open')).toBe(1)
    expect(await perform('documentClose')).toMatchObject({
      outcome: 'accepted',
    })
    expect(count('close')).toBe(0)
    // The panel that still has it can go on working.
    expect(await perform('documentSave')).toMatchObject({
      outcome: 'accepted',
      value: { type: 'documentSaved' },
    })
    expect(await perform('documentClose')).toMatchObject({
      outcome: 'accepted',
    })
    expect(count('close')).toBe(1)
    expect(await perform('documentSave')).toMatchObject({
      outcome: 'refused',
      code: 'document_not_open',
    })
  })

  test('an open that arrives while a close is in flight takes a handle of its own', async () => {
    const { perform, count } = await setup()
    await perform('documentOpen', { payload: {} })
    const closing = perform('documentClose')
    const opening = perform('documentOpen', { payload: {} })
    expect(await closing).toMatchObject({ outcome: 'accepted' })
    expect(await opening).toMatchObject({
      outcome: 'accepted',
      value: { type: 'documentOpened' },
    })
    expect(count('open')).toBe(2)
    expect(await perform('documentSave')).toMatchObject({
      outcome: 'accepted',
    })
  })

  test('save answers documentSaved; close releases the handle and stops its events', async () => {
    const { perform, live, heard, count } = await setup()
    await perform('documentOpen', { payload: {} })
    expect(await perform('documentSave')).toMatchObject({
      outcome: 'accepted',
      value: { type: 'documentSaved', revision: seq(1) },
    })
    heard.length = 0
    expect(await perform('documentClose')).toMatchObject({
      outcome: 'accepted',
    })
    expect(count('close')).toBe(1)
    live.emit('document.changed', {
      document_id: 'd1',
      resource_id: 'a.txt',
      revision: 2,
      operation_id: 'late',
      actor: 'someone',
      edits: [],
    })
    expect(heard).toEqual([])
    expect(await perform('documentSave')).toMatchObject({
      code: 'document_not_open',
    })
  })

  test('reconcile answers documentReconciled with the owner revision and text', async () => {
    const { perform } = await setup()
    await perform('documentOpen', { payload: {} })
    expect(
      await perform('documentReconcile', { payload: { keep: 'disk' } }),
    ).toMatchObject({
      outcome: 'accepted',
      value: { type: 'documentReconciled', text: 'hello' },
    })
  })
})

describe('events', () => {
  test("another writer's change, our own acknowledged edit and a save are host messages with the owner's identity", async () => {
    const { perform, live, heard } = await setup()
    await perform('documentOpen', { payload: {} })
    live.emit('document.changed', {
      document_id: 'd1',
      resource_id: 'a.txt',
      revision: 2,
      operation_id: 'remote-2',
      actor: 'someone',
      edits: [{ start: 5, end: 5, insert: '!', removed: '' }],
    })
    live.emit('document.saved', {
      document_id: 'd1',
      resource_id: 'a.txt',
      revision: 2,
    })
    expect(heard).toEqual([
      {
        type: 'documentChanged',
        resource: resource(),
        revision: seq(2),
        actor: 'someone',
        operationId: 'remote-2',
        unit: 'utf16',
        edits: [{ start: 5, end: 5, insert: '!' }],
      },
      { type: 'documentSaved', resource: resource(), revision: seq(2) },
    ])
  })

  test('a skipped revision resyncs with the owner text and revision', async () => {
    const { perform, live, heard, state } = await setup()
    await perform('documentOpen', { payload: {} })
    state.revision = 4
    state.text = 'hello, world'
    live.emit('document.changed', {
      document_id: 'd1',
      resource_id: 'a.txt',
      revision: 4,
      operation_id: 'remote-4',
      actor: 'someone',
      edits: [{ start: 5, end: 5, insert: ', world', removed: '' }],
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(heard).toEqual([
      {
        type: 'documentResync',
        resource: resource(),
        revision: seq(4),
        text: 'hello, world',
      },
    ])
  })

  test('our own edit seen on the stream before its answer is acknowledged by operation id', async () => {
    const { perform, live, heard, state } = await setup()
    await perform('documentOpen', { payload: {} })
    let release: () => void = () => undefined
    state.gate = new Promise<void>((resolve) => (release = resolve))
    const sending = perform('documentEdit', {
      revision: seq(1),
      payload: {
        operationId: 'op-1',
        unit: 'utf16',
        edits: [{ start: 0, end: 0, insert: 'x' }],
      },
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    live.emit('document.changed', {
      document_id: 'd1',
      resource_id: 'a.txt',
      revision: 2,
      operation_id: 'op-1',
      actor: 'me',
      edits: [{ start: 0, end: 0, insert: 'x', removed: '' }],
    })
    release()
    await sending
    expect(heard).toEqual([
      {
        type: 'documentAcknowledged',
        resource: resource(),
        revision: seq(2),
        operationId: 'op-1',
      },
    ])
  })

  test('a move re-keys the held handle', async () => {
    const { perform, live, heard } = await setup()
    await perform('documentOpen', { payload: {} })
    live.emit('document.moved', {
      document_id: 'd1',
      resource_id: 'b.txt',
      path_generation: 2,
    })
    expect(heard).toEqual([
      { type: 'documentMoved', from: resource('a.txt'), to: resource('b.txt') },
    ])
    expect(await perform('documentSave', {}, 'b.txt')).toMatchObject({
      outcome: 'accepted',
    })
  })
})

describe('view', () => {
  test('lists the open documents with the owner’s text and revision, and says when one opens or closes', async () => {
    const { port, perform } = await setup()
    const changes: unknown[] = []
    port.view.on((change) => changes.push(change))
    expect(port.view.list()).toEqual([])
    await perform('documentOpen', { payload: {} }, 'a.txt')
    expect(port.view.list()).toEqual([
      { path: 'a.txt', text: 'hello', revision: seq(1) },
    ])
    await perform('documentClose', {}, 'a.txt')
    expect(port.view.list()).toEqual([])
    expect(changes).toEqual([
      { kind: 'opened', path: 'a.txt' },
      { kind: 'closed', path: 'a.txt' },
    ])
  })
})

describe('local state on the wire', () => {
  const later = () => new Promise((resolve) => setTimeout(resolve, 5))
  const draftsOver = (database = memoryDatabase()) => ({
    database,
    drafts: createDraftStore({
      store: createLocalStore({
        directory: 'd',
        account: 't1:p1',
        open: async () => database,
      }),
      workspaceId: 'w1',
      now: () => 99,
    }),
  })
  const edit = (id: string, text: string) => ({
    revision: seq(1),
    payload: {
      operationId: id,
      unit: 'utf16',
      edits: [{ start: 0, end: 0, insert: text }],
    },
  })

  test('documentLocal is sent once after an open and again whenever the state changes', async () => {
    const { drafts } = draftsOver()
    const { perform, locals, state } = await setup(ALL, drafts)
    await perform('documentOpen', { payload: {} })
    await later()
    expect(locals).toEqual([
      {
        type: 'documentLocal',
        resource: resource(),
        local: { state: 'accepted' },
      },
    ])
    let release: () => void = () => undefined
    state.gate = new Promise<void>((resolve) => (release = resolve))
    const sending = perform('documentEdit', edit('op-1', 'x'))
    await later()
    release()
    await sending
    await later()
    expect(
      locals.map((m) => m.type === 'documentLocal' && m.local.state),
    ).toEqual(['accepted', 'draft', 'checkpointed', 'accepted'])
    expect(locals[2]).toMatchObject({
      local: { state: 'checkpointed', savedAtMs: 99, recovered: false },
    })
  })

  test('a reload brings restored edits in documentOpened.pending; settling the last one lifts the refusal and clears the checkpoint', async () => {
    const { drafts, database } = draftsOver()
    const first = await setup(ALL, drafts)
    await first.perform('documentOpen', { payload: {} })
    first.state.gate = new Promise<void>(() => undefined)
    void first.perform('documentEdit', edit('typed-1', 'typed '))
    await later()
    expect(
      [...database.nodes.keys()].some((id) => id.includes(':draft:')),
    ).toBe(true)

    // The page reloads: a new port and owner over the same database; the host is still at revision 1.
    const second = await setup(ALL, draftsOver(database).drafts)
    const opened = await second.perform('documentOpen', { payload: {} })
    expect(opened).toMatchObject({
      outcome: 'accepted',
      value: {
        type: 'documentOpened',
        dirty: true,
        pending: [
          {
            operationId: 'typed-1',
            baseRevision: seq(1),
            edits: [{ start: 0, end: 0, insert: 'typed ' }],
            state: 'restored',
          },
        ],
      },
    })
    await later()
    expect(second.locals.at(-1)).toMatchObject({
      local: { state: 'checkpointed', recovered: true, savedAtMs: 99 },
    })
    const sentBefore = second.count('edit')
    expect(
      await second.perform('documentEdit', edit('typed-2', 'more ')),
    ).toMatchObject({
      outcome: 'refused',
      code: 'unreconciled_local_draft',
    })
    expect(second.count('edit')).toBe(sentBefore)

    expect(
      await second.perform('documentSettle', {
        payload: { operationId: 'typed-1' },
      }),
    ).toEqual({
      outcome: 'accepted',
    })
    await later()
    expect(
      [...database.nodes.keys()].some((id) => id.includes(':draft:')),
    ).toBe(false)
    expect(second.locals.at(-1)).toMatchObject({ local: { state: 'accepted' } })
    expect(
      await second.perform('documentEdit', edit('typed-3', 'again ')),
    ).toMatchObject({
      outcome: 'accepted',
    })
  })
})
