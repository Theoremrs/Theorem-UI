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
import { herdrIdentity } from './terminal/protocol'
import { causeWords, isKnownCause, stepWords } from './terminal/wire'
import type { ListedTerminals } from './terminal/host'
import { profileById, TERMINAL_PROFILES } from './terminal'
import type { ProgramReport } from './terminal/program-report'
import { sessionWatch } from './agent/sessions'
import type { SessionState, SessionWatch } from './agent/sessions'
import type { TerminalAdoption } from '@theoremharness/sdk'
import type { Layout } from './layout'
import type { AccountChange, AccountWatch } from './account'
import { grantedCapabilities } from './capabilities'
import { refusal, reply } from './port'
import type { Of, OwnerPort, OwnerReply } from './port'
import type {
  Capability,
  Completion,
  CompletionPayload,
  Effect,
  HostMessage,
  Inbound,
  LayoutDocument,
  MouseEncoding,
  MouseProtocol,
  ResourceRef,
  Revision,
  TerminalAdoption as WireAdoption,
  TerminalBackend,
  TerminalModes as WireModes,
  TerminalProfileInfo,
  TerminalSessionInfo,
} from './wire'

export type { OwnerPort, OwnerReply }

export type DocumentsPort = OwnerPort<Of<'document'>>
export type ScmPort = OwnerPort<Of<'scm'>>
export type LanguagePort = OwnerPort<Of<'language'>>
export type RunPort = OwnerPort<Of<'run'>>
export type AppearancePort = OwnerPort<Of<'appearance'>>
export type SearchPort = OwnerPort<Of<'search'>>
export type ThreadsPort = OwnerPort<Of<'threads'>>
export type ConversationPort = OwnerPort<Of<'conversation'>> & {
  /** Side chats can be created here. */
  canSideChat?: boolean
  /** Branches can be selected here. */
  canSwitchBranch?: boolean
  /** Files can be attached to the draft here. */
  canAttach?: boolean
  /** A model and an effort can be picked here. */
  canPickModel?: boolean
}
export type ArtifactsPort = OwnerPort<Of<'artifact'>>
export type DelegationsPort = OwnerPort<Of<'delegation'>>
export type ClipboardPort = OwnerPort<Of<'clipboard'>>

/** The files owner as the adapter calls it. `Files` satisfies it. */
export type FilesPort = Pick<
  Files,
  'list' | 'stat' | 'search' | 'create' | 'rename' | 'copy' | 'delete' | 'watch'
>

const MOUSE_PROTOCOLS: readonly MouseProtocol[] = [
  'none',
  'press',
  'press_release',
  'button_motion',
  'any_motion',
]
const MOUSE_ENCODINGS: readonly MouseEncoding[] = ['default', 'utf8', 'sgr']

/** One terminal binding as the adapter drives it. `TerminalSession` satisfies it. */
export type TerminalPort = Pick<
  TerminalSession,
  | 'open'
  | 'attach'
  | 'input'
  | 'inputBytes'
  | 'resize'
  | 'detach'
  | 'kill'
  | 'subscribe'
  | 'state'
>

export interface TerminalOwner {
  /** A fresh binding; the adapter keeps one per terminal id. */
  create: () => TerminalPort
  /**
   * Where the host announces terminals (`terminal.opened`, `terminal.adoption`) and, when it lists
   * `terminal.list`, its inventory. Without `list`, the session list is what this workbench knows.
   */
  host: Pick<TerminalHost, 'onEvent'> &
    /**
     * `admit` takes a terminal the host lists as not yet in this workspace (`unadmitted`, sent on as
     * `admitted: false`) into it. Absent, or on a host whose `canAdmit` says no, `terminalAdmit` is
     * refused `owner_unavailable`.
     */
    Partial<Pick<TerminalHost, 'canList' | 'list' | 'admit' | 'canAdmit'>>
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
  | 'operations'
  | 'backends'
  | 'backend'
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
  /** The account's projects and threads. */
  threads?: ThreadsPort
  artifacts?: ArtifactsPort
  delegations?: DelegationsPort
  clipboard?: ClipboardPort
  /** Applies the theme a saved arrangement carries. Absent, that effect is refused `owner_unavailable`. */
  appearance?: AppearancePort
  /** Watches the terminals an agent run acted on; the page's one watch unless a test gives its own. */
  sessions?: SessionWatch
  /** The workbench handle's `dispatch`: every message is an `Inbound`, tagged by its channel. */
  dispatch: (message: Inbound) => void
  /**
   * Who is signed in. When another account becomes the signed-in one, or the session ends, this adapter
   * is retired (see `Adapter.onRetired`). Absent, a 401 from an owner or a workspace the host will no
   * longer serve still retires it, but an account switch is not noticed.
   */
  account?: AccountWatch
  /**
   * Things that hold this account's data (the local store, the documents owner). Each is told to let go
   * when the adapter retires, so nothing of the old account is read through them afterwards.
   */
  retiring?: Retirable[]
}

