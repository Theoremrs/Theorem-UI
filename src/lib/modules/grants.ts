// SOURCING: zustand + zustand/middleware persist (per browser, as the shell's
// own state is), Web Crypto SHA-256 for a module's digest. Grants are kept out
// of the vault on purpose: a page or module file is written by agents as well
// as people, so a grant stored beside it could be granted by whoever wrote it.
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { InstanceRequest, RequestedCapabilities } from './contract'

/** What the person allowed one module, for one exact version of its files. */
export interface Grant {
  /** The digest of the manifest and page the person saw. */
  digest: string
  /** A subset of what was requested; the person may allow less. */
  capabilities: RequestedCapabilities
  grantedAt: number
}

interface Grants {
  grants: Record<string, Grant>
  grant: (key: string, grant: Grant) => void
  revoke: (key: string) => void
}

export const grantKey = (workspaceId: string, moduleId: string) =>
  `${workspaceId}|${moduleId}`

export const useModuleGrants = create<Grants>()(
  persist(
    (set) => ({
      grants: {},
      grant: (key, grant) =>
        set((s) => ({ grants: { ...s.grants, [key]: grant } })),
      revoke: (key) =>
        set((s) => {
          const { [key]: _, ...rest } = s.grants
          return { grants: rest }
        }),
    }),
    {
      name: 'theorem-ui:module-grants',
      version: 1,
      partialize: ({ grants }) => ({ grants }),
    },
  ),
)

/** The grant for these exact files, if the person gave one. */
export const grantFor = (
  grants: Record<string, Grant>,
  key: string,
  digest: string | undefined,
): Grant | undefined => {
  const grant = grants[key]
  return grant && digest && grant.digest === digest ? grant : undefined
}

/** Each instance's methods and actions both asked and allowed; invoke goes with no action left. */
function grantedInstances(
  requested: ReadonlyArray<InstanceRequest>,
  allowed: ReadonlyArray<InstanceRequest>,
): InstanceRequest[] {
  return requested.flatMap((asked) => {
    const given = allowed.find((one) => one.instanceId === asked.instanceId)
    if (!given) return []
    const actions = asked.actions.filter((key) => given.actions.includes(key))
    const methods = asked.methods.filter(
      (method) =>
        given.methods.includes(method) &&
        (method !== 'invoke' || actions.length > 0),
    )
    return methods.length
      ? [{ instanceId: asked.instanceId, methods, actions }]
      : []
  })
}

/** The granted part of a request: never more than was both asked and allowed. */
export function granted(
  requested: RequestedCapabilities,
  allowed: RequestedCapabilities,
): RequestedCapabilities {
  const both = (key: 'read' | 'write' | 'state' | 'net') =>
    requested[key].filter((value) => allowed[key].includes(value))
  const paths = {
    read: both('read'),
    write: both('write'),
    state: both('state'),
    net: both('net'),
  }
  // A grant kept from before capability access existed allows none of it.
  return requested.instances
    ? {
        ...paths,
        instances: grantedInstances(
          requested.instances,
          allowed.instances ?? [],
        ),
      }
    : paths
}

