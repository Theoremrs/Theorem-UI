// SOURCING: @theoremharness/sdk — TheoremClient carries every request (remoteWorkspaces.open and
// .capabilities, documentSessions.open) and WorkspaceLive is the live stream; recovery,
// open-until-ready and error wording come from ./workspace-recovery, copied verbatim from the Theia
// extension's TheoremConnection helpers. This file is the plain-TypeScript counterpart of
// TheoremConnection (no Theia, no React): it holds one open workspace, its advertised operations
// and one shared live stream, and never talks to an endpoint by hand.

import type {
  Theorem,
  TheoremClient,
  WorkspaceLiveEvent,
  WorkspaceLiveKind,
  WorkspaceLiveState,
  WorkspaceResync,
} from '@theoremharness/sdk'
import { availabilityOf } from './result'
import type { Availability, UnavailableCause } from './result'
import { openUntilReady, recoveringSend } from './workspace-recovery'
import type { Send } from './workspace-recovery'

/** The calls the workbench makes of a Theorem client; `TheoremClient` satisfies it, and a test stub can. */
export interface HostClient {
  remoteWorkspaces: Pick<
    TheoremClient['remoteWorkspaces'],
    'open' | 'capabilities'
  >
  documentSessions: Pick<
    TheoremClient['documentSessions'],
    'open' | 'edit' | 'save' | 'close' | 'head' | 'reconcile'
  >
  ide: {
    scm: Pick<
      TheoremClient['ide']['scm'],
      | 'status'
      | 'diff'
      | 'show'
      | 'branches'
      | 'stage'
      | 'unstage'
      | 'discard'
      | 'restore'
      | 'commit'
      | 'branch'
      | 'merge'
      | 'fetch'
      | 'push'
      | 'log'
      | 'blame'
      | 'conflict'
      | 'resolve'
    >
    workspace: Pick<
      TheoremClient['ide']['workspace'],
      | 'filesList'
      | 'filesStat'
      | 'filesRead'
      | 'filesCreate'
      | 'filesDelete'
      | 'filesRename'
    > & {
      /** Not in SDK 0.6.0-alpha.5. Used only when the generated client gains it (see the report's SDK gaps). */
      filesCopy?: (
        request: OperationHeaders & { body: Record<string, unknown> },
        options?: { maxRetries?: number },
      ) => PromiseLike<unknown>
    }
  }
}

/** What `WorkspaceLive` offers that the environment uses. */
export interface LiveLike {
  on: <TKind extends WorkspaceLiveKind>(
    kind: TKind,
    listener: (event: WorkspaceLiveEvent<TKind>) => void | Promise<void>,
  ) => () => void
  onState: (listener: (state: WorkspaceLiveState) => void) => () => void
  onResync: (
    listener: (resync: WorkspaceResync) => void | Promise<void>,
  ) => () => void
  start: () => Promise<void>
  close: () => void
}

/** Headers every workspace operation carries. The idempotency key is the request id. */
export interface OperationHeaders {
  workspaceId: string
  'X-CSRF-Token': string
  'Idempotency-Key': string
}

export type OperationState =
  | { state: 'available' }
  | { state: 'unavailable'; reason: string }
  /** The host did not list it: an older host, or capabilities could not be read. */
  | { state: 'unlisted' }

export type EnvironmentEvent =
  | { type: 'availability'; availability: Availability }
  | { type: 'capabilities' }
  /** The host had lost the workspace and it was opened again; documents re-seat from here. */
  | { type: 'reopened' }
  | { type: 'live'; state: WorkspaceLiveState }

/** The live stream came back after a gap: re-read whatever the listener shows. */
export interface Reconnected {
  reason: 'reconnected' | WorkspaceResync['reason']
}

/** One holder's share of the workspace's live stream. */
export interface LiveLease {
  readonly state: WorkspaceLiveState
  on: <TKind extends WorkspaceLiveKind>(
    kind: TKind,
    listener: (event: WorkspaceLiveEvent<TKind>) => void,
  ) => void
  onReconnected: (listener: (event: Reconnected) => void) => void
  /** Drops this holder's listeners; the stream closes when the last holder releases. */
  release: () => void
}

