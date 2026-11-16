// SOURCING: @theoremharness/sdk (TheoremClient, WorkspaceLive) and the app's own session bootstrap
// in src/lib/theorem/client.ts; the workspace id rule is imported from src/components/ide/follow.ts.
// Only wiring: every behavior lives in ./environment.

import { TheoremClient, WorkspaceLive } from '@theoremharness/sdk'
import { workspaceIdOf } from '@/components/ide/follow'
import { bootstrap } from '@/lib/theorem/client'
import { terminalHost } from '../terminal/host'
import type { TerminalHost } from '../terminal/host'
import { createEnvironment } from './environment'
import type { Environment } from './environment'

/**
 * The environment for a project, over the signed-in session. Requests go to this
 * origin and the server route adds the bearer, as for every other Theorem call;
 * the host the proxy reaches is set by THEOREM_API_URL on the server.
 */
export function connectEnvironment(
  projectId: string,
): Environment<TheoremClient> {
  const workspaceId = workspaceIdOf(projectId)
  return createEnvironment({
    workspaceId,
    bootstrap,
    createClient: (fetch) =>
      new TheoremClient({
        baseUrl: () => window.location.origin,
        auth: false,
        fetch,
      }),
    createLive: (client) => new WorkspaceLive({ client, workspaceId }),
    fetch: (input, init) => window.fetch(input, init),
  })
}

/**
 * The terminal owner's transport over an environment: its own live stream (the terminal events and
 * their resync) and the environment's client, so the mount builds no SDK value of its own. The host
 * lists `terminal.kill`, `terminal.input.bytes` and `terminal.list`, or this does not offer them.
 */
export function connectTerminalHost(environment: Environment<TheoremClient>): {
  host: TerminalHost
  stop: () => void
} {
  const { workspaceId } = environment
  const live = new WorkspaceLive({ client: environment.client, workspaceId })
  void live.start()
  return {
    host: terminalHost({
      client: environment.client,
      live,
      workspaceId,
      csrfToken: async () => (await bootstrap()).csrfToken,
      offers: async (operation) => {
        await environment.settled()
        return environment.has(operation)
      },
      backend: async (name) => {
        await environment.settled()
        return environment.backend(name)
      },
    }),
    stop: () => live.close(),
  }
}
