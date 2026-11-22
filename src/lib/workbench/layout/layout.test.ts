// SOURCING: none — bun:test over ./layout and ./checkpoint with the environment's stub host and a stub database
import { describe, expect, test } from 'bun:test'
import type { Node } from '@rustyreddb/browser'
import type { TheoremClient } from '@theoremharness/sdk'
import { HttpError, stubHost, testEnvironment } from '../environment/test-host'
import { createCheckpoints } from './checkpoint'
import type { CheckpointDatabase } from './checkpoint'
import { createLayout, WORKBENCH_SCHEMA } from './layout'
import type { LayoutClient, LayoutDocument } from './layout'
import type { LayoutStatus } from './status'

interface Saved {
  request: Record<string, unknown>
  options: Record<string, unknown> | undefined
}

/** The server's rules: a save is accepted only against the revision it holds, and then moves it on. */
function stubWorkbench(initial?: {
  revision: number
  document: LayoutDocument
}) {
  let held = initial
  const saves: Saved[] = []
  const workbench = {
    get: async () => {
      if (!held) throw new HttpError(404, { code: 'workbench_not_found' })
      return {
        workspaceId: 'w1',
        revision: held.revision,
        schema: WORKBENCH_SCHEMA,
        ...held.document,
      }
    },
    save: async (
      request: Record<string, unknown>,
      options?: Record<string, unknown>,
    ) => {
      saves.push({ request, options })
      const expected = Number(request['If-Match'])
      if ((held?.revision ?? 0) !== expected)
        throw new HttpError(409, {
          code: 'stale_workbench_revision',
          detail: 'The workspace layout changed; reload before saving',
        })
      const body = request.body as {
        current: unknown
        namedLayouts: Record<string, unknown>
      }
      held = {
        revision: expected + 1,
        document: { current: body.current, namedLayouts: body.namedLayouts },
      }
      return {
        workspaceId: 'w1',
        revision: held.revision,
        schema: WORKBENCH_SCHEMA,
        ...held.document,
      }
    },
  }
  return { workbench, saves, held: () => held }
}

interface MemoryDatabase extends CheckpointDatabase {
  nodes: Map<string, unknown>
  /** What the next write throws. */
  fail: unknown
  closed: number
}

function memoryDatabase(): MemoryDatabase {
  const nodes = new Map<string, Node>()
  const database: MemoryDatabase = {
    nodes,
    closed: 0,
    fail: undefined,
    async getNode(id: string) {
      return nodes.get(id) ?? null
    },
    async mutate(batch: { upsertNodes?: Node[]; deleteNodes?: string[] }) {
      if (database.fail) throw database.fail
      for (const id of batch.deleteNodes ?? []) nodes.delete(id)
      for (const node of batch.upsertNodes ?? []) nodes.set(node.id, node)
      return { txnId: nodes.size, graphVersion: nodes.size }
    },
    async close() {
      database.closed += 1
    },
  }
  return database
}

async function setup(
  initial?: { revision: number; document: LayoutDocument },
  database = memoryDatabase(),
) {
  const server = stubWorkbench(initial)
  const host = stubHost([])
  ;(host.client as unknown as { workbench: unknown }).workbench =
    server.workbench
  const { environment } = testEnvironment(host)
  await environment.settled()
  const checkpoints = createCheckpoints({
    directory: 'theorem-workbench.test',
    open: async () => database,
    now: () => 1234,
  })
  const statuses: LayoutStatus[] = []
  const layout = createLayout({
    environment: environment as unknown as Parameters<
      typeof createLayout
    >[0]['environment'],
    checkpoints,
    onStatus: (status) => statuses.push(status),
  })
  return { layout, server, database, checkpoints, environment, statuses }
}

const DOC: LayoutDocument = {
  current: { dock: { opaque: [1, 2, 3] } },
  namedLayouts: { Research: { pane: 'left' } },
}