/** Something that belongs to one account and must let go of it. `LocalStore` satisfies it. */
export interface Retirable {
  retire: (reason: string) => Promise<void> | void
}

/**
 * Why an adapter stopped serving. The mount builds new owners and a new adapter for what comes next
 * (the account named, if any), and sends the core its arrangement load then.
 */
export type Retirement =
  | { code: 'account_changed'; reason: string; account: string }
  | { code: 'signed_out' | 'forbidden'; reason: string }

export interface Adapter {
  /** Starts the effect and returns at once. Exactly one completion follows through `dispatch`. */
  perform: (effect: Effect) => void
  /** Stops every subscription. Results that arrive later are dropped. */
  dispose: () => void
}

/** What `createAdapter` returns: the `Adapter` the core drives, and the account side the mount watches. */
export interface AccountAdapter extends Adapter {
  /** Why this adapter no longer serves effects, once. Not called after `dispose`. */
  onRetired: (listener: (retirement: Retirement) => void) => () => void
}

const unavailable = (owner: string, why?: string): OwnerReply => ({
  outcome: 'refused',
  code: 'owner_unavailable',
  reason: why ?? `The ${owner} owner is not connected`,
})

function base64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

const plainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** The wire completion of an effect an owner has answered: what the core is told. */
export function completionFor(effect: Effect, answer: OwnerReply): Completion {
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
    ...(answer.outcome !== 'uncertain' &&
    answer.outcome !== 'failed' &&
    answer.value
      ? { payload: answer.value }
      : {}),
  }
}

/**
 * What a program's own report says of its work, as the session watch reads
 * it. A report with no current word, or a state it does not name, says
 * nothing.
 */
function reportState(report: ProgramReport): SessionState | undefined {
  if (report.kind !== 'current') return undefined
  switch (report.status.state) {
    case 'working':
      return 'working'
    case 'idle':
    case 'done':
      return 'finished'
    case 'blocked':
      return 'waiting'
    case 'error':
      return 'failed'
    default:
      return undefined
  }
}

