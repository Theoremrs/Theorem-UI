// SOURCING: none — bun:test over ./port, with the real documents owner on the environment's test host
import { describe, expect, test } from 'bun:test'
import {
  FakeLive,
  op,
  stubHost,
  testEnvironment,
} from '../environment/test-host'
import { accepted } from '../environment/result'
import type { Effect, HostMessage, Revision } from '../wire'
import { createDocuments } from './documents'
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

async function setup() {
  const host = stubHost(ALL)
  const calls: { name: string; request: Record<string, unknown> }[] = []
  const state: { revision: number; text: string; gate?: Promise<void> } = {
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
      open: method('open', head),
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
  const port = createDocumentsPort({
    documents: createDocuments(environment),
    files: {
      create: async (request) => {
        created.push(request)
        return accepted(
          { workspaceId: 'w1', requestId: request.requestId },
          { path: request.path },
        )
      },
    },
  })
  const heard: HostMessage[] = []
  port.subscribe?.((message) => heard.push(message))
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
  return { port, perform, live, heard, calls, count, created, state }
}

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
