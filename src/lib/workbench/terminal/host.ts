// SOURCING: @theoremharness/sdk-ide — `client.ide.terminal.*` (attach, input, inputBytes, kill, list and the free-bodied open, resize, paste, close) and `WorkspaceLive`. The 0.6.0-alpha.8 client types the lease claim, epochs, modes, `bytes_base64`, the list with its adoption state and the terminal live events, so this file only turns each host operation into one call and reads its answer. The SDK's `TerminalChannel` is not used: it answers a bare boolean, swallows refusals into a listener and mints its own input ids, while this workbench needs the panel's `input_id`, the claim it names and the four outcomes. `open`'s, `paste`'s and `kill`'s answers are untyped in the generated client (`NativeResult`), so those are read here.
import type {
  TerminalListReply,
  TerminalOpenRequest,
  TheoremClient,
  WorkspaceLive,
} from '@theoremharness/sdk-ide'
import { herdrIdentity } from './protocol'
import type { HerdrIdentity } from './protocol'
import { parseProgramReport } from './program-report'
import type { ProgramReport } from './program-report'
import { isTerminalEvent, readConnectivity } from './wire'
import type {
  Connectivity,
  AttachReply,
  InputKind,
  InputReply,
  LeaseRole,
  OpenReply,
  TerminalLiveEvent,
  WriteClaim,
} from './wire'

type SdkTerminal = TheoremClient['ide']['terminal']

/** What this module needs from the SDK's client and live stream; stubbed in tests. */
export interface TerminalDeps {
  client: {
    ide: {
      terminal: Pick<
        SdkTerminal,
        | 'open'
        | 'attach'
        | 'input'
        | 'inputBytes'
        | 'resize'
        | 'paste'
        | 'close'
        | 'kill'
        | 'list'
      >
    }
  }
  live: Pick<WorkspaceLive, 'onAny' | 'onResync' | 'onState'>
  workspaceId: string
  csrfToken: () => string | Promise<string>
  /**
   * Whether the host advertises an operation (the environment owner's `has`, once the workspace is
   * open). `terminal.kill`, `terminal.input.bytes` and `terminal.list` are sent only to a host that
   * lists them; absent, none of the three is offered.
   */
  offers?: (operation: string) => Promise<boolean>
  /**
   * What the host's capabilities say about one backend (the environment's `backend`, once the
   * workspace is open). Without it nothing identifies a Herdr core, so Herdr terminals are not opened.
   */
  backend?: (name: string) => Promise<unknown>
}

/** The host's listing, each row with the program's report read defensively (`unavailable` when the row carries none). */
export type ListedTerminals = Omit<TerminalListReply, 'sessions'> & {
  sessions: (TerminalListReply['sessions'][number] & {
    programReport?: ProgramReport
    /** What the row says about reaching the terminal's core; absent when it says nothing (an older host). */
    connectivity?: Connectivity
  })[]
}

export interface AttachRequest {
  session: string
  from_offset: number
  attachment?: string
  role?: Exclude<LeaseRole, 'unleased'>
  /**
   * With `role: 'controller'` on a lease somebody holds: the generation (and the binding epoch) of
   * the claim being made. The host refuses a claim on an occupied lease that does not name the
   * current attachment and generation.
   */
  generation?: number
  epoch?: number
}

/** Exactly one wire form of the input: UTF-8 text, or the standard base64 of the exact bytes. */
export type InputBody = { bytes: string } | { bytes_base64: string }

/** What the session talks to: one method per host operation, bodies as the contract defines them. */
export interface TerminalHost {
  /** `body` carries the launch's `operation_id`; the host returns the first reply for a repeat of it. */
  open: (
    body: TerminalOpenRequest & { operation_id?: string },
    key: string,
  ) => Promise<OpenReply>
  attach: (request: AttachRequest) => Promise<AttachReply>
  input: (
    request: {
      session: string
      input_id: string
      kind: InputKind
    } & InputBody &
      WriteClaim,
  ) => Promise<InputReply>
  resize: (
    request: { session: string; cols: number; rows: number } & WriteClaim,
  ) => Promise<unknown>
  paste: (
    request: { session: string; text: string } & WriteClaim,
  ) => Promise<unknown>
  close: (request: { session: string; attachment?: string }) => Promise<unknown>
  kill: (
    session: string,
  ) => Promise<{ process_killed?: boolean; session_live?: boolean }>
  /** The host's workspace terminals and whether that inventory is complete. */
  list: () => Promise<ListedTerminals>
  canKill: () => Promise<boolean>
  /** Whether bytes may be sent as `bytes_base64`; a host that does not list `terminal.input.bytes` reads text only. */
  canInputBytes: () => Promise<boolean>
  canList: () => Promise<boolean>
  /** Whether the host reports the Herdr core this client is pinned to, and if not what it offered. */
  herdr: () => Promise<HerdrIdentity>
  onEvent: (listener: (event: TerminalLiveEvent) => void) => () => void
  onResync: (
    listener: (resync: { epoch: string }) => void | Promise<void>,
  ) => () => void
  onState: (listener: (state: string) => void) => () => void
}

export function terminalHost(deps: TerminalDeps): TerminalHost {
  const terminal = deps.client.ide.terminal
  const headers = async (key: string = crypto.randomUUID()) => ({
    workspaceId: deps.workspaceId,
    'X-CSRF-Token': await deps.csrfToken(),
    'Idempotency-Key': key,
  })
  const offers = (operation: string) =>
    deps.offers ? deps.offers(operation) : Promise.resolve(false)
  return {
    // The generated `open`, `resize`, `paste`, `close`, `kill` and `list` take the body as a free
    // record; `input`, `inputBytes` and `attach` are flat and typed.
    async open(body, key) {
      return (await terminal.open({
        ...(await headers(key)),
        body: { ...body },
      })) as OpenReply
    },
    attach: async (request) =>
      terminal.attach({ ...(await headers()), ...request }),
    async input(request) {
      const sent = { ...(await headers(request.input_id)), ...request }
      return (await ('bytes_base64' in request
        ? terminal.inputBytes(sent)
        : terminal.input(sent))) as InputReply
    },
    resize: async (request) =>
      terminal.resize({ ...(await headers()), body: { ...request } }),
    paste: async (request) =>
      terminal.paste({ ...(await headers()), body: { ...request } }),
    close: async (request) =>
      terminal.close({ ...(await headers()), body: { ...request } }),
    async kill(session) {
      return (
        (await terminal.kill({ ...(await headers()), body: { session } })) ?? {}
      )
    },
    async list() {
      const listed = await terminal.list({ ...(await headers()), body: {} })
      return {
        ...listed,
        sessions: listed.sessions.map((row) => ({
          ...row,
          programReport: parseProgramReport(
            (row as { program_report?: unknown }).program_report,
          ),
          ...(readConnectivity(row)
            ? { connectivity: readConnectivity(row) }
            : {}),
        })),
      }
    },
    canKill: () => offers('terminal.kill'),
    canInputBytes: () => offers('terminal.input.bytes'),
    canList: () => offers('terminal.list'),
    async herdr() {
      return herdrIdentity(await deps.backend?.('herdr'))
    },
    onEvent(listener) {
      return deps.live.onAny((event) => {
        if (isTerminalEvent(event)) listener(event)
      })
    },
    onResync: (listener) => deps.live.onResync(listener),
    onState: (listener) => deps.live.onState(listener),
  }
}
