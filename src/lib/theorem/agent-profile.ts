// SOURCING: @tanstack/react-query (read and save), lib/theorem/passthrough's theoremJson (the native organization routes the SDK does not wrap yet). The record is Theorem's organization (GET /v1/theorem/organization, PUT /v1/theorem/organization/profile); this file only reads and writes it (Unified Agent Experience Gate 0 decision 2, ownership map section 5).
import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { isNotServed, theoremJson } from './passthrough'

const ORGANIZATION = '/v1/theorem/organization'

export type RepresentationKind = 'theo' | 'character' | 'terminal' | 'mark'

export const REPRESENTATION_KINDS: readonly {
  kind: RepresentationKind
  label: string
}[] = [
  { kind: 'theo', label: 'Theo' },
  { kind: 'character', label: 'Character' },
  { kind: 'terminal', label: 'Terminal design' },
  { kind: 'mark', label: 'Simple mark' },
]

/** The agent's user-authored profile (AG-01). Presentation and preference only (AG-02). */
export interface AgentProfile {
  name: string
  description?: string
  representation: { kind: RepresentationKind; reference?: string | null }
  characteristics?: string[]
  working_preferences?: string[]
  instruction_refs?: string[]
}

/** The part of the organization record this client reads. */
export interface AgentOrganization {
  organization_id: string
  agent_id: string
  revision: number
  content_hash: string
  profile?: AgentProfile | null
}

export type AgentIdentity =
  | {
      served: true
      agentId: string
      revision: number
      /** Null until someone saves a profile; the default representation shows meanwhile. */
      profile: AgentProfile | null
    }
  /** This Theorem predates the organization route or the profile on it. */
  | { served: false }

/** Bounds the authority enforces; the form keeps to them so a save is not refused. */
export const PROFILE_LIMITS = {
  name: 80,
  description: 280,
  entries: 12,
  entry: 200,
  reference: 200,
} as const

export const DEFAULT_PROFILE: AgentProfile = {
  name: 'Theo',
  representation: { kind: 'theo' },
}

function identityOf(organization: AgentOrganization): AgentIdentity {
  return {
    served: true,
    agentId: organization.agent_id,
    revision: organization.revision,
    profile: organization.profile ?? null,
  }
}

export async function readAgentIdentity(): Promise<AgentIdentity> {
  try {
    return identityOf(await theoremJson<AgentOrganization>(ORGANIZATION))
  } catch (error) {
    if (isNotServed(error)) return { served: false }
    throw error
  }
}

export const agentIdentityKey = ['theorem', 'agent-identity'] as const

export const agentIdentityQuery = () =>
  queryOptions({
    queryKey: agentIdentityKey,
    queryFn: readAgentIdentity,
    staleTime: 60_000,
  })

export function useAgentIdentity() {
  return useQuery(agentIdentityQuery())
}

/** The profile a reader shows: the saved one, else Theo. */
export function shownProfile(
  identity: AgentIdentity | undefined,
): AgentProfile {
  return (identity?.served && identity.profile) || DEFAULT_PROFILE
}

/** Lines of a text area as list entries: trimmed, empty lines dropped. */
export function entriesOf(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

/** Why a draft would be refused, in the words the form shows; undefined when it is fine. */
export function profileProblem(profile: AgentProfile): string | undefined {
  const name = profile.name.trim()
  if (!name) return 'Give the agent a name.'
  if (name.length > PROFILE_LIMITS.name)
    return `Keep the name to ${PROFILE_LIMITS.name} characters.`
  if ((profile.description ?? '').length > PROFILE_LIMITS.description)
    return `Keep the description to ${PROFILE_LIMITS.description} characters.`
  for (const [field, label] of [
    ['characteristics', 'characteristics'],
    ['working_preferences', 'working preferences'],
    ['instruction_refs', 'instruction references'],
  ] as const) {
    const entries = profile[field] ?? []
    if (entries.length > PROFILE_LIMITS.entries)
      return `List at most ${PROFILE_LIMITS.entries} ${label}.`
    if (entries.some((entry) => entry.length > PROFILE_LIMITS.entry))
      return `Keep each of the ${label} to ${PROFILE_LIMITS.entry} characters.`
  }
  if (
    (profile.representation.reference ?? '').length > PROFILE_LIMITS.reference
  )
    return `Keep the representation reference to ${PROFILE_LIMITS.reference} characters.`
  return undefined
}

export async function saveAgentProfile(
  profile: AgentProfile,
  expectedRevision: number,
): Promise<AgentIdentity> {
  return identityOf(
    await theoremJson<AgentOrganization>(`${ORGANIZATION}/profile`, {
      method: 'PUT',
      body: { profile, expected_revision: expectedRevision },
    }),
  )
}

/**
 * Save the profile against the revision the form was read at, so a change
 * made elsewhere meanwhile is refused rather than overwritten (409).
 */
export function useSaveAgentProfile() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({
      profile,
      expectedRevision,
    }: {
      profile: AgentProfile
      expectedRevision: number
    }) => saveAgentProfile(profile, expectedRevision),
    onSuccess: (saved) => client.setQueryData(agentIdentityKey, saved),
  })
}
