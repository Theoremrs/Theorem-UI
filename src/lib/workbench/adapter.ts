// SOURCING: none — the effect dispatcher (ARCHITECTURE.md sections 4 and 5): one exhaustive switch
// that sends each wire effect kind to the owner module that holds it and turns the owner's answer
// back into a wire Completion, plus the host events as wire HostMessages. It calls no endpoint. The
// owners are ./environment, ./files, ./terminal and ./layout, and the optional ports below for owners
// that do not exist yet. Outcome shapes and error wording come from ./environment; the one helper
// written here is the base64 of terminal bytes, because the existing `toBase64` sits in the Loro-bound
// src/lib/blocks/state.ts and importing it would load the Loro wasm into the workbench.

import { normalizePath } from './files/files'
import type { Files } from './files/files'
import type { Environment } from './environment/environment'
import { reason as readableReason } from './environment/workspace-recovery'
import type { TerminalHost, TerminalSession, TerminalEvent } from './terminal'
import type { Layout } from './layout'
import type {
  Capability,
  Completion,
  CompletionPayload,
  Effect,
  HostMessage,
  ResourceRef,
  Revision,
  TerminalBackend,
} from './wire'

/** Effects whose kind starts with `prefix`: the slice of the wire one owner serves. */
type Of<TPrefix extends string> = Extract<
  Effect,
  { kind: `${TPrefix}${string}` }
>

/** What an owner answers with: the wire outcome, and for `accepted` the data and, if it moved, the revision. */
export type OwnerReply =
  | {
      outcome: 'accepted'
      value?: CompletionPayload
      /** Set when the effect moved the resource's version; otherwise the effect's own is echoed. */
      revision?: Revision
    }
  | { outcome: 'refused'; code: string; reason: string }
  | { outcome: 'uncertain'; reason: string }
  | { outcome: 'failed'; reason: string }

/**
 * An owner that does not exist yet, as the adapter needs it: one method that performs an effect of
 * its kinds. `requestId` is stable per effect (a retry of the same effect reuses it), so an owner
 * that deduplicates can recognise it. `subscribe` is for owners that push host events.
 */
export interface OwnerPort<TEffect extends Effect> {
  perform: (effect: TEffect, requestId: string) => Promise<OwnerReply>
  subscribe?: (listener: (message: HostMessage) => void) => () => void
}

export type DocumentsPort = OwnerPort<Of<'document'>>
export type ScmPort = OwnerPort<Of<'scm'>>
export type LanguagePort = OwnerPort<Of<'language'>>
export type RunPort = OwnerPort<Of<'run'>>
export type SearchPort = OwnerPort<Of<'search'>>
export type ConversationPort = OwnerPort<Of<'conversation'>>
export type ArtifactsPort = OwnerPort<Of<'artifact'>>
export type ClipboardPort = OwnerPort<Of<'clipboard'>>

/** The files owner as the adapter calls it. `Files` satisfies it. */
export type FilesPort = Pick<
  Files,
  'list' | 'create' | 'rename' | 'delete' | 'watch'
>

/** One terminal binding as the adapter drives it. `TerminalSession` satisfies it. */
export type TerminalPort = Pick<
  TerminalSession,
  | 'open'
  | 'attach'
  | 'input'
  | 'resize'
  | 'detach'
  | 'kill'
  | 'subscribe'
  | 'state'
>

export interface TerminalOwner {
  /** A fresh binding; the adapter keeps one per terminal id. */
  create: () => TerminalPort
  /** Where the host announces terminals (`terminal.opened`). */
  host: Pick<TerminalHost, 'onEvent'>
}

/** What the adapter reads of the environment. `Environment` satisfies it. */
export type EnvironmentPort = Pick<
  Environment,
  | 'workspaceId'
  | 'availability'
  | 'availabilityFor'
  | 'liveState'
  | 'settled'
  | 'subscribe'
  | 'acquireLive'
>

export interface AdapterOptions {
  environment: EnvironmentPort
  files: FilesPort
  terminal: TerminalOwner
  layout: Pick<Layout, 'load' | 'save'>
  /** Owners that do not exist yet. Absent: their effects complete as refused `owner_unavailable`. */
  documents?: DocumentsPort
  scm?: ScmPort
  language?: LanguagePort
  run?: RunPort
  search?: SearchPort
  conversation?: ConversationPort
  artifacts?: ArtifactsPort
  clipboard?: ClipboardPort
  /** The workbench handle's `dispatch`: it takes completions and host messages alike. */
  dispatch: (message: Completion | HostMessage) => void
}

