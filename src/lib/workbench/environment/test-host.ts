// SOURCING: none — a test double with the method shapes of the SDK's client and WorkspaceLive;
// no network, so tests run against the environment and files modules alone.

import { createEnvironment } from './environment'
import type { HostClient, LiveLike } from './environment'

export class HttpError extends Error {
  constructor(
    readonly statusCode?: number,
    readonly body?: unknown,
  ) {
    super(`HTTP ${statusCode ?? 'none'}`)
  }
}

export const op = (
  operation: string,
  state: Partial<{
    implemented: boolean
    ready: boolean
    granted: boolean
    reason: string
  }> = {},
) => ({ operation, implemented: true, ready: true, granted: true, ...state })

type Handler = (request: never, options?: never) => unknown

export interface StubHost {
  client: HostClient
  calls: {
    name: string
    request: Record<string, unknown>
    options?: Record<string, unknown>
  }[]
  /** Replace what a method answers; a thrown value is what the host's failure looks like. */
  on: (name: string, handler: Handler) => void
  count: (name: string) => number
}

/** The files and workspace methods of the SDK client, answering from `handlers`. */
export function stubHost(
  operations: ReturnType<typeof op>[],
  extra: { copy?: boolean } = {},
): StubHost {
  const handlers = new Map<string, Handler>()
  const calls: StubHost['calls'] = []
  const method =
    (name: string, fallback: unknown = {}) =>
    async (
      request: Record<string, unknown>,
      options?: Record<string, unknown>,
    ) => {
      calls.push({ name, request, options })
      const handler = handlers.get(name)
      return handler ? handler(request as never, options as never) : fallback
    }
  const workspace: Record<string, unknown> = {
    filesList: method('filesList', { entries: [] }),
    filesStat: method('filesStat'),
    filesRead: method('filesRead', { encoding: 'utf8', contents: '' }),
    filesCreate: method('filesCreate'),
    filesDelete: method('filesDelete'),
    filesRename: method('filesRename'),
  }
  if (extra.copy) workspace.filesCopy = method('filesCopy')
  const client = {
    remoteWorkspaces: {
      open: method('open', { workspace_id: 'w1', active: true, durable: true }),
      capabilities: method('capabilities', {
        schema: 'theorem-workspace-capabilities/1',
        workspace_id: 'w1',
        version: '1.2.3',
        epoch: 'e1',
        cursor: '0',
        granted_by: 'test-host',
        operations,
      }),
    },
    documentSessions: { open: method('seat') },
    ide: { workspace },
  } as unknown as HostClient
  return {
    client,
    calls,
    on: (name, handler) => void handlers.set(name, handler),
    count: (name) => calls.filter((call) => call.name === name).length,
  }
}

type LiveState = 'connecting' | 'open' | 'reconnecting' | 'resyncing' | 'closed'

export class FakeLive {
  started = 0
  closed = 0
  private events = new Map<string, Set<(event: unknown) => void>>()
  private states = new Set<(state: LiveState) => void>()
  private resyncs = new Set<(resync: unknown) => void>()

  on(kind: string, listener: (event: never) => void) {
    const set = this.events.get(kind) ?? new Set()
    this.events.set(kind, set)
    set.add(listener as (event: unknown) => void)
    return () => set.delete(listener as (event: unknown) => void)
  }
  onState(listener: (state: LiveState) => void) {
    this.states.add(listener)
    return () => this.states.delete(listener)
  }
  onResync(listener: (resync: never) => void) {
    this.resyncs.add(listener as (resync: unknown) => void)
    return () => this.resyncs.delete(listener as (resync: unknown) => void)
  }
  async start() {
    this.started += 1
  }
  close() {
    this.closed += 1
  }
  listenerCount(kind: string) {
    return this.events.get(kind)?.size ?? 0
  }
  emit(kind: string, data: unknown) {
    for (const listener of [...(this.events.get(kind) ?? [])])
      listener({ cursor: '1', kind, data })
  }
  state(state: LiveState) {
    for (const listener of [...this.states]) listener(state)
  }
  resync(reason: string) {
    for (const listener of [...this.resyncs])
      listener({ reason, epoch: 'e', cursor: '0' })
  }
}

/** An environment over a stub host and a fake live stream, retrying quickly. */
export function testEnvironment(
  host: StubHost,
  live = new FakeLive(),
  overrides: Partial<Parameters<typeof createEnvironment>[0]> = {},
) {
  const clients: Parameters<
    Parameters<typeof createEnvironment>[0]['createClient']
  >[0][] = []
  const environment = createEnvironment({
    workspaceId: 'w1',
    bootstrap: async () => ({ csrfToken: 'token' }),
    createClient: (fetch) => {
      clients.push(fetch)
      return host.client
    },
    createLive: () => live as unknown as LiveLike,
    retryDelays: [5],
    ...overrides,
  })
  return { environment, live, fetches: clients }
}
