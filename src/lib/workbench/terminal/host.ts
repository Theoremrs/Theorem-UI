// SOURCING: @theoremharness/sdk — `client.ide.terminal.*` and `WorkspaceLive`. The typed surface of 0.6.0-alpha.5 drops contract fields (launch backend/argv/name, lease claims, epochs, origin), so this file is the one place that widens them. Delete it when the SDK types catch up.
import type { TheoremClient, WorkspaceLive } from '@theoremharness/sdk'
import type {
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
        'open' | 'attach' | 'input' | 'resize' | 'paste' | 'close'
      >
    }
  }
  live: Pick<WorkspaceLive, 'onAny' | 'onResync' | 'onState'>
  workspaceId: string
  csrfToken: () => string | Promise<string>
  /**
   * The environment owner's generic operation call. Only `terminal.kill` needs it: the SDK has
   * no typed kill and no generic call of its own, and this module never builds a URL.
   */
  operate?: (
    operation: string,
    body: Record<string, unknown>,
  ) => Promise<unknown>
  /** Whether the host advertises an operation (the environment owner's `offers`). */
  offers?: (operation: string) => Promise<boolean>
}

export interface AttachRequest {
  session: string
  from_offset: number
  attachment?: string
  role?: Exclude<LeaseRole, 'unleased'>
}

/** What the session talks to: one method per host operation, bodies as the contract defines them. */
export interface TerminalHost {
  open: (body: Record<string, unknown>, key: string) => Promise<OpenReply>
  attach: (request: AttachRequest) => Promise<AttachReply>
  input: (
    request: {
      session: string
      bytes: string
      input_id: string
      kind: InputKind
    } & WriteClaim,
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
  canKill: () => Promise<boolean>
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
    // The generated request types the key as a UUID string.
    'Idempotency-Key': key as ReturnType<typeof crypto.randomUUID>,
  })
  return {
    // The generated `open`, `resize`, `paste` and `close` take the body as a free record, so the
    // launch fields pass through; `input` and `attach` are flat typed but spread extra fields.
    async open(body, key) {
      return (await terminal.open({
        ...(await headers(key)),
        body,
      })) as OpenReply
    },
    async attach(request) {
      return (await terminal.attach({
        ...(await headers()),
        ...request,
      })) as AttachReply
    },
    async input(request) {
      return (await terminal.input({
        ...(await headers(request.input_id)),
        ...request,
      })) as InputReply
    },
    resize: async (request) =>
      terminal.resize({ ...(await headers()), body: { ...request } }),
    paste: async (request) =>
      terminal.paste({ ...(await headers()), body: { ...request } }),
    close: async (request) =>
      terminal.close({ ...(await headers()), body: { ...request } }),
    async kill(session) {
      if (!deps.operate) {
        throw new Error('no operation call was supplied for terminal.kill')
      }
      return (await deps.operate('terminal.kill', { session })) ?? {}
    },
    canKill: async () =>
      Boolean(
        deps.operate && deps.offers && (await deps.offers('terminal.kill')),
      ),
    onEvent(listener) {
      return deps.live.onAny((event) => {
        if (event.kind.startsWith('terminal.')) {
          listener(event as unknown as TerminalLiveEvent)
        }
      })
    },
    onResync: (listener) => deps.live.onResync(listener),
    onState: (listener) => deps.live.onState(listener),
  }
}
