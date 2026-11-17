// SOURCING: none — bun:test over ./port with the real documents and history owners on the environment's test host; the host and its history operations are plain stubs
import { describe, expect, test } from 'bun:test'
import { accepted } from '../environment/result'
import {
  FakeLive,
  HttpError,
  op,
  stubHost,
  testEnvironment,
} from '../environment/test-host'
import type { HostMessage } from '../wire'
import { createDocuments } from './documents'
import { createHistory } from './history'
import { createDocumentsPort } from './port'

const OPERATIONS = [
  'documents.open',
  'documents.edit',
  'documents.save',
  'documents.close',
  'documents.reconcile',
  'history.list',
  'history.preview',
  'history.restore',
].map((name) => op(name))

const resource = {
  type: 'document',
  workspace: 'w1',
  resourceId: 'a.txt',
} as const

async function setup(withHistory = true) {
  const host = stubHost(OPERATIONS)
  /** Everything the host saw, in order. */
  const calls: string[] = []
  const world = { revision: 1, text: 'hello', editFails: false }
  const handlers = new Map<
    string,
    (request: Record<string, unknown>) => unknown
  >()
  const head = () => ({
    document_id: 'd1',
    revision: world.revision,
    content_hash: 'c',
    disk_hash: 'c',
    text: world.text,
  })
  const method =
    (name: string, answer: (request: Record<string, unknown>) => unknown) =>
    async (request: Record<string, unknown>) => {
      calls.push(name)
      return handlers.get(name)?.(request) ?? answer(request)
    }
  host.client = {
    ...host.client,
    documentSessions: {
      open: method('open', head),
      head: method('head', head),
      edit: method('edit', () => {
        if (world.editFails) throw new Error('socket closed')
        world.revision += 1
        return head()
      }),
      save: method('save', () => ({})),
      close: method('close', () => ({})),
      reconcile: method('reconcile', () => ({})),
    },
    ide: {
      workspace: host.client.ide.workspace,
      history: {
        list: method('history.list', () => ({ entries: [] })),
        preview: method('history.preview', () => ({ text: null })),
        restore: method('history.restore', () => ({})),
      },
    },
  } as never
  const { environment } = testEnvironment(host, new FakeLive())
  await environment.settled()
  const port = createDocumentsPort({
    documents: createDocuments(environment),
    files: {
      create: async (r) =>
        accepted(
          { workspaceId: 'w1', requestId: r.requestId },
          { path: r.path },
        ),
      delete: async (r) =>
        accepted(
          { workspaceId: 'w1', requestId: r.requestId },
          { path: r.path },
        ),
    },
    ...(withHistory
      ? { history: (flush) => createHistory(environment as never, { flush }) }
      : {}),
  })
  const heard: HostMessage[] = []
  port.subscribe?.((message) => heard.push(message))
  let id = 0
  const perform = (kind: string, payload?: unknown) =>
    port.perform(
      {
        id: (id += 1),
        resource,
        kind,
        ...(payload === undefined ? {} : { payload }),
        ...(kind === 'documentEdit'
          ? { revision: { scheme: 'seq', value: world.revision } }
          : {}),
      } as never,
      `req-${id}`,
    )
  return {
    perform,
    calls,
    heard,
    world,
    on: (
      name: string,
      handler: (request: Record<string, unknown>) => unknown,
    ) => void handlers.set(name, handler),
    open: () => perform('documentOpen', {}),
  }
}