/** SHA-256 over the manifest and the page, so either changing asks again. */
export async function moduleDigest(
  manifest: string,
  source: string,
): Promise<string> {
  const bytes = new TextEncoder().encode(`${manifest}\u0000${source}`)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/** True when everything `requested` asks for is also in `allowed`. */
export function capabilitiesWithin(
  requested: RequestedCapabilities,
  allowed: RequestedCapabilities,
): boolean {
  const kept = granted(requested, allowed)
  const keys = ['read', 'write', 'state', 'net'] as const
  if (keys.some((key) => kept[key].length !== requested[key].length))
    return false
  const asked = requested.instances ?? []
  const given = kept.instances ?? []
  return (
    asked.length === given.length &&
    asked.every((one, i) => {
      const got = given[i]
      return (
        got !== undefined &&
        got.instanceId === one.instanceId &&
        got.methods.length === one.methods.length &&
        got.actions.length === one.actions.length
      )
    })
  )
}

/** What `next` asks for that `previous` did not (a permission expansion). */
export function addedCapabilities(
  previous: RequestedCapabilities,
  next: RequestedCapabilities,
): RequestedCapabilities {
  const fresh = (key: 'read' | 'write' | 'state' | 'net') =>
    next[key].filter((value) => !previous[key].includes(value))
  const instances = (next.instances ?? []).flatMap((one) => {
    const before = previous.instances?.find(
      (p) => p.instanceId === one.instanceId,
    )
    const methods = one.methods.filter((m) => !before?.methods.includes(m))
    const actions = one.actions.filter((a) => !before?.actions.includes(a))
    return methods.length || actions.length
      ? [{ instanceId: one.instanceId, methods, actions }]
      : []
  })
  return {
    read: fresh('read'),
    write: fresh('write'),
    state: fresh('state'),
    net: fresh('net'),
    ...(instances.length ? { instances } : {}),
  }
}

/** Whether a request names anything at all. */
export const asksForNothing = (requested: RequestedCapabilities) =>
  requested.read.length +
    requested.write.length +
    requested.state.length +
    requested.net.length ===
    0 && !(requested.instances?.length ?? 0)

/**
 * A host-managed policy that lets future revisions of one module run inside a
 * declared scope (EXEC-02). It is a separate, explicit grant: it is not a
 * digest-bound grant carried over, and a person gives it on purpose.
 */
export interface RevisionPolicy {
  scope: RequestedCapabilities
  grantedAt: number
}

export const useRevisionPolicies = create<{
  policies: Record<string, RevisionPolicy>
  allow: (key: string, policy: RevisionPolicy) => void
  withdraw: (key: string) => void
}>()(
  persist(
    (set) => ({
      policies: {},
      allow: (key, policy) =>
        set((s) => ({ policies: { ...s.policies, [key]: policy } })),
      withdraw: (key) =>
        set((s) => {
          const { [key]: _, ...rest } = s.policies
          return { policies: rest }
        }),
    }),
    {
      name: 'theorem-ui:module-revision-policies',
      version: 1,
      partialize: ({ policies }) => ({ policies }),
    },
  ),
)

/** Why a release may or may not run with what it asks for. */
export type Authority =
  | { kind: 'granted'; by: 'digest' | 'policy' | 'nothing-requested' }
  | {
      kind: 'needs-grant'
      /** What is new against the release before it; everything, when none is known. */
      added: RequestedCapabilities
      reason: 'new-digest' | 'expanded' | 'first-release'
    }

/**
 * Whether this exact release is authorized. A digest-bound grant covers only
 * its own digest and is never copied to another one. A different digest runs
 * without a prompt only under an explicit revision policy that holds
 * everything it asks for, or when it asks for nothing. Otherwise it needs the
 * grant path, and `added` says what is new against the release before it.
 */
export function authorityFor(input: {
  grant: Grant | undefined
  policy: RevisionPolicy | undefined
  digest: string
  requested: RequestedCapabilities
  previousRequested?: RequestedCapabilities
}): Authority {
  const { grant, policy, digest, requested, previousRequested } = input
  if (asksForNothing(requested))
    return { kind: 'granted', by: 'nothing-requested' }
  if (
    grant &&
    grant.digest === digest &&
    capabilitiesWithin(requested, grant.capabilities)
  )
    return { kind: 'granted', by: 'digest' }
  if (policy && capabilitiesWithin(requested, policy.scope))
    return { kind: 'granted', by: 'policy' }
  const added = previousRequested
    ? addedCapabilities(previousRequested, requested)
    : requested
  return {
    kind: 'needs-grant',
    added,
    reason: !previousRequested
      ? 'first-release'
      : asksForNothing(added)
        ? 'new-digest'
        : 'expanded',
  }
}
