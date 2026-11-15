// SOURCING: @theoremharness/sdk (TheoremClient, WorkspaceLive) and the app's own session bootstrap
// in src/lib/theorem/client.ts; the workspace id rule is imported from src/components/ide/follow.ts.
// Only wiring: every behavior lives in ./environment.

import { TheoremClient, WorkspaceLive } from '@theoremharness/sdk'
import { workspaceIdOf } from '@/components/ide/follow'
import { bootstrap } from '@/lib/theorem/client'
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