export interface Environment<TClient extends HostClient = HostClient> {
  readonly workspaceId: string
  readonly client: TClient
  /** Who is answering: the workspace, and the host's grant and version once capabilities are read. */
  readonly identity: {
    workspaceId: string
    label: string
    version?: string
    epoch?: string
  }
  readonly availability: Availability
  readonly liveState: WorkspaceLiveState
  /** Resolves once the first attempt to open the workspace has either worked or failed. */
  settled: () => Promise<Availability>
  operation: (name: string) => OperationState
  /** Every operation the host listed, as it stands now; empty until capabilities are read or when they could not be. Read again after a `capabilities` event. */
  operations: () => readonly { name: string; state: OperationState }[]
  /** The host backends its capabilities report ready (`herdr`); empty when it reports none, as older hosts do. */
  backends: () => readonly string[]
  has: (name: string) => boolean
  /** The environment's availability for one operation: unavailable when the host is, or when it lists the operation as not usable (or, if `advertised`, does not list it). */
  availabilityFor: (name: string, advertised?: boolean) => Availability
  headers: (requestId: string) => OperationHeaders
  subscribe: (listener: (event: EnvironmentEvent) => void) => () => void
  /** One live stream per workspace, shared and reference-counted. */
  acquireLive: () => LiveLease
  /** Try again now: the open attempt that is waiting, or a fresh open. */
  retry: () => void
  reopen: () => Promise<void>
  seat: (resourceId: string) => Promise<unknown>
  dispose: () => void
}

export interface EnvironmentOptions<TClient extends HostClient> {
  workspaceId: string
  /** The signed-in session's bootstrap; `force` asks for a fresh CSRF token. */
  bootstrap: (force?: boolean) => Promise<{ csrfToken: string }>
  /** Builds a client over the given fetch. Called twice: plain, and with workspace recovery. */
  createClient: (fetch: typeof globalThis.fetch) => TClient
  createLive: (client: TClient) => LiveLike
  fetch?: Send
  retryDelays?: number[]
}

