// SOURCING: none — bun:test over ./documents (handle.keep) and ./port (the documentKeep effect), with ./local over a fault-injecting in-memory database (../layout/test-storage); a reload or a second tab is another owner over the same database nodes
import { describe, expect, test } from 'bun:test'
import {
  FakeLive,
  op,
  stubHost,
  testEnvironment,
} from '../environment/test-host'
import { accepted } from '../environment/result'
import { createLocalStore } from '../layout/checkpoint'
import { memoryDatabase } from '../layout/test-storage'
import type { Revision } from '../wire'
import { createDocuments } from './documents'
import { createDraftStore } from './local'
import { createDocumentsPort } from './port'

const seq = (value: number): Revision => ({ scheme: 'seq', value })
const ALL = [
  'documents.open',
  'documents.edit',
  'documents.save',
  'documents.close',
  'documents.reconcile',
].map((name) => op(name))

const typed = (n: number, id = `typed-${n}`) => ({
  operationId: id,
  baseRevision: seq(1),
  edits: [{ start: 0, end: 0, insert: String(n) }],
})

async function setup() {
  const host = stubHost(ALL)
  const calls: string[] = []
  const head = () => ({
    document_id: 'd1',
    revision: 1,
    content_hash: 'c',
    disk_hash: 'c',
    text: 'hello',
  })
  host.client = {
    ...host.client,
    documentSessions: {
      open: async () => (calls.push('open'), head()),
      head: async () => head(),
      edit: async () => {
        calls.push('edit')
        throw new Error('socket closed')
      },
      save: async () => ({}),
      close: async () => ({}),
      reconcile: async () => ({}),
    },
  } as never
  const { environment } = testEnvironment(host, new FakeLive())
  await environment.settled()
  const database = memoryDatabase()
  const owner = () =>
    createDocuments(environment, {
      drafts: createDraftStore({
        store: createLocalStore({
          directory: 'd',
          account: 't1:p1',
          open: async () => database,
        }),
        workspaceId: 'w1',
      }),
    })
  const open = async (documents = owner()) => {
    const done = await documents.open({ requestId: 'open', path: 'a.txt' })
    if (done.outcome !== 'accepted') throw new Error(`open ${done.outcome}`)
    return done.value
  }
  /** A document whose first edit the host never answered: the editor holds the rest behind it. */
  const heldFirst = async (documents = owner()) => {
    const doc = await open(documents)
    const first = await doc.edit({ requestId: 'r1', ...typed(1, 'first') })
    expect(first.outcome).toBe('uncertain')
    return doc
  }
  /** What a reload offers back: the operation ids of the restored edits, in order. */
  const reloaded = async () =>
    (await open()).state.pending.map((edit) => edit.operationId)
  return {
    host,
    environment,
    database,
    owner,
    open,
    heldFirst,
    reloaded,
    calls,
  }
}

describe('documentKeep: the editor says the queue it holds behind an unanswered edit', () => {
  test('three kept edits behind an uncertain one come back in order after a reload, and the host never saw them', async () => {
    const ctx = await setup()
    const doc = await ctx.heldFirst()
    doc.keep([typed(2), typed(3), typed(4)])
    await doc.flushLocal()
    expect(await ctx.reloaded()).toEqual([
      'first',
      'typed-2',
      'typed-3',
      'typed-4',
    ])
    expect(ctx.calls.filter((call) => call === 'edit')).toHaveLength(1)
  })

  test('a later keep with one edit replaces the three', async () => {
    const ctx = await setup()
    const doc = await ctx.heldFirst()
    doc.keep([typed(2), typed(3), typed(4)])
    doc.keep([typed(4)])
    await doc.flushLocal()
    expect(await ctx.reloaded()).toEqual(['first', 'typed-4'])
  })

  test('an empty keep clears what was kept and leaves the held edit', async () => {
    const ctx = await setup()
    const doc = await ctx.heldFirst()
    doc.keep([typed(2), typed(3)])
    await doc.flushLocal()
    doc.keep([])
    await doc.flushLocal()
    expect(await ctx.reloaded()).toEqual(['first'])
  })

  test("a second tab's keep does not erase the first tab's", async () => {
    const ctx = await setup()
    const a = await ctx.open()
    const b = await ctx.open()
    a.keep([typed(2, 'from-a')])
    await a.flushLocal()
    b.keep([typed(3, 'from-b')])
    await b.flushLocal()
    expect((await ctx.reloaded()).sort()).toEqual(['from-a', 'from-b'])
  })

  test('through the port: a keep is accepted for an open document and refused with a code for one that is not open', async () => {
    const ctx = await setup()
    const port = createDocumentsPort({
      documents: ctx.owner(),
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
    })
    let id = 0
    const perform = (kind: string, path: string, payload: unknown) =>
      port.perform(
        {
          id: (id += 1),
          resource: { type: 'document', workspace: 'w1', resourceId: path },
          kind,
          payload,
        } as never,
        `req-${id}`,
      )
    const closed = await perform('documentKeep', 'a.txt', { edits: [typed(2)] })
    expect(closed).toMatchObject({
      outcome: 'refused',
      code: 'document_not_open',
    })
    expect((await perform('documentOpen', 'a.txt', {})).outcome).toBe(
      'accepted',
    )
    expect(
      await perform('documentKeep', 'a.txt', { edits: [typed(2)] }),
    ).toEqual({
      outcome: 'accepted',
    })
    expect(await perform('documentKeep', 'a.txt', { edits: [] })).toEqual({
      outcome: 'accepted',
    })
  })
})