describe('load', () => {
  test('returns the record with its revision', async () => {
    const { layout } = await setup({ revision: 4, document: DOC })
    const done = await layout.load()
    expect(done).toMatchObject({
      outcome: 'accepted',
      value: { revision: 4, document: DOC },
    })
  })

  test('no record yet is revision 0 with no document, not a failure', async () => {
    const { layout, statuses } = await setup()
    const done = await layout.load()
    expect(done).toMatchObject({
      outcome: 'accepted',
      value: { revision: 0, document: undefined },
    })
    expect(statuses.at(-1)).toEqual({ kind: 'account', revision: 0 })
  })

  test('a 404 that is not workbench_not_found is refused, not an empty record', async () => {
    const { layout, server, statuses } = await setup()
    server.workbench.get = async () => {
      throw new HttpError(404, { code: 'route_missing' })
    }
    const done = await layout.load()
    expect(done).toMatchObject({ outcome: 'refused', code: 'route_missing' })
    expect(statuses.at(-1)).toMatchObject({
      kind: 'failed',
      operation: 'restore',
      recovery: 'restore',
      diagnostic: { httpStatus: 404, problemCode: 'route_missing' },
    })
  })

  test.each([401, 403])(
    'HTTP %i refuses restore without displaying a checkpoint',
    async (status) => {
      const { layout, server, statuses } = await setup({
        revision: 4,
        document: DOC,
      })
      await layout.load()
      server.workbench.get = async () => {
        throw new HttpError(status)
      }
      expect((await layout.load()).outcome).toBe('refused')
      expect(statuses.at(-1)).toMatchObject({
        kind: 'failed',
        operation: 'restore',
        diagnostic: { httpStatus: status },
      })
    },
  )

  test('an unreachable server is a failed read', async () => {
    const { layout, server } = await setup()
    server.workbench.get = async () => {
      throw new HttpError(undefined)
    }
    expect((await layout.load()).outcome).toBe('failed')
  })
})

describe('save', () => {
  test('sends the base revision as If-Match and in the body, once, and returns the new revision', async () => {
    const { layout, server } = await setup({ revision: 2, document: DOC })
    const next = { current: { dock: 'moved' }, namedLayouts: {} }
    const done = await layout.save(next, {
      baseRevision: 2,
      requestId: 'req-1',
    })
    expect(done).toMatchObject({
      outcome: 'accepted',
      requestId: 'req-1',
      value: { revision: 3, document: next },
    })
    const sent = server.saves[0]!
    expect(sent.request['If-Match']).toBe('2')
    expect(sent.request['Idempotency-Key']).toBe('req-1')
    expect(sent.request['X-CSRF-Token']).toBe('token')
    expect(sent.request.body).toEqual({
      workspaceId: 'w1',
      revision: 2,
      schema: WORKBENCH_SCHEMA,
      ...next,
    })
    expect(sent.options).toEqual({ maxRetries: 0 })
  })

  test('the first save is made against revision 0', async () => {
    const { layout, server } = await setup()
    const done = await layout.save(DOC, { baseRevision: 0 })
    expect(done).toMatchObject({ outcome: 'accepted', value: { revision: 1 } })
    expect(server.held()?.document).toEqual(DOC)
  })

  test('a stale save is refused as a conflict and the record is untouched (R38)', async () => {
    const { layout, server } = await setup({ revision: 5, document: DOC })
    const done = await layout.save(
      { current: 'mine', namedLayouts: {} },
      { baseRevision: 4 },
    )
    expect(done).toMatchObject({
      outcome: 'refused',
      code: 'conflict',
      reason: 'The workspace layout changed; reload before saving',
    })
    expect(server.held()).toEqual({ revision: 5, document: DOC })
  })

  test('an uncertain save offers an account check without another write', async () => {
    const { layout, server, statuses } = await setup({
      revision: 1,
      document: DOC,
    })
    server.workbench.save = async (request) => {
      server.saves.push({ request, options: undefined })
      throw new HttpError(503)
    }
    const done = await layout.save(DOC, { baseRevision: 1 })
    expect(done.outcome).toBe('uncertain')
    expect(server.saves).toHaveLength(1)
    expect(statuses.at(-1)).toMatchObject({
      kind: 'failed',
      operation: 'save',
      recovery: 'check',
    })
  })

  test('a save with no revision to base it on is refused without being sent', async () => {
    const { layout, server } = await setup()
    const done = await layout.save(DOC, { baseRevision: -1 })
    expect(done).toMatchObject({ outcome: 'refused', code: 'invalid_revision' })
    expect(server.saves).toHaveLength(0)
  })

  test("a 4xx from the server is the server's decision: refused with its code", async () => {
    const { layout, server } = await setup()
    server.workbench.save = async () => {
      throw new HttpError(413, { code: 'workbench_payload_too_large' })
    }
    expect(await layout.save(DOC, { baseRevision: 0 })).toMatchObject({
      outcome: 'refused',
      code: 'workbench_payload_too_large',
    })
  })
})