export function createEnvironment<TClient extends HostClient>(
  options: EnvironmentOptions<TClient>,
): Environment<TClient> {
  const { workspaceId } = options
  const send: Send = options.fetch ?? ((input, init) => fetch(input, init))
  const listeners = new Set<(event: EnvironmentEvent) => void>()
  let csrf = ''
  let capabilities: Theorem.WorkspaceCapabilities | undefined
  let availability: Availability = {
    status: 'unavailable',
    cause: 'opening',
    reason: 'Opening the workspace',
  }
  let lastError: unknown
  let reopening: Promise<void> | undefined
  let disposed = false
  let liveState: WorkspaceLiveState = 'closed'
  let live: { channel: LiveLike; refs: number; stop: () => void } | undefined
  const reconnected = new Set<(event: Reconnected) => void>()

  function emit(event: EnvironmentEvent) {
    if (disposed) return
    for (const listener of [...listeners]) {
      try {
        listener(event)
      } catch (error) {
        console.warn('An environment listener failed', error)
      }
    }
  }

  function setAvailability(next: Availability) {
    const same =
      next.status === availability.status &&
      (next.status === 'available' ||
        (availability.status === 'unavailable' &&
          next.cause === availability.cause &&
          next.reason === availability.reason))
    availability = next
    if (!same) emit({ type: 'availability', availability })
  }

  /** A reopen's CSRF token replaces the one a long-lived request captured. */
  function withCurrentToken(init: RequestInit | undefined) {
    if (!init?.headers || !csrf) return init
    const headers = new Headers(init.headers)
    if (headers.has('X-CSRF-Token')) headers.set('X-CSRF-Token', csrf)
    return { ...init, headers }
  }
  const tokenSend: Send = (input, init) => send(input, withCurrentToken(init))
  const direct = options.createClient(tokenSend as typeof fetch)
  const client = options.createClient(
    recoveringSend(tokenSend, { reopen, seat }) as typeof fetch,
  )

  /** Bootstrap, then ask the host to open the workspace: idempotent, so also how it is reopened. */
  async function attach(fresh: boolean) {
    csrf = (await options.bootstrap(fresh)).csrfToken
    await direct.remoteWorkspaces.open({
      'X-CSRF-Token': csrf,
      'Idempotency-Key': crypto.randomUUID(),
      workspace_id: workspaceId,
    })
  }

  /** Not fatal: an older host may not answer, and then no operation is listed. */
  async function readCapabilities() {
    try {
      capabilities = await direct.remoteWorkspaces.capabilities({ workspaceId })
    } catch {
      capabilities = undefined
    }
    emit({ type: 'capabilities' })
  }

  let settle: (value: Availability) => void
  const firstAttempt = new Promise<Availability>(
    (resolve) => (settle = resolve),
  )
  const opening = openUntilReady(
    async () => {
      if (disposed) return
      try {
        await attach(false)
        await readCapabilities()
      } catch (error) {
        lastError = error
        throw error
      }
    },
    (state) => {
      if (disposed) return
      if (state.state === 'open') {
        setAvailability({ status: 'available' })
        settle(availability)
      } else if (state.state === 'failed') {
        setAvailability(availabilityOf(lastError))
        settle(availability)
      }
    },
    options.retryDelays,
  )

  /** One reopening for every request that found the workspace closed. */
  function reopen(): Promise<void> {
    return (reopening ??= attach(true)
      .then(readCapabilities)
      .then(() => {
        setAvailability({ status: 'available' })
        emit({ type: 'reopened' })
      })
      .catch((error: unknown) => {
        setAvailability(availabilityOf(error))
        throw error
      })
      .finally(() => {
        reopening = undefined
      }))
  }

  function seat(resourceId: string) {
    return direct.documentSessions.open({
      workspaceId,
      'X-CSRF-Token': csrf,
      'Idempotency-Key': crypto.randomUUID(),
      resource_id: resourceId,
    })
  }

  function operation(name: string): OperationState {
    const entry = capabilities?.operations.find(
      (item) => item.operation === name,
    )
    if (!entry) return { state: 'unlisted' }
    const unusable = (fallback: string): OperationState => ({
      state: 'unavailable',
      reason: entry.reason || fallback,
    })
    if (!entry.implemented) return unusable('This host does not implement it')
    if (!entry.granted) return unusable('It is not granted to this account')
    if (!entry.ready) return unusable('It is not ready yet')
    return { state: 'available' }
  }

  function startLive() {
    const channel = options.createLive(client)
    let everOpen = false
    let gap: Reconnected['reason'] | undefined
    let stopped = false
    liveState = 'connecting'
    const undo = [
      channel.onState((state) => {
        liveState = state
        if (state === 'open') {
          if (everOpen && gap) {
            const event: Reconnected = { reason: gap }
            void readCapabilities()
            for (const listener of [...reconnected]) {
              try {
                listener(event)
              } catch (error) {
                console.warn('A live listener failed to re-read', error)
              }
            }
          }
          everOpen = true
          gap = undefined
        } else if (
          everOpen &&
          (state === 'reconnecting' || state === 'resyncing')
        ) {
          gap ??= 'reconnected'
        }
        emit({ type: 'live', state })
      }),
      // The reason is kept for the next time the stream is open again.
      channel.onResync((resync) => {
        gap = resync.reason
      }),
      channel.on('workspace.capabilities', () => void readCapabilities()),
    ]
    void opening.ready.then(() => {
      if (!stopped && !disposed)
        channel
          .start()
          .catch((error) => console.warn('The live stream ended', error))
    })
    live = {
      channel,
      refs: 0,
      stop() {
        stopped = true
        undo.forEach((off) => off())
        channel.close()
        liveState = 'closed'
      },
    }
  }

  function acquireLive(): LiveLease {
    if (!live) startLive()
    const held = live!
    held.refs += 1
    const undo: (() => void)[] = []
    let released = false
    return {
      get state() {
        return liveState
      },
      on(kind, listener) {
        undo.push(held.channel.on(kind, listener))
      },
      onReconnected(listener) {
        reconnected.add(listener)
        undo.push(() => reconnected.delete(listener))
      },
      release() {
        if (released) return
        released = true
        undo.forEach((off) => off())
        held.refs -= 1
        if (held.refs === 0 && live === held) {
          live = undefined
          held.stop()
        }
      },
    }
  }

  return {
    workspaceId,
    client,
    get identity() {
      return {
        workspaceId,
        label: capabilities
          ? `${capabilities.granted_by} ${capabilities.version}`
          : workspaceId,
        version: capabilities?.version,
        epoch: capabilities?.epoch,
      }
    },
    get availability() {
      return availability
    },
    get liveState() {
      return liveState
    },
    settled: () => firstAttempt,
    operation,
    operations: () =>
      (capabilities?.operations ?? []).map(({ operation: name }) => ({
        name,
        state: operation(name),
      })),
    backends: () => {
      const reported = (
        capabilities as
          { backends?: Record<string, { ready?: unknown }> } | undefined
      )?.backends
      return Object.entries(reported ?? {})
        .filter(([, backend]) => backend.ready === true)
        .map(([name]) => name)
    },
    has: (name) => operation(name).state === 'available',
    availabilityFor(name, advertised = false) {
      if (availability.status === 'unavailable') return availability
      const state = operation(name)
      if (state.state === 'available') return availability
      if (state.state === 'unavailable' || advertised) {
        const cause: UnavailableCause = 'missing_capability'
        return {
          status: 'unavailable',
          cause,
          reason:
            state.state === 'unavailable'
              ? `${name}: ${state.reason}`
              : `${name}: this host does not advertise it`,
        }
      }
      return availability
    },
    headers: (requestId) => ({
      workspaceId,
      'X-CSRF-Token': csrf,
      'Idempotency-Key': requestId,
    }),
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    acquireLive,
    retry() {
      if (availability.status === 'available')
        void reopen().catch(() => undefined)
      else opening.retryNow()
    },
    reopen,
    seat,
    dispose() {
      disposed = true
      live?.stop()
      live = undefined
      listeners.clear()
      reconnected.clear()
    },
  }
}
