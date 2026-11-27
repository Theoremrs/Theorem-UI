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