describe('checkpoint', () => {
  test('writes and reads the device copy by workspace, apart from the record', async () => {
    const { layout, server, database } = await setup()
    const written = await layout.writeCheckpoint({
      baseRevision: 7,
      document: DOC,
    })
    expect(written).toEqual({ outcome: 'accepted', value: { savedAtMs: 1234 } })
    expect(database.nodes.has('theorem-workbench:checkpoint:w1')).toBe(true)
    expect(server.saves).toHaveLength(0)
    expect(await layout.readCheckpoint()).toEqual({
      outcome: 'accepted',
      value: { baseRevision: 7, document: DOC, savedAtMs: 1234 },
    })
  })

  test('nothing kept reads as accepted with no checkpoint; clear removes it', async () => {
    const { layout } = await setup()
    expect(await layout.readCheckpoint()).toEqual({
      outcome: 'accepted',
      value: undefined,
    })
    await layout.writeCheckpoint({ baseRevision: 0, document: DOC })
    await layout.clearCheckpoint()
    expect(await layout.readCheckpoint()).toEqual({
      outcome: 'accepted',
      value: undefined,
    })
  })

  test('a quota refusal is refused, never accepted as saved', async () => {
    const { layout, database } = await setup()
    database.fail = new Error('QuotaExceededError: quota exceeded')
    expect(
      await layout.writeCheckpoint({ baseRevision: 0, document: DOC }),
    ).toMatchObject({ outcome: 'refused', code: 'storage_quota_exceeded' })
  })

  test('a commit whose state is unknown is uncertain', async () => {
    const { layout, database } = await setup()
    database.fail = new Error('chunk_store_browser_commit_state_unknown')
    expect(
      (await layout.writeCheckpoint({ baseRevision: 0, document: DOC }))
        .outcome,
    ).toBe('uncertain')
  })

  test('an unavailable store is refused; a database that will not open is retried next call', async () => {
    let attempts = 0
    const checkpoints = createCheckpoints({
      directory: 'd',
      open: async () => {
        attempts += 1
        if (attempts === 1) throw new Error('chunk_store_browser_storage')
        return memoryDatabase()
      },
    })
    expect(await checkpoints.read('w1')).toMatchObject({
      outcome: 'refused',
      code: 'storage_unavailable',
    })
    expect((await checkpoints.read('w1')).outcome).toBe('accepted')
    expect(attempts).toBe(2)
  })

  test('dispose closes the database it opened', async () => {
    const { layout, checkpoints, database } = await setup()
    await layout.readCheckpoint()
    await checkpoints.dispose()
    expect(database.closed).toBe(1)
  })
})

// Compile-time: the client type the owner asks for is what the SDK client is.
const sdkClientIsLayoutClient = (client: TheoremClient) =>
  client satisfies LayoutClient
void sdkClientIsLayoutClient