describe('document history through the port', () => {
  test('a list answers the points as sequence revisions, and an empty list is accepted', async () => {
    const t = await setup()
    t.on('history.list', () => ({
      entries: [
        { operation_id: 'a', revision: 2 },
        { operation_id: 'b', revision: 3 },
      ],
    }))
    expect(await t.perform('documentHistoryList')).toEqual({
      outcome: 'accepted',
      value: {
        type: 'documentHistory',
        entries: [
          { point: 'b', revision: { scheme: 'seq', value: 3 } },
          { point: 'a', revision: { scheme: 'seq', value: 2 } },
        ],
      },
    })
    t.on('history.list', () => ({ entries: [] }))
    expect(await t.perform('documentHistoryList')).toEqual({
      outcome: 'accepted',
      value: { type: 'documentHistory', entries: [] },
    })
  })

  test('a preview answers the text; a point with none is refused no_text', async () => {
    const t = await setup()
    t.on('history.preview', () => ({ text: 'old' }))
    expect(await t.perform('documentHistoryPreview', { point: 'p' })).toEqual({
      outcome: 'accepted',
      value: { type: 'documentPreview', text: 'old' },
    })
    t.on('history.preview', () => ({ text: null }))
    expect(
      await t.perform('documentHistoryPreview', { point: 'p' }),
    ).toMatchObject({
      outcome: 'refused',
      code: 'no_text',
    })
  })

  test('a failing host is failed, a refusing one is refused with its code', async () => {
    const t = await setup()
    t.on('history.list', () => {
      throw new HttpError(500)
    })
    expect((await t.perform('documentHistoryList')).outcome).toBe('failed')
    t.on('history.preview', () => {
      throw new HttpError(409, { code: 'point_unknown' })
    })
    expect(
      await t.perform('documentHistoryPreview', { point: 'p' }),
    ).toMatchObject({
      outcome: 'refused',
      code: 'point_unknown',
    })
  })

  test('a restore of an open document with nothing pending is accepted, and the core hears the restored text and revision', async () => {
    const t = await setup()
    await t.open()
    t.heard.length = 0
    t.on('history.restore', () => {
      // The host restores: a new revision with the old text, before the live stream says so.
      t.world.revision = 5
      t.world.text = 'restored'
      return {}
    })
    expect(await t.perform('documentHistoryRestore', { point: 'p1' })).toEqual({
      outcome: 'accepted',
    })
    expect(t.calls.indexOf('history.restore')).toBeLessThan(
      t.calls.lastIndexOf('head'),
    )
    expect(t.heard).toContainEqual(
      expect.objectContaining({
        type: 'documentResync',
        revision: { scheme: 'seq', value: 5 },
        text: 'restored',
      }),
    )
  })

  test('a restore with an edit the host never answered is refused pending_edits, nothing is sent, and the text is not touched', async () => {
    const t = await setup()
    await t.open()
    t.world.editFails = true
    expect(
      (
        await t.perform('documentEdit', {
          operationId: 'o1',
          unit: 'utf16',
          edits: [{ start: 0, end: 0, insert: 'x' }],
        })
      ).outcome,
    ).toBe('uncertain')
    const before = t.calls.length
    expect(
      await t.perform('documentHistoryRestore', { point: 'p1' }),
    ).toMatchObject({
      outcome: 'refused',
      code: 'pending_edits',
    })
    expect(t.calls.slice(before)).toEqual([])
  })

  test('an uncertain restore is uncertain, sent once, and never retried', async () => {
    const t = await setup()
    await t.open()
    t.on('history.restore', () => {
      throw new Error('socket closed')
    })
    expect(
      (await t.perform('documentHistoryRestore', { point: 'p1' })).outcome,
    ).toBe('uncertain')
    expect(t.calls.filter((c) => c === 'history.restore')).toHaveLength(1)
    expect(t.calls.filter((c) => c === 'head')).toHaveLength(0)
  })

  test('a restore of a document that is not open is refused document_not_open without a call', async () => {
    const t = await setup()
    expect(
      await t.perform('documentHistoryRestore', { point: 'p1' }),
    ).toMatchObject({
      outcome: 'refused',
      code: 'document_not_open',
    })
    expect(t.calls).toEqual([])
  })

  test('with no history owner the three kinds are refused owner_unavailable', async () => {
    const t = await setup(false)
    for (const [kind, payload] of [
      ['documentHistoryList', undefined],
      ['documentHistoryPreview', { point: 'p' }],
      ['documentHistoryRestore', { point: 'p' }],
    ] as const)
      expect(await t.perform(kind, payload)).toMatchObject({
        outcome: 'refused',
        code: 'owner_unavailable',
      })
  })
})
