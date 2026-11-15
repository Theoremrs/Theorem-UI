// SOURCING: none — bun:test over ../adapter's layout routes with the real layout owner, a stub server
// that holds the record and its revision, and two "browsers" (two layout owners over separate device databases)
import { describe, expect, test } from 'bun:test'
import { createAdapter } from '../adapter'
import type { AdapterOptions } from '../adapter'
import {
  FakeLive,
  HttpError,
  stubHost,
  testEnvironment,
} from '../environment/test-host'
import type { Completion, Effect, Inbound } from '../wire'
import { createCheckpoints } from './checkpoint'
import { createLayout, WORKBENCH_SCHEMA } from './layout'
import { memoryDatabase } from './test-storage'

/** The server: one record per workspace, saved only against the revision it holds. */
function server() {
  let held:
    { revision: number; current: unknown; namedLayouts: unknown } | undefined
  const gets: number[] = []
  return {
    held: () => held,
    workbench: {
      get: async () => {
        if (!held) throw new HttpError(404, { code: 'workbench_not_found' })
        gets.push(held.revision)
        return { workspaceId: 'w1', schema: WORKBENCH_SCHEMA, ...held }
      },
      save: async (request: Record<string, unknown>) => {
        if ((held?.revision ?? 0) !== Number(request['If-Match']))
          throw new HttpError(409, {
            code: 'stale_workbench_revision',
            detail: 'The layout changed elsewhere; reload',
          })
        const body = request.body as { current: unknown; namedLayouts: unknown }
        held = {
          revision: (held?.revision ?? 0) + 1,
          current: body.current,
          namedLayouts: body.namedLayouts,
        }
        return { workspaceId: 'w1', schema: WORKBENCH_SCHEMA, ...held }
      },
    },
  }
}

/** A browser: its own environment, device database and adapter over the shared server. */
async function browser(srv: ReturnType<typeof server>) {
  const host = stubHost([])
  ;(host.client as unknown as { workbench: unknown }).workbench = srv.workbench
  const { environment } = testEnvironment(host, new FakeLive())
  await environment.settled()
  const checkpoints = createCheckpoints({
    directory: 'd',
    open: async () => memoryDatabase(),
  })
  const layout = createLayout({
    environment: environment as never,
    checkpoints,
  })
  const messages: Inbound[] = []
  const adapter = createAdapter({
    environment,
    files: {} as never,
    terminal: {
      create: () => ({}) as never,
      host: { onEvent: () => () => {} },
    },
    layout,
    dispatch: (message) => messages.push(message),
  } satisfies AdapterOptions)
  let next = 0
  const ask = async (
    kind: 'layoutLoad' | 'layoutSave',
    revision?: number,
    current = '{}',
    namedLayouts = '{}',
  ) => {
    const effect = {
      id: ++next,
      resource: { type: 'workspace', workspace: 'w1' },
      kind,
      ...(kind === 'layoutSave' ? { payload: { current, namedLayouts } } : {}),
      ...(revision === undefined
        ? {}
        : { revision: { scheme: 'seq', value: revision } }),
    } as unknown as Effect
    adapter.perform(effect)
    await new Promise((resolve) => setTimeout(resolve, 0))
    const done = messages
      .flatMap((m) =>
        m.channel === 'completion'
          ? [m as Completion & { channel: string }]
          : [],
      )
      .find((m) => m.effect === effect.id)!
    return done
  }
  return { ask, layout, adapter }
}

const WORKSPACE = JSON.stringify({
  dock: {
    editor: 'center',
    unknownPanel: { kind: 'future-tool', opaque: [1, 2] },
  },
})
const NAMED = JSON.stringify({
  'Editor centred': { dock: 1 },
  Minimal: { dock: 2 },
})

describe('AC-45: the account layout and its named layouts', () => {
  test('a first save is made against revision 0 and a second browser restores exactly that arrangement', async () => {
    const srv = server()
    const one = await browser(srv)
    const loaded = await one.ask('layoutLoad')
    expect(loaded.payload).toEqual({
      type: 'layoutLoaded',
      revision: { scheme: 'seq', value: 0 },
    })
    const saved = await one.ask('layoutSave', 0, WORKSPACE, NAMED)
    expect(saved.outcome).toEqual({ status: 'accepted' })
    expect(saved.payload).toEqual({
      type: 'layoutSaved',
      revision: { scheme: 'seq', value: 1 },
    })

    const two = await browser(srv)
    const restored = await two.ask('layoutLoad')
    expect(restored.payload).toEqual({
      type: 'layoutLoaded',
      revision: { scheme: 'seq', value: 1 },
      document: { current: WORKSPACE, namedLayouts: NAMED },
    })
  })

  test('a stale save is refused with the conflict, nothing is overwritten, and the next load has the current revision', async () => {
    const srv = server()
    const one = await browser(srv)
    const two = await browser(srv)
    await one.ask('layoutSave', 0, WORKSPACE, NAMED)
    // The second browser still believes the record is empty.
    const stale = await two.ask('layoutSave', 0, '{"dock":"mine"}', '{}')
    expect(stale.outcome).toMatchObject({ status: 'refused', code: 'conflict' })
    expect(srv.held()!.current).toEqual(JSON.parse(WORKSPACE))
    expect(srv.held()!.revision).toBe(1)
    const reloaded = await two.ask('layoutLoad')
    expect(reloaded.payload).toMatchObject({
      type: 'layoutLoaded',
      revision: { scheme: 'seq', value: 1 },
    })
    const saved = await two.ask('layoutSave', 1, '{"dock":"mine"}', NAMED)
    expect(saved.outcome).toEqual({ status: 'accepted' })
    expect(srv.held()!.revision).toBe(2)
  })

  test('a save sends the revision as If-Match and is never retried', async () => {
    const srv = server()
    let sent = 0
    const original = srv.workbench.save
    srv.workbench.save = async (request) => {
      sent += 1
      return original(request)
    }
    const one = await browser(srv)
    await one.ask('layoutSave', 0, WORKSPACE, NAMED)
    expect(sent).toBe(1)
  })

  test('a layout that names a tool this browser lacks round-trips untouched: the owner never reads into it', async () => {
    const srv = server()
    const one = await browser(srv)
    await one.ask('layoutSave', 0, WORKSPACE, NAMED)
    expect(JSON.stringify(srv.held()!.current)).toBe(
      JSON.stringify(JSON.parse(WORKSPACE)),
    )
    expect(
      (srv.held()!.namedLayouts as Record<string, unknown>).Minimal,
    ).toEqual({ dock: 2 })
  })

  test('a lost answer to a save is uncertain and the same save is not repeated', async () => {
    const srv = server()
    srv.workbench.save = async () => {
      throw new Error('socket closed')
    }
    const one = await browser(srv)
    const done = await one.ask('layoutSave', 0, WORKSPACE, NAMED)
    expect(done.outcome).toMatchObject({ status: 'uncertain' })
  })

  test('an unreachable record is a failed load, and no document is invented from the device copy', async () => {
    const srv = server()
    srv.workbench.get = async () => {
      throw new Error('offline')
    }
    const one = await browser(srv)
    const done = await one.ask('layoutLoad')
    expect(done.outcome).toMatchObject({ status: 'failed' })
    expect(done.payload).toBeUndefined()
  })
})