export interface Adapter {
  /** Starts the effect and returns at once. Exactly one completion follows through `dispatch`. */
  perform: (effect: Effect) => void
  /** Stops every subscription. Results that arrive later are dropped. */
  dispose: () => void
}

const unavailable = (owner: string, why?: string): OwnerReply => ({
  outcome: 'refused',
  code: 'owner_unavailable',
  reason: why ?? `The ${owner} owner is not connected`,
})

/** Any owner module's outcome (this repo's modules share the discriminants) as an OwnerReply. */
type Answered<T> =
  | { outcome: 'accepted'; value: T }
  | { outcome: 'refused'; code: string; reason: string }
  | { outcome: 'uncertain'; reason: string }
  | { outcome: 'failed'; reason: string }

function reply<T>(
  answer: Answered<T>,
  accepted: (
    value: T,
  ) => Partial<Extract<OwnerReply, { outcome: 'accepted' }>> = () => ({}),
): OwnerReply {
  switch (answer.outcome) {
    case 'accepted':
      return { outcome: 'accepted', ...accepted(answer.value) }
    case 'refused':
      return { outcome: 'refused', code: answer.code, reason: answer.reason }
    case 'uncertain':
      return { outcome: 'uncertain', reason: answer.reason }
    case 'failed':
      return { outcome: 'failed', reason: answer.reason }
  }
}

function base64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

const plainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export function createAdapter(options: AdapterOptions): Adapter {
  const { environment: env, files, layout, dispatch } = options
  const workspace = env.workspaceId
  /** Makes request ids unique across page loads: effect ids restart, and a host may remember a key. */
  const nonce = crypto.randomUUID()
  const stops: (() => void)[] = []
  let disposed = false

  function send(message: Completion | HostMessage) {
    if (disposed) return
    try {
      dispatch(message)
    } catch (error) {
      console.warn('The workbench rejected a message', error)
    }
  }

  // ---- terminals -------------------------------------------------------------------------

  interface Bound {
    port: TerminalPort
    stop: () => void
  }
  const terminals = new Map<string, Bound>()
  /** `session:epoch:program` of every binding already reported, so an announcement of one this client knows is not repeated. */
  const reported = new Set<string>()
  const bindingKey = (session: string, epoch?: number, program?: number) =>
    `${session}:${epoch}:${program}`

  const terminalRef = (session: string): ResourceRef => ({
    type: 'terminal',
    workspace,
    session,
  })

  function backendOf(port: TerminalPort): TerminalBackend {
    return port.state.profile?.backend ?? 'native'
  }

  /** Session events as host messages. The opener's own `opened` is answered by its completion instead. */
  function follow(port: TerminalPort): () => void {
    const resource = () =>
      port.state.terminalId ? terminalRef(port.state.terminalId) : undefined
    const epoch = () => port.state.bindingEpoch ?? 0
    return port.subscribe((event: TerminalEvent) => {
      const target = resource()
      if (!target) return
      switch (event.type) {
        case 'opened':
        case 'adopted': {
          const origin = event.type === 'adopted' ? 'adopted' : event.origin
          if (origin === 'launched') return
          reported.add(
            bindingKey(event.terminalId, event.bindingEpoch, event.program),
          )
          send({
            type: 'terminalOpened',
            resource: target,
            epoch: event.bindingEpoch ?? epoch(),
            program: event.program ?? 0,
            backend: backendOf(port),
            origin,
            cols: port.state.cols ?? 0,
            rows: port.state.rows ?? 0,
          })
          return
        }
        case 'output':
          send({
            type: 'terminalOutput',
            resource: target,
            epoch: event.epoch ?? epoch(),
            offset: event.offset,
            data: base64(event.bytes),
          })
          return
        case 'reset':
          // The wire has no message for "replay this screen"; the core re-reads the terminal.
          send({
            type: 'resync',
            workspace,
            reason: `terminal_reset:${target.type === 'terminal' ? target.session : ''}`,
          })
          return
        case 'lease':
          send({
            type: 'terminalControl',
            resource: target,
            epoch: epoch(),
            generation: event.lease.generation ?? 0,
            controlled: event.lease.held,
          })
          return
        case 'exited':
          send({
            type: 'terminalExited',
            resource: target,
            epoch: epoch(),
            ...(typeof event.code === 'number' ? { exitCode: event.code } : {}),
            reason: event.reason,
          })
          return
        case 'lost':
          send({
            type: 'terminalExited',
            resource: target,
            epoch: epoch(),
            reason: 'lost',
          })
          return
        case 'resized':
        case 'reconnected':
          return
      }
    })
  }

  stops.push(
    options.terminal.host.onEvent((event) => {
      if (event.kind !== 'terminal.opened') return
      const { session, epoch, program, origin, cols, rows, backend } =
        event.data
      const key = bindingKey(session, epoch, program)
      if (reported.has(key)) return
      reported.add(key)
      send({
        type: 'terminalOpened',
        resource: terminalRef(session),
        epoch: epoch ?? 0,
        program: program ?? 0,
        backend: backend === 'herdr' ? 'herdr' : 'native',
        origin: origin ?? 'unspecified',
        cols: cols ?? 0,
        rows: rows ?? 0,
      })
    }),
  )

  function opened(
    port: TerminalPort,
    fallback: { cols: number; rows: number },
  ) {
    const { state } = port
    const backend = backendOf(port)
    const payload: CompletionPayload = {
      type: 'terminal',
      session: state.terminalId ?? '',
      cols: state.cols ?? fallback.cols,
      rows: state.rows ?? fallback.rows,
      backend,
      epoch: state.bindingEpoch ?? 0,
      program: state.program ?? 0,
      processOwnedBy: backend === 'herdr' ? 'herdr-core' : 'host',
    }
    reported.add(bindingKey(payload.session, state.bindingEpoch, state.program))
    return { value: payload }
  }

  const terminalOf = (resource: ResourceRef): string | undefined =>
    resource.type === 'terminal' ? resource.session : undefined

  const noTerminal = (resource: ResourceRef): OwnerReply => ({
    outcome: 'refused',
    code:
      resource.type === 'terminal'
        ? 'terminal_session_not_found'
        : 'wrong_resource',
    reason:
      resource.type === 'terminal'
        ? `This workbench holds no binding for terminal ${resource.session}`
        : 'A terminal effect needs a terminal resource',
  })

  async function terminalEffect(
    effect: Of<'terminal'>,
    requestId: string,
  ): Promise<OwnerReply> {
    if (effect.kind === 'terminalOpen') {
      const { backend, argv, name, cols, rows } = effect.payload
      const port = options.terminal.create()
      const stop = follow(port)
      const done = await port.open({
        profile: {
          id: name ?? backend,
          backend,
          ...(argv ? { argv } : {}),
        },
        cols,
        rows,
        ...(name ? { name } : {}),
        idempotencyKey: requestId,
      })
      if (done.outcome === 'accepted' && !disposed) {
        terminals.set(done.value.terminalId, { port, stop })
      } else {
        stop()
      }
      return reply(done, () => opened(port, { cols, rows }))
    }

    const session = terminalOf(effect.resource)
    if (!session) return noTerminal(effect.resource)

    if (effect.kind === 'terminalAttach') {
      const known = terminals.get(session)
      const port = known?.port ?? options.terminal.create()
      const stop = known?.stop ?? follow(port)
      const done = await port.attach({
        terminalId: session,
        fromOffset: effect.payload.fromOffset,
        role: effect.payload.role,
      })
      if (done.outcome === 'accepted' && !disposed) {
        terminals.set(session, { port, stop })
      } else if (!known) {
        stop()
      }
      return reply(done, () =>
        opened(port, {
          cols: port.state.cols ?? 0,
          rows: port.state.rows ?? 0,
        }),
      )
    }

    const bound = terminals.get(session)
    if (!bound) return noTerminal(effect.resource)
    switch (effect.kind) {
      case 'terminalInput':
        // The session numbers its own input (its ledger of 256 is what makes a resend a no-op),
        // so the effect's `inputId` and `claim` are not used: the session holds the claim.
        return reply(
          await bound.port.input(effect.payload.bytes, effect.payload.kind),
        )
      case 'terminalResize':
        return reply(
          await bound.port.resize(effect.payload.cols, effect.payload.rows),
        )
      case 'terminalDetach': {
        const done = await bound.port.detach()
        if (done.outcome === 'accepted') {
          bound.stop()
          terminals.delete(session)
        }
        return reply(done)
      }
      case 'terminalEnd':
        return reply(await bound.port.kill())
    }
  }

  // ---- files -----------------------------------------------------------------------------

  const watched = new Map<string, () => void>()

  /** The directories the workbench has listed are the ones it watches. */
  function watch(directory: string) {
    const key = normalizePath(directory)
    if (watched.has(key) || disposed) return
    watched.set(
      key,
      files.watch(key, (event) => {
        if (event.kind === 'changed') {
          send({ type: 'fileChanged', workspace, path: event.path })
        } else if (event.reason === 'events_lost') {
          // The wire says a path of "." means events were lost. Other reasons are a reconnect,
          // which this adapter reports once, from its own lease.
          send({ type: 'fileChanged', workspace, path: '.' })
        }
      }),
    )
  }

  async function filesEffect(
    effect: Of<'files'>,
    requestId: string,
  ): Promise<OwnerReply> {
    switch (effect.kind) {
      case 'filesList': {
        watch(effect.payload.path)
        return reply(
          await files.list({ requestId, path: effect.payload.path }),
          ({ rows }) => ({
            value: {
              type: 'files',
              entries: rows.map(({ name, kind }) => ({ name, kind })),
              partial: false,
            },
          }),
        )
      }
      case 'filesCreate':
        return reply(
          await files.create({
            requestId,
            path: effect.payload.path,
            kind: effect.payload.directory ? 'directory' : 'file',
          }),
        )
      case 'filesRename':
        return reply(
          await files.rename({
            requestId,
            from: effect.payload.from,
            to: effect.payload.to,
          }),
        )
      case 'filesDelete':
        return reply(
          await files.delete({ requestId, path: effect.payload.path }),
        )
      case 'filesStat':
      case 'filesSearch':
        return unavailable(
          'files',
          `The files owner has no ${effect.kind === 'filesStat' ? 'stat' : 'name search'} yet`,
        )
    }
  }

  // ---- layout ----------------------------------------------------------------------------

  const seq = (value: number): Revision => ({ scheme: 'seq', value })

  async function layoutEffect(
    effect: Of<'layout'>,
    requestId: string,
  ): Promise<OwnerReply> {
    if (effect.kind === 'layoutLoad') {
      return reply(await layout.load({ requestId }), ({ revision }) => ({
        revision: seq(revision),
      }))
    }
    const { revision } = effect
    if (revision?.scheme !== 'seq') {
      return {
        outcome: 'refused',
        code: 'revision_required',
        reason: 'A layout save names the sequence revision it was edited from',
      }
    }
    let current: unknown
    let namedLayouts: unknown
    try {
      current = JSON.parse(effect.payload.current)
      namedLayouts = JSON.parse(effect.payload.namedLayouts)
    } catch {
      return {
        outcome: 'refused',
        code: 'invalid_layout',
        reason: 'The layout documents are not JSON',
      }
    }
    if (!plainObject(namedLayouts)) {
      return {
        outcome: 'refused',
        code: 'invalid_layout',
        reason: 'The named layouts must be a JSON object',
      }
    }
    return reply(
      await layout.save(
        { current, namedLayouts },
        { baseRevision: revision.value, requestId },
      ),
      (record) => ({ revision: seq(record.revision) }),
    )
  }

  // ---- the router ------------------------------------------------------------------------

  function route<TEffect extends Effect>(
    name: string,
    port: OwnerPort<TEffect> | undefined,
    effect: TEffect,
    requestId: string,
  ): Promise<OwnerReply> {
    return port
      ? port.perform(effect, requestId)
      : Promise.resolve(unavailable(name))
  }

  /** One owner per kind. Adding a kind to the Rust `Effect` stops this from compiling until it is routed. */
  function handle(effect: Effect, requestId: string): Promise<OwnerReply> {
    switch (effect.kind) {
      case 'filesList':
      case 'filesStat':
      case 'filesSearch':
      case 'filesCreate':
      case 'filesRename':
      case 'filesDelete':
        return filesEffect(effect, requestId)

      case 'documentCreate':
      case 'documentOpen':
      case 'documentEdit':
      case 'documentSave':
      case 'documentClose':
      case 'documentReconcile':
        return route('documents', options.documents, effect, requestId)

      case 'scmStatus':
      case 'scmDiff':
      case 'scmShow':
      case 'scmStage':
      case 'scmUnstage':
      case 'scmDiscard':
      case 'scmRestore':
      case 'scmCommit':
      case 'scmBranch':
      case 'scmFetch':
      case 'scmPush':
      case 'scmMerge':
      case 'scmBlame':
      case 'scmLog':
        return route('scm', options.scm, effect, requestId)

      case 'languageHover':
      case 'languageComplete':
      case 'languageNavigate':
      case 'languageReferences':
      case 'languageDiagnostics':
      case 'languageFormat':
      case 'languageRename':
      case 'languageApplyPlan':
        return route('language', options.language, effect, requestId)

      case 'runConfigure':
      case 'runStart':
      case 'runStop':
      case 'runPoll':
        return route('run', options.run, effect, requestId)

      case 'searchQuery':
      case 'searchCancel':
        return route('search', options.search, effect, requestId)

      case 'terminalOpen':
      case 'terminalAttach':
      case 'terminalInput':
      case 'terminalResize':
      case 'terminalDetach':
      case 'terminalEnd':
        return terminalEffect(effect, requestId)

      case 'conversationCreate':
      case 'conversationSend':
      case 'conversationInput':
      case 'conversationCancel':
      case 'conversationApproval':
        return route('conversation', options.conversation, effect, requestId)

      case 'layoutLoad':
      case 'layoutSave':
        return layoutEffect(effect, requestId)

      case 'artifactsList':
      case 'artifactRead':
        return route('artifacts', options.artifacts, effect, requestId)

      case 'clipboardWrite':
      case 'clipboardRead':
        return route('clipboard', options.clipboard, effect, requestId)

      default: {
        const unrouted: never = effect
        return Promise.resolve({
          outcome: 'refused',
          code: 'unrouted_effect',
          reason: `No owner is routed for ${String((unrouted as Effect).kind)}`,
        })
      }
    }
  }

  function completion(effect: Effect, answer: OwnerReply): Completion {
    const revision =
      answer.outcome === 'accepted' && answer.revision
        ? answer.revision
        : effect.revision
    return {
      effect: effect.id,
      resource: effect.resource,
      ...(revision ? { revision } : {}),
      ...(effect.generation !== undefined
        ? { generation: effect.generation }
        : {}),
      outcome:
        answer.outcome === 'accepted'
          ? { status: 'accepted' }
          : answer.outcome === 'refused'
            ? { status: 'refused', code: answer.code, reason: answer.reason }
            : { status: answer.outcome, reason: answer.reason },
      ...(answer.outcome === 'accepted' && answer.value
        ? { payload: answer.value }
        : {}),
    }
  }

  async function run(effect: Effect) {
    let answer: OwnerReply
    try {
      const raw = (await handle(effect, `${nonce}:${effect.id}`)) as
        OwnerReply | undefined
      answer = raw?.outcome
        ? raw
        : { outcome: 'failed', reason: 'The owner returned no outcome' }
    } catch (error) {
      // Nothing is retried here: a write may have been applied, and the owner says so itself.
      answer = { outcome: 'failed', reason: readableReason(error) }
    }
    send(completion(effect, answer))
  }

  // ---- host events -----------------------------------------------------------------------

  /** Capabilities are the owners that can serve right now; the environment's availability gates the host's. */
  function granted(): Capability[] {
    const list: Capability[] = []
    const host = env.availability.status === 'available'
    if (host) {
      list.push('environment')
      if (env.availabilityFor('workspace.files.list').status === 'available')
        list.push('files')
      list.push('terminal')
      for (const [name, port] of [
        ['documents', options.documents],
        ['scm', options.scm],
        ['language', options.language],
        ['run', options.run],
        ['search', options.search],
      ] as const) {
        if (port) list.push(name)
      }
    }
    list.push('layout')
    if (options.conversation) list.push('conversation')
    if (options.artifacts) list.push('artifacts')
    return list
  }

  let lastGranted = ''
  function reportCapabilities() {
    const capabilities = granted()
    const key = capabilities.join('\n')
    if (key === lastGranted) return
    lastGranted = key
    send({
      type: 'capabilitiesChanged',
      capabilities: { granted: capabilities },
    })
  }

  stops.push(
    env.subscribe((event) => {
      switch (event.type) {
        case 'availability':
        case 'capabilities':
          reportCapabilities()
          return
        case 'reopened':
          reportCapabilities()
          send({ type: 'resync', workspace, reason: 'reopened' })
          return
        case 'live':
          send({ type: 'connectionChanged', workspace, state: event.state })
          return
      }
    }),
  )

  // The adapter holds one share of the live stream so the connection state is always reported.
  const lease = env.acquireLive()
  lease.onReconnected(({ reason }) =>
    send({ type: 'resync', workspace, reason }),
  )
  stops.push(() => lease.release())
  send({ type: 'connectionChanged', workspace, state: env.liveState })
  void env.settled().then(reportCapabilities)

  for (const port of [
    options.documents,
    options.scm,
    options.language,
    options.run,
    options.search,
    options.conversation,
    options.artifacts,
    options.clipboard,
  ]) {
    const stop = port?.subscribe?.(send)
    if (stop) stops.push(stop)
  }

  return {
    perform(effect) {
      if (disposed) return
      void run(effect)
    },
    dispose() {
      if (disposed) return
      disposed = true
      for (const stop of stops.splice(0)) stop()
      for (const stop of watched.values()) stop()
      watched.clear()
      for (const { stop } of terminals.values()) stop()
      terminals.clear()
    },
  }
}
