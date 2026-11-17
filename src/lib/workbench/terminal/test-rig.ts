// SOURCING: none — a test double with the method shapes of the SDK's `client.ide.terminal` and the live stream; no network, so the terminal owner's tests run against the real session and host mapping.
import { SUPPORTED_HERDR_BACKEND } from './fixtures/herdr-wire'
import { terminalHost } from './host'
import type { TerminalDeps } from './host'
import { TerminalSession } from './session'
import type { TerminalEvent } from './session'

type Handler = (request: Record<string, unknown>) => unknown

/** A terminal client over a stub SDK, counting every call that reaches it. `backend` is what the host's capabilities say about Herdr. */
export function rig(...named: [] | [unknown]) {
  const backend = named.length === 0 ? SUPPORTED_HERDR_BACKEND : named[0]
  const calls: { op: string; request: Record<string, unknown> }[] = []
  const handlers: Record<string, Handler> = {}
  const call = (name: string) => async (request: Record<string, unknown>) => {
    calls.push({ op: name, request })
    const handler = handlers[name]
    if (!handler) throw new Error(`no stub for ${name}`)
    return handler(request)
  }
  const live = new Set<(event: { kind: string; data: unknown }) => void>()
  const deps = {
    client: {
      ide: {
        terminal: Object.fromEntries(
          [
            'open',
            'attach',
            'input',
            'inputBytes',
            'resize',
            'paste',
            'close',
            'kill',
            'list',
          ].map((name) => [name, call(name)]),
        ),
      },
    },
    live: {
      onAny: (listener: never) => (
        live.add(listener),
        () => live.delete(listener)
      ),
      onResync: () => () => undefined,
      onState: () => () => undefined,
    },
    workspaceId: 'ws-1',
    csrfToken: () => 'csrf-1',
    offers: async () => true,
    backend: async () => backend,
  } as unknown as TerminalDeps
  const session = new TerminalSession(terminalHost(deps))
  const events: TerminalEvent[] = []
  session.subscribe((event) => events.push(event))
  return {
    session,
    events,
    calls,
    handlers,
    of: (name: string) => calls.filter((entry) => entry.op === name),
    emit: (kind: string, data: Record<string, unknown>) =>
      live.forEach((listener) => listener({ kind, data })),
  }
}