export function createAdapter(options: AdapterOptions): AccountAdapter {
  const agentSessions = options.sessions ?? sessionWatch
  const { environment: env, files, layout, dispatch } = options
  const workspace = env.workspaceId
  /** Makes request ids unique across page loads: effect ids restart, and a host may remember a key. */
  const nonce = crypto.randomUUID()
  const stops: (() => void)[] = []
  let disposed = false
  /** Set once: from then on every effect is refused with this, and nothing of the old account is delivered. */
  let retired: Retirement | undefined
  const retirementListeners = new Set<(retirement: Retirement) => void>()
  /** Effects performed and not yet answered: what a retirement answers `uncertain`. */
  const inflight = new Map<Effect['id'], Effect>()

  function deliver(message: Inbound) {
    if (disposed) return
    try {
      dispatch(message)
    } catch (error) {
      console.warn('The workbench rejected a message', error)
    }
  }
  /** After a retirement the old account's owners may still push: none of it reaches the core. */
  let muted = false
  const send = (message: HostMessage) => {
    if (!muted) deliver({ channel: 'host', ...message })
  }
  const complete = (message: Completion) =>
    deliver({ channel: 'completion', ...message })

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
      forward(event)
      // A report changes what the program says about itself and nothing else: the entry keeps it for
      // the next list, and no list, profile or state is published because of it.
      track(port, event.type !== 'report')
    })

    function forward(event: TerminalEvent) {
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
          // The screen to replay, and the offset of the first byte after it.
          send({
            type: 'terminalReset',
            resource: target,
            epoch: event.epoch ?? epoch(),
            offset: port.state.offset,
            data: base64(new TextEncoder().encode(event.formatted)),
          })
          return
        case 'exited':
          agentSessions.observe(
            port.state.terminalId!,
            'ended',
            typeof event.code === 'number'
              ? `exit code ${event.code}`
              : event.reason,
          )
          send({
            type: 'terminalExited',
            resource: target,
            epoch: epoch(),
            ...(typeof event.code === 'number' ? { exitCode: event.code } : {}),
            reason: event.reason,
          })
          return
        case 'lost':
          agentSessions.observe(
            port.state.terminalId!,
            'ended',
            'the program was lost',
          )
          send({
            type: 'terminalExited',
            resource: target,
            epoch: epoch(),
            reason: 'lost',
          })
          return
        case 'connectivity':
          // The core connection is lost or back. Loss is not an end: the host retains the terminal and
          // its process outcome is unknown, so it is sent as connectivity (never as an exit), with the host's
          // own cause and next step as sent. `running` clears a loss that came from connectivity in the same
          // epoch; the pane never lets it revive an exit.
          send({
            type: 'terminalConnectivity',
            resource: target,
            epoch: event.bindingEpoch ?? epoch(),
            state: event.connectivity.state,
            ...(event.connectivity.state === 'lost' && event.connectivity.reason
              ? { reason: event.connectivity.reason }
              : {}),
            ...(event.connectivity.state === 'lost' &&
            event.connectivity.nextStep
              ? { nextStep: event.connectivity.nextStep }
              : {}),
          })
          return
        case 'resized':
          send({
            type: 'terminalResized',
            resource: target,
            ...(port.state.bindingEpoch !== undefined
              ? { epoch: port.state.bindingEpoch }
              : {}),
            cols: event.cols,
            rows: event.rows,
          })
          return
        case 'report':
          // The program's word, passed on exactly as the owner parsed it: no field is read, joined
          // into text or logged here. A report for no known binding epoch is not sent.
          if (event.bindingEpoch === undefined || event.bindingEpoch < epoch())
            return
          {
            const state = reportState(event.report)
            if (state) agentSessions.observe(port.state.terminalId!, state)
          }
          send({
            type: 'terminalReport',
            resource: target,
            epoch: event.bindingEpoch,
            report: event.report,
          })
          return
        case 'reconnected':
          return
      }
    }
  }

  // ---- the terminal session list ---------------------------------------------------------
  // A host that lists `terminal.list` says which terminals the workspace has and whether that
  // inventory is complete (`adoption`): `settled`, so a terminal it does not list does not exist;
  // `pending`, so absence proves nothing yet; or `unavailable`, with the reason. Without the
  // operation the list is what this workbench knows: the bindings it holds and the programs the
  // host announced. It is sent whole whenever it changes.

  const sessions = new Map<string, TerminalSessionInfo>()
  let lastSessions = ''
  /** What the host last said about its inventory; undefined until `terminal.list` or `terminal.adoption` has said. */
  let adoption: TerminalAdoption | undefined

  const profileLabel = (backend: TerminalBackend) =>
    TERMINAL_PROFILES.find((profile) => profile.backend === backend)?.id ??
    backend

  /** The coding profile a foreground program names, if the catalog offers one for it. */
  const codingProfileOf = (command: string): string | undefined => {
    const program = command.trim().split('/').pop()
    return TERMINAL_PROFILES.find((profile) => profile.argv?.[0] === program)?.id
  }

  /** A row's profile: the program in its foreground now as the host names it, else what an earlier list said, else the backend's own. */
  const rowProfile = (row: { command?: string }, backend: TerminalBackend, held?: string) =>
    row.command?.trim()
      ? (codingProfileOf(row.command) ?? profileLabel(backend))
      : (held ?? profileLabel(backend))

  function profiles(): TerminalProfileInfo[] {
    const herdr = env.backends().includes('herdr')
    // Not ready and not the pinned core are different facts; the identity says which, so a host
    // that reports ready is never told it is not ready.
    const identity = herdrIdentity(env.backend('herdr'))
    // Herdr's terminals cannot be reached while the host cannot read the core's inventory: that is
    // stated here, on the profile the wire already gives a reason to, never as an empty list.
    const unreachable = adoption?.state === 'unavailable' ? adoption : undefined
    return TERMINAL_PROFILES.map((profile) => {
      const herdrProfile = profile.backend === 'herdr'
      const reason = !herdrProfile
        ? undefined
        : !herdr
          ? identity.supported
            ? 'The host reports Herdr terminals not ready'
            : identity.reason
          : unreachable && adoptionWords(unreachable)
      return {
        id: profile.id,
        label: profile.id,
        backend: profile.backend,
        ...(profile.argv ? { argv: [...profile.argv] } : {}),
        available: !herdrProfile || (herdr && !unreachable),
        ...(herdrProfile && (!herdr || unreachable)
          ? { unavailableReason: reason }
          : {}),
      }
    })
  }

  /** Why the host cannot read the core's inventory, in plain words, with its advice. */
  function adoptionWords(unreachable: {
    reason?: string
    next_step?: string
  }): string | undefined {
    // A stable code is put in plain words with the host's advice; free text from an older host is shown as sent.
    if (!isKnownCause(unreachable.reason)) return unreachable.reason
    return `Herdr terminals cannot be reached: ${causeWords(unreachable.reason)}.${unreachable.next_step ? ` ${stepWords(unreachable.next_step)}` : ''}`
  }

  /** The host's adoption state as the wire names it; a state the wire does not know is left out, never guessed. */
  function wireAdoption(): WireAdoption | undefined {
    if (!adoption) return undefined
    const state: string = adoption.state
    if (state === 'pending' || state === 'settled') return { state }
    if (state === 'unavailable') {
      const { reason, next_step: nextStep } = adoption as {
        reason?: unknown
        next_step?: unknown
      }
      return {
        state,
        ...(typeof reason === 'string' && reason ? { reason } : {}),
        ...(typeof nextStep === 'string' && nextStep
          ? { next_step: nextStep }
          : {}),
      }
    }
    return undefined
  }

  /** A row's modes as the wire names them. A value the wire has no word for leaves the modes out whole. */
  function wireModes(modes: unknown): WireModes | undefined {
    const m = (modes && typeof modes === 'object' ? modes : {}) as Record<
      string,
      unknown
    >
    const flags = [
      m.alternate_screen,
      m.application_cursor,
      m.application_keypad,
      m.bracketed_paste,
      m.hide_cursor,
    ]
    const protocol = MOUSE_PROTOCOLS.find((word) => word === m.mouse_protocol)
    const encoding = MOUSE_ENCODINGS.find((word) => word === m.mouse_encoding)
    if (
      !flags.every((flag) => typeof flag === 'boolean') ||
      !protocol ||
      !encoding
    ) {
      return undefined
    }
    return {
      alternateScreen: m.alternate_screen as boolean,
      applicationCursor: m.application_cursor as boolean,
      applicationKeypad: m.application_keypad as boolean,
      bracketedPaste: m.bracketed_paste as boolean,
      hideCursor: m.hide_cursor as boolean,
      mouseProtocol: protocol,
      mouseEncoding: encoding,
    }
  }

  /** Reads what the host lists into the session list: unbound rows are the host's, bound ones stay the binding's. */
  function absorb(listed: ListedTerminals) {
    adoption = listed.adoption
    const rows = new Set<string>()
    for (const row of listed.sessions) {
      rows.add(row.session)
      const modes = wireModes(row.modes)
      const held = sessions.get(row.session)
      const report = row.programReport
      const extra = row as { host?: unknown }
      // What its owner called it, else the program in its foreground (`claude`, `zsh`): either says
      // which terminal this is, where the profile alone would call every Herdr session the same.
      const name = row.name ?? row.command
      const cwd = row.cwd
      const owned = typeof extra.host === 'string' ? extra.host : undefined
      if (terminals.has(row.session)) {
        // The binding owns the rest of its entry; the host's modes, and what the terminal is called
        // and where its program works, are still the host's to say.
        if (held) {
          const { name: _name, cwd: _cwd, ...rest } = held
          sessions.set(row.session, {
            ...rest,
            ...(modes ? { modes } : {}),
            ...(name ? { name } : {}),
            ...(cwd ? { cwd } : {}),
          })
        }
        continue
      }
      sessions.set(row.session, {
        ...(modes ? { modes } : {}),
        ...(report && report.kind !== 'unavailable'
          ? { programReport: report }
          : {}),
        session: row.session,
        profile: rowProfile(row, row.backend, sessions.get(row.session)?.profile),
        backend: row.backend,
        workspace,
        program: row.binding.program,
        state: row.state,
        ...(name ? { name } : {}),
        ...(cwd ? { cwd } : {}),
        ...(owned ? { host: owned } : {}),
      })
    }
    // The person's own terminals the host offers to take in: listed, and nothing else until
    // `terminalAdmit`. Admitted, the same id comes back as a session above.
    for (const row of listed.unadmitted ?? []) {
      if (rows.has(row.session)) continue
      rows.add(row.session)
      const report = row.programReport
      const name = row.name ?? row.command
      sessions.set(row.session, {
        ...(report && report.kind !== 'unavailable'
          ? { programReport: report }
          : {}),
        session: row.session,
        profile: rowProfile(row, row.backend),
        backend: row.backend,
        workspace,
        state: row.state,
        ...(name ? { name } : {}),
        ...(row.cwd ? { cwd: row.cwd } : {}),
        admitted: false,
      })
    }
    // Only a settled inventory proves a terminal is gone; pending and unavailable ones prove nothing.
    if (adoption.state === 'settled') {
      for (const id of [...sessions.keys()]) {
        if (!rows.has(id) && !terminals.has(id)) sessions.delete(id)
      }
    }
  }

  /** `disposed` read through a call, so a read made across an await is not narrowed to the value it had before it. */
  const stopped = () => disposed
  const again = () => relist
  let listing: Promise<void> | undefined
  let relist = false
  /** Reads `terminal.list` once at a time; a request that arrives while one is out asks for another read after it. */
  function refreshList(): Promise<void> {
    if (listing) {
      relist = true
      return listing
    }
    const read = async () => {
      do {
        relist = false
        const { host } = options.terminal
        if (stopped() || !host.list || !host.canList) return
        try {
          await env.settled()
          if (
            stopped() ||
            env.availability.status !== 'available' ||
            !(await host.canList())
          ) {
            return
          }
          const listed = await host.list()
          if (stopped()) return
          absorb(listed)
        } catch (error) {
          // A list that could not be read changes nothing: the sessions known stay, none is dropped.
          console.warn('The terminal list could not be read', error)
        }
        publishSessions()
      } while (again())
    }
    listing = read().finally(() => {
      listing = undefined
    })
    return listing
  }

  function publishSessions() {
    if (disposed) return
    const message: HostMessage = {
      type: 'terminalSessions',
      workspace,
      profiles: profiles(),
      sessions: [...sessions.values()],
      ...(wireAdoption() ? { adoption: wireAdoption() } : {}),
    }
    const key = JSON.stringify(message)
    if (key === lastSessions) return
    lastSessions = key
    send(message)
  }

  /** Reads one binding into the list: its profile, program, liveness and whether another viewer holds control. */
  function track(port: TerminalPort, publish = true) {
    const { state } = port
    const session = state.terminalId
    if (!session) return
    const backend = backendOf(port)
    const profile =
      state.profile && profileById(state.profile.id)
        ? state.profile.id
        : (sessions.get(session)?.profile ?? profileLabel(backend))
    const known = sessions.get(session)
    sessions.set(session, {
      session,
      profile,
      backend,
      workspace,
      ...(known?.modes ? { modes: known.modes } : {}),
      // What the host called it and where it works: a binding knows neither, so they are kept.
      ...(known?.name ? { name: known.name } : {}),
      ...(known?.cwd ? { cwd: known.cwd } : {}),
      ...(state.programReport.kind !== 'unavailable'
        ? { programReport: state.programReport }
        : {}),
      ...(state.processOwnedBy ? { host: state.processOwnedBy } : {}),
      ...(state.program !== undefined ? { program: state.program } : {}),
      state:
        state.phase === 'exited'
          ? 'exited'
          : state.phase === 'lost' || state.connectivity.state === 'lost'
            ? 'lost'
            : 'running',
      ...(state.phase !== 'exited' && state.connectivity.state === 'lost'
        ? {
            ...(state.connectivity.reason
              ? { reason: state.connectivity.reason }
              : {}),
            ...(state.connectivity.nextStep
              ? { nextStep: state.connectivity.nextStep }
              : {}),
          }
        : {}),
    })
    if (publish) publishSessions()
  }

  stops.push(
    options.terminal.host.onEvent((event) => {
      if (event.kind === 'terminal.adoption') {
        // The inventory's completeness changed; a settled one is read again, and a terminal that
        // arrived late is then listed.
        adoption = event.data
        publishSessions()
        void refreshList()
        return
      }
      if (event.kind === 'terminal.unadmitted') {
        // What the host offers to admit may have changed; the event carries no rows, the list does.
        void refreshList()
        return
      }
      if (event.kind === 'terminal.exited') {
        // A terminal this workbench does not hold has ended; the host's list says whether it is still held.
        if (!terminals.has(event.data.session)) void refreshList()
        return
      }
      if (event.kind !== 'terminal.opened') return
      const { session, epoch, program, origin, cols, rows, backend } =
        event.data
      const key = bindingKey(session, epoch, program)
      if (reported.has(key)) return
      reported.add(key)
      if (!sessions.has(session)) {
        const announced: TerminalBackend =
          backend === 'herdr' ? 'herdr' : 'native'
        sessions.set(session, {
          session,
          profile: profileLabel(announced),
          backend: announced,
          workspace,
          ...(program !== undefined ? { program } : {}),
          state: 'running',
        })
        publishSessions()
      }
      send({
        type: 'terminalOpened',
        resource: terminalRef(session),
        epoch: epoch ?? 0,
        program: program ?? 0,
        backend: backend === 'herdr' ? 'herdr' : 'native',
        origin: origin ?? 'unspecified',
        cols,
        rows,
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
      // What the session did not report stays absent; the core derives the owner from the backend.
      ...(state.streamEpoch ? { streamEpoch: state.streamEpoch } : {}),
      ...(state.origin ? { origin: state.origin } : {}),
      ...(state.processOwnedBy ? { processOwnedBy: state.processOwnedBy } : {}),
      ...(state.attachment ? { attachment: state.attachment } : {}),
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

  /** Takes a session the host lists as outside this workspace into it, then reads the list again so the row is an ordinary one. */
  async function admitTerminal(session: string): Promise<OwnerReply> {
    const { admit, canAdmit } = options.terminal.host
    if (!admit || (canAdmit && !(await canAdmit())))
      return unavailable('terminal admission')
    try {
      await admit(session)
    } catch (error) {
      return {
        outcome: 'uncertain',
        reason: error instanceof Error ? error.message : String(error),
      }
    }
    await refreshList()
    return { outcome: 'accepted' }
  }

  async function terminalEffect(
    effect: Of<'terminal'>,
    requestId: string,
  ): Promise<OwnerReply> {
    // A terminal an agent run sent words to (code.send) is watched for that run.
    if (
      effect.actor?.type === 'agent' &&
      effect.kind !== 'terminalOpen' &&
      effect.resource.type === 'terminal'
    ) {
      const session = effect.resource.session
      agentSessions.acted(
        session,
        effect.actor.runId,
        terminals.get(session)?.port.state.profile?.id ?? 'the terminal',
      )
    }
    if (effect.kind === 'terminalOpen') {
      const opening = openTerminal(effect, requestId)
      openings.set(effect.id, opening)
      if (openings.size > OPENINGS_KEPT)
        openings.delete(openings.keys().next().value!)
      return opening
    }

    if (effect.kind === 'terminalAbandonOpen')
      return abandonOpen(effect.payload.open)

    if (effect.kind === 'terminalAdmit')
      return admitTerminal(effect.payload.session)

    return terminalOperation(effect)
  }

  /** What each `terminalOpen` answered, by effect id, so the open can be undone after it settled. */
  const openings = new Map<number, Promise<OwnerReply>>()
  const OPENINGS_KEPT = 256

  /** Undoes a `terminalOpen`: the program it started is ended and the binding forgotten. An open that never started one has nothing to undo. */
  async function abandonOpen(open: number): Promise<OwnerReply> {
    const opening = openings.get(open)
    if (!opening)
      return refusal(
        'unknown_open',
        `No terminal open ${open} was made by this workbench`,
      )
    const answer = await opening
    openings.delete(open)
    if (answer.outcome === 'uncertain')
      return {
        outcome: 'uncertain',
        reason: `The open's outcome is unknown, so a program it started has no id here to end: ${answer.reason}`,
      }
    if (answer.outcome !== 'accepted' || answer.value?.type !== 'terminal')
      return { outcome: 'accepted' }
    const bound = terminals.get(answer.value.session)
    if (!bound) return { outcome: 'accepted' }
    const done = await bound.port.kill()
    if (done.outcome === 'accepted') {
      bound.stop()
      terminals.delete(answer.value.session)
    }
    return reply(done)
  }

  /** The launch intent the pane named (`operation`), read defensively: a host or an older pane may name none. */
  function intentOf(payload: object): string | undefined {
    const { operation } = payload as { operation?: unknown }
    return typeof operation === 'string' && operation !== ''
      ? operation
      : undefined
  }

  async function openTerminal(
    effect: Extract<Of<'terminal'>, { kind: 'terminalOpen' }>,
    requestId: string,
  ): Promise<OwnerReply> {
    const { backend, argv, name, cols, rows, attachment } = effect.payload
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
      ...(attachment ? { attachment } : {}),
      // One id per launch intent. The pane names the intent when its effect carries one (`operation`), so a
      // retry of the same intent is the same launch to the host; otherwise it is this effect's own id.
      idempotencyKey: intentOf(effect.payload) ?? requestId,
    })
    if (done.outcome === 'accepted' && !disposed) {
      terminals.set(done.value.terminalId, { port, stop })
      // A program an agent run started (code.start) is watched for that run.
      if (effect.actor?.type === 'agent')
        agentSessions.acted(
          done.value.terminalId,
          effect.actor.runId,
          name ?? argv?.join(' ') ?? 'the terminal',
        )
      track(port)
    } else {
      stop()
    }
    return reply(done, () => opened(port, { cols, rows }))
  }

  async function terminalOperation(
    effect: Exclude<
      Of<'terminal'>,
      { kind: 'terminalOpen' | 'terminalAbandonOpen' | 'terminalAdmit' }
    >,
  ): Promise<OwnerReply> {
    const session = terminalOf(effect.resource)
    if (!session) return noTerminal(effect.resource)

    if (effect.kind === 'terminalAttach') {
      const known = terminals.get(session)
      const port = known?.port ?? options.terminal.create()
      const stop = known?.stop ?? follow(port)
      const done = await port.attach({
        terminalId: session,
        fromOffset: effect.payload.fromOffset,
        attachment: effect.payload.attachment,
      })
      if (done.outcome === 'accepted' && !disposed) {
        terminals.set(session, { port, stop })
        track(port)
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
        // The panel minted the id and named the claim; the session sends both as they are, so a
        // resend of an uncertain input is the same input to the host.
        return reply(
          await bound.port.input(effect.payload.bytes, effect.payload.kind, {
            inputId: effect.payload.inputId,
            claim: effect.payload.claim,
          }),
        )
      case 'terminalInputBytes':
        // Exact bytes, under the panel's id and claim; the session sends them as `bytes_base64`.
        return reply(
          await bound.port.inputBytes(
            effect.payload.data,
            effect.payload.kind,
            {
              inputId: effect.payload.inputId,
              claim: effect.payload.claim,
            },
          ),
        )
      case 'terminalResize':
        return reply(
          await bound.port.resize(effect.payload.cols, effect.payload.rows, {
            claim: effect.payload.claim,
          }),
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
              entries: rows.map(({ name, kind, ignored, hidden }) => ({
                name,
                kind,
                ...(ignored !== undefined ? { ignored } : {}),
                ...(hidden !== undefined ? { hidden } : {}),
              })),
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
        return reply(
          await files.stat({ requestId, path: effect.payload.path }),
          ({ kind, size, modified, readonly }) => ({
            value: {
              type: 'fileStat',
              kind,
              ...(size !== undefined ? { size } : {}),
              ...(modified !== undefined ? { mtimeMs: modified } : {}),
              ...(readonly !== undefined ? { readonly } : {}),
            },
          }),
        )
      case 'filesSearch':
        return reply(
          await files.search({ requestId, ...effect.payload }),
          ({ rows, partial, next }) => ({
            value: {
              type: 'fileSearchPage',
              rows: rows.map(
                ({ path, name, kind, size, modified, ignored, hidden }) => ({
                  path,
                  name,
                  kind,
                  ...(size !== undefined ? { size } : {}),
                  ...(modified !== undefined ? { modified } : {}),
                  ...(ignored !== undefined ? { ignored } : {}),
                  ...(hidden !== undefined ? { hidden } : {}),
                }),
              ),
              partial,
              ...(next !== undefined ? { next } : {}),
            },
          }),
        )
      case 'filesCopy':
        return reply(await files.copy({ requestId, ...effect.payload }))
    }
  }

  // ---- layout ----------------------------------------------------------------------------

  const seq = (value: number): Revision => ({ scheme: 'seq', value })

  async function layoutEffect(
    effect: Of<'layout'>,
    requestId: string,
  ): Promise<OwnerReply> {
    if (effect.kind === 'layoutLoad') {
      return reply(
        await layout.load({ requestId }),
        ({ revision, document, source }) => ({
          revision: seq(revision),
          value: {
            type: 'layoutLoaded',
            source,
            revision: seq(revision),
            ...(document
              ? {
                  document: {
                    current: JSON.stringify(document.current),
                    namedLayouts: JSON.stringify(document.namedLayouts),
                  } satisfies LayoutDocument,
                }
              : {}),
          },
        }),
      )
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
      (record) => ({
        revision: seq(record.revision),
        value: { type: 'layoutSaved', revision: seq(record.revision) },
      }),
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
      case 'filesCopy':
      case 'filesDelete':
        return filesEffect(effect, requestId)

      case 'documentCreate':
      case 'documentOpen':
      case 'documentEdit':
      case 'documentSave':
      case 'documentClose':
      case 'documentReconcile':
      case 'documentRevert':
      case 'documentSettle':
      case 'documentKeep':
      case 'documentHistoryList':
      case 'documentHistoryPreview':
      case 'documentHistoryRestore':
        return route('documents', options.documents, effect, requestId)

      case 'scmStatus':
      case 'scmDiff':
      case 'scmShow':
      case 'scmStage':
      case 'scmUnstage':
      case 'scmDiscard':
      case 'scmRestore':
      case 'scmCommit':
      case 'scmAmend':
      case 'scmBranches':
      case 'scmDiffCommit':
      case 'scmShowRevision':
      case 'scmBranch':
      case 'scmFetch':
      case 'scmPush':
      case 'scmMerge':
      case 'scmBlame':
      case 'scmLog':
      case 'scmConflict':
      case 'scmResolve':
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
      case 'runList':
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
      case 'terminalInputBytes':
      case 'terminalAbandonOpen':
      case 'terminalAdmit':
        return terminalEffect(effect, requestId)

      case 'threadsList':
      case 'threadsCreate':
      case 'threadsRename':
      case 'threadsArchive':
      case 'threadsDelete':
      case 'threadsPin':
      case 'threadsTag':
      case 'threadsUnread':
      case 'threadsRetitle':
      case 'threadsMarkdown':
        return route('threads', options.threads, effect, requestId)

      case 'conversationCreate':
      case 'conversationSend':
      case 'conversationInput':
      case 'conversationDismissInput':
      case 'conversationCancel':
      case 'conversationRetry':
      case 'conversationEdit':
      case 'conversationSwitch':
      case 'conversationApproval':
      case 'conversationSideChat':
      case 'conversationSideList':
      case 'conversationSwitchBranch':
      case 'conversationAttachPick':
      case 'conversationAttachRemove':
      case 'conversationModels':
      case 'conversationSetModel':
      case 'conversationSetEffort':
      case 'conversationSideClose':
        return route('conversation', options.conversation, effect, requestId)

      case 'layoutLoad':
      case 'layoutSave':
        return layoutEffect(effect, requestId)

      case 'artifactsList':
      case 'artifactRead':
        return route('artifacts', options.artifacts, effect, requestId)

      case 'delegationChanges':
      case 'delegationContent':
        return route('delegations', options.delegations, effect, requestId)

      case 'clipboardWrite':
      case 'clipboardRead':
        return route('clipboard', options.clipboard, effect, requestId)

      case 'appearanceApply':
        return route('appearance', options.appearance, effect, requestId)

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

  async function run(effect: Effect) {
    if (retired) {
      complete(completionFor(effect, refusal(retired.code, retired.reason)))
      return
    }
    inflight.set(effect.id, effect)
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
    // Retired while it ran: the retirement already answered it `uncertain`, and this result is not applied.
    if (!inflight.delete(effect.id)) return
    complete(completionFor(effect, answer))
    if (answer.outcome === 'refused' && answer.code === 'signed_out') {
      if (options.account) void options.account.refresh()
      else retire({ code: 'signed_out', reason: answer.reason })
    }
  }

  /**
   * The account that this adapter's owners were built for is no longer the one in use, or its access
   * ended. Everything in flight is answered `uncertain` (it may have happened; it is not applied), the
   * owners' subscriptions stop, what the account holds on this device is let go, and the core is told.
   */
  function retire(next: Retirement) {
    if (retired || disposed) return
    retired = next
    const answering = [...inflight.values()]
    inflight.clear()
    for (const stop of stops.splice(0)) stop()
    for (const stop of watched.values()) stop()
    watched.clear()
    for (const { stop } of terminals.values()) stop()
    terminals.clear()
    if (next.code === 'account_changed') {
      send({ type: 'accountChanged', account: next.account })
    }
    send({ type: 'capabilitiesChanged', capabilities: { granted: [] } })
    send({ type: 'connectionChanged', workspace, state: 'closed' })
    for (const effect of answering) {
      complete(
        completionFor(effect, {
          outcome: 'uncertain',
          reason: `${next.reason}; this request was not completed for the new session and its result was not applied`,
        }),
      )
    }
    muted = true
    for (const holder of options.retiring ?? []) {
      void Promise.resolve(holder.retire(next.reason)).catch((error: unknown) =>
        console.warn('An account holder could not let go', error),
      )
    }
    for (const listener of [...retirementListeners]) {
      try {
        listener(next)
      } catch (error) {
        console.warn('A retirement listener failed', error)
      }
    }
  }

  // ---- host events -----------------------------------------------------------------------

  /** What the host advertises, plus the owners that are the workbench's own rather than host operations. */
  function granted(): Capability[] {
    const local: Capability[] = ['layout']
    if (options.conversation) local.push('conversation')
    if (options.conversation?.canSideChat) local.push('conversation.side')
    if (options.conversation?.canSwitchBranch) local.push('conversation.branch')
    if (options.conversation?.canAttach) local.push('conversation.attach')
    if (options.conversation?.canPickModel) local.push('conversation.model')
    // What the account's SDK can do. Pin, tags, unread marks and title regeneration have no call
    // there, so they are not granted: the panel offers none of them. Admitting a Herdr session is the
    // host's `terminal.admit`, granted with the rest of what the host lists.
    if (options.threads)
      local.push(
        'threads',
        'threads.create',
        'threads.rename',
        'threads.archive',
        'threads.delete',
        'threads.markdown',
      )
    if (options.artifacts) local.push('artifacts')
    if (options.clipboard) local.push('clipboard')
    return grantedCapabilities(env, local)
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
          if (
            event.type === 'availability' &&
            event.availability.status === 'unavailable' &&
            (event.availability.cause === 'signed_out' ||
              event.availability.cause === 'forbidden')
          ) {
            retire({
              code: event.availability.cause,
              reason: event.availability.reason,
            })
            return
          }
          reportCapabilities()
          publishSessions()
          void refreshList()
          return
        case 'reopened':
          reportCapabilities()
          publishSessions()
          void refreshList()
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
  void env.settled().then(() => {
    reportCapabilities()
    publishSessions()
    void refreshList()
  })

  for (const port of [
    options.documents,
    options.scm,
    options.language,
    options.run,
    options.search,
    options.conversation,
    options.threads,
    options.artifacts,
    options.delegations,
    options.clipboard,
  ]) {
    const stop = port?.subscribe?.(send)
    if (stop) stops.push(stop)
  }

  if (options.account) {
    const { account } = options
    stops.push(
      account.onChange(({ account: next, reason }: AccountChange) =>
        retire(
          next === undefined
            ? { code: 'signed_out', reason }
            : { code: 'account_changed', reason, account: next },
        ),
      ),
    )
  }

  return {
    perform(effect) {
      if (disposed) return
      void run(effect)
    },
    onRetired(listener) {
      retirementListeners.add(listener)
      return () => void retirementListeners.delete(listener)
    },
    dispose() {
      if (disposed) return
      disposed = true
      inflight.clear()
      for (const stop of stops.splice(0)) stop()
      for (const stop of watched.values()) stop()
      watched.clear()
      for (const { stop } of terminals.values()) stop()
      terminals.clear()
    },
  }
}
