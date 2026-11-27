// SOURCING: lib/capabilities/api (describe, query and invoke: the same fetches a capability table
// module makes, with the shared CSRF and idempotency helper), behind the bridge's AppCapabilities.
// The bridge checks every call against the scope before any of these runs; this is only what
// answers an allowed call, with the page's credentials, which never cross to the frame.
import type { AppCapabilities, CapabilityScope } from '@/lib/blocks/bridge'
import { describe, invoke, query } from '@/lib/capabilities/api'
import type { QueryRequest } from '@/lib/capabilities/contract'

/**
 * What a sandboxed module's capability calls reach: the instances and actions
 * the person granted, answered through the page's own session. `onInvoked`
 * hears every invocation once it settles, so the page can read again what it
 * shows of that instance.
 */
export function moduleCapabilities(
  scope: ReadonlyArray<CapabilityScope>,
  { onInvoked }: { onInvoked?: (instanceId: string) => void } = {},
): AppCapabilities {
  return {
    scope,
    describe: (instanceId) => describe(instanceId),
    // The ad-hoc query crosses as JSON; the server checks it against the definition.
    query: (request) => query(request as QueryRequest),
    invoke: async (request) => {
      try {
        return await invoke(request)
      } finally {
        onInvoked?.(request.instanceId)
      }
    },
  }
}
