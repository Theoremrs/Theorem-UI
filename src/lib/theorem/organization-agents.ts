// SOURCING: @tanstack/react-query (reads and writes), zustand with persist (which agent the composer talks to), lib/theorem/client's mutate (CSRF and idempotency headers), lib/theorem/passthrough's theoremJson (the organization routes the vendored SDK does not wrap yet). Theorem's organization record owns the agents, their lineage and knowledge bindings, packages and evaluation reports (Unified Agent Experience Gates 4 and 5); this file only reads and writes them.
import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { agentIdentityKey } from './agent-profile'
import type { AgentProfile } from './agent-profile'
import { mutate } from './client'
import { isNotServed, theoremJson } from './passthrough'

const ORGANIZATION = '/v1/theorem/organization'
const AGENTS = `${ORGANIZATION}/agents`

export type RetrievalFeature =
  'lexical' | 'vector' | 'graph_traversal' | 'recency'

export interface KnowledgeBinding {
  provider?: string | null
  required?: RetrievalFeature[]
}

export type BindingResolution =
  | {
      state: 'resolved'
      provider: string
      source: 'explicit' | 'host' | 'default'
    }
  | { state: 'failed'; binding: KnowledgeBinding; reason: string }

export interface LineageEntry {
  kind: 'imported_copy' | 'copied'
  source_agent_id: string
  package_hash?: string | null
  source_organization_revision?: number | null
}

export interface OrganizationAgent {
  agent_id: string
  primary: boolean
  profile: AgentProfile | null
  lineage: LineageEntry[]
  knowledge: KnowledgeBinding
  knowledge_resolution: BindingResolution
}

export type OrganizationAgents =
  | {
      served: true
      revision: number
      multipleAgents: boolean
      agents: OrganizationAgent[]
    }
  /** This Theorem predates organization agents. */
  | { served: false }

interface OrganizationRecord {
  revision: number
  settings?: { multiple_agents?: boolean }
  agents?: OrganizationAgent[]
}

function agentsOf(record: OrganizationRecord): OrganizationAgents {
  if (!Array.isArray(record.agents)) return { served: false }
  return {
    served: true,
    revision: record.revision,
    multipleAgents: Boolean(record.settings?.multiple_agents),
    agents: record.agents,
  }
}

export async function readOrganizationAgents(): Promise<OrganizationAgents> {
  try {
    return agentsOf(await theoremJson<OrganizationRecord>(ORGANIZATION))
  } catch (error) {
    if (isNotServed(error)) return { served: false }
    throw error
  }
}

export const organizationAgentsKey = ['theorem', 'organization-agents'] as const

export const organizationAgentsQuery = () =>
  queryOptions({
    queryKey: organizationAgentsKey,
    queryFn: readOrganizationAgents,
    staleTime: 30_000,
  })

export function useOrganizationAgents() {
  return useQuery(organizationAgentsQuery())
}

/** The name a reader shows for an agent: its profile's, else the primary's default. */
export function agentName(agent: OrganizationAgent): string {
  return agent.profile?.name ?? (agent.primary ? 'Theo' : agent.agent_id)
}

/** One line on where an agent came from, or undefined for one made here. */
export function lineageLine(agent: OrganizationAgent): string | undefined {
  const entry = agent.lineage[0]
  if (!entry) return undefined
  const from = entry.kind === 'imported_copy' ? 'Imported copy of' : 'Copy of'
  return `${from} ${entry.source_agent_id}`
}

/** One line on how the agent's knowledge binding resolves on this host. */
export function resolutionLine(resolution: BindingResolution): string {
  if (resolution.state === 'failed') return resolution.reason
  const how =
    resolution.source === 'explicit'
      ? 'chosen'
      : resolution.source === 'host'
        ? 'supplied by this host'
        : 'the default'
  return `Knowledge in ${resolution.provider}, ${how}`
}

// ── which agent the composer talks to ───────────────────────────────────────

export const useChosenAgent = create<{
  /** A further agent's id; null talks to the primary. */
  agentId: string | null
  choose: (agentId: string | null) => void
}>()(
  persist((set) => ({ agentId: null, choose: (agentId) => set({ agentId }) }), {
    name: 'theorem.chosen-agent',
  }),
)

/** What a send declares of the chosen agent: nothing for the primary. */
export function agentTurnOptions(): { agent?: string } {
  const { agentId } = useChosenAgent.getState()
  return agentId ? { agent: agentId } : {}
}

// ── writes ──────────────────────────────────────────────────────────────────

async function write<T>(
  path: string,
  method: string,
  body?: unknown,
): Promise<T> {
  return mutate((headers) => theoremJson<T>(path, { method, body, headers }))
}

type Write = { expectedRevision: number }

/** A write that returns the organization: refresh both caches from it. */
function useOrganizationWrite<TVariables extends Write>(
  run: (variables: TVariables) => Promise<OrganizationRecord>,
) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: run,
    onSuccess: (record) => {
      client.setQueryData(organizationAgentsKey, agentsOf(record))
      void client.invalidateQueries({ queryKey: agentIdentityKey })
    },
    // A refused write (above all a 409) means the cached record is behind.
    onError: () =>
      client.invalidateQueries({ queryKey: organizationAgentsKey }),
  })
}

export function useSaveOrganizationSettings() {
  return useOrganizationWrite(
    ({
      multipleAgents,
      expectedRevision,
    }: Write & { multipleAgents: boolean }) =>
      write(`${ORGANIZATION}/settings`, 'PUT', {
        settings: { multiple_agents: multipleAgents },
        expected_revision: expectedRevision,
      }),
  )
}

export function useCreateAgent() {
  return useOrganizationWrite(
    ({ profile, expectedRevision }: Write & { profile: AgentProfile }) =>
      write(AGENTS, 'POST', { profile, expected_revision: expectedRevision }),
  )
}

export function useSaveAgentProfileOf() {
  return useOrganizationWrite(
    ({
      agentId,
      profile,
      expectedRevision,
    }: Write & { agentId: string; profile: AgentProfile }) =>
      write(`${AGENTS}/${encodeURIComponent(agentId)}/profile`, 'PUT', {
        profile,
        expected_revision: expectedRevision,
      }),
  )
}

export function useSaveAgentKnowledge() {
  return useOrganizationWrite(
    ({
      agentId,
      knowledge,
      expectedRevision,
    }: Write & { agentId: string; knowledge: KnowledgeBinding }) =>
      write(`${AGENTS}/${encodeURIComponent(agentId)}/knowledge`, 'PUT', {
        knowledge,
        expected_revision: expectedRevision,
      }),
  )
}

export function useRemoveAgent() {
  const chosen = useChosenAgent()
  return useOrganizationWrite(
    async ({ agentId, expectedRevision }: Write & { agentId: string }) => {
      const record = await write<OrganizationRecord>(
        `${AGENTS}/${encodeURIComponent(agentId)}?expected_revision=${expectedRevision}`,
        'DELETE',
      )
      if (chosen.agentId === agentId) chosen.choose(null)
      return record
    },
  )
}

// ── memory, export and import ───────────────────────────────────────────────

export interface AgentMemoryEntry {
  id: string
  kind: string
  title: string
  created_at?: string
  links?: string[]
}

export function useAgentMemories(agentId: string | null) {
  return useQuery({
    queryKey: [...organizationAgentsKey, 'memories', agentId] as const,
    enabled: Boolean(agentId),
    queryFn: () =>
      theoremJson<{ agent_id: string; memories: AgentMemoryEntry[] }>(
        `${AGENTS}/${encodeURIComponent(agentId ?? '')}/memories`,
      ),
  })
}

/** A theorem.agent-package document. Its Rust type owns the shape. */
export interface AgentPackage {
  format: string
  mode: 'template' | 'selected_memory' | 'checkpoint'
  package_hash: string
  agent: { agent_id: string; profile?: AgentProfile | null }
  memory?: { id: string; title: string }[]
  dependencies?: {
    kind: string
    reference: string
    required: boolean
    included: boolean
  }[]
  [field: string]: unknown
}

export function exportAgent(
  agentId: string,
  memoryIds: string[],
): Promise<AgentPackage> {
  return write(`${AGENTS}/${encodeURIComponent(agentId)}/export`, 'POST', {
    mode: memoryIds.length ? 'selected_memory' : 'template',
    memory_ids: memoryIds,
  })
}

/** The file name an export downloads as. */
export function packageFileName(agentPackage: AgentPackage): string {
  const name = (agentPackage.agent.profile?.name ?? 'agent')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
  return `${name || 'agent'}.theorem-agent.json`
}

export interface MissingBinding {
  kind: string
  reference: string
  detail: string
  blocking: boolean
}

export interface ImportCheck {
  ready: boolean
  missing: MissingBinding[]
  multiple_agents?: boolean
  mode?: string
  memories?: number
  knowledge_resolution?: BindingResolution
}

/** Read a chosen file as a package. A file that is not one is refused here. */
export function parsePackage(text: string): AgentPackage {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new Error('That file is not JSON.')
  }
  if (
    !value ||
    typeof value !== 'object' ||
    (value as { format?: unknown }).format !== 'theorem.agent-package'
  )
    throw new Error('That file is not a Theorem agent package.')
  return value as AgentPackage
}

export function checkImport(agentPackage: AgentPackage): Promise<ImportCheck> {
  return write(`${AGENTS}/import/check`, 'POST', { package: agentPackage })
}

export function useImportAgent() {
  return useOrganizationWrite(
    ({
      agentPackage,
      expectedRevision,
    }: Write & { agentPackage: AgentPackage }) =>
      write(`${AGENTS}/import`, 'POST', {
        package: agentPackage,
        expected_revision: expectedRevision,
      }),
  )
}

// ── knowledge providers and evaluation ──────────────────────────────────────

export interface ProviderDescriptor {
  id: string
  label: string
  roles: string[]
  capabilities: {
    retrieval: RetrievalFeature[]
    mutation: boolean
    history: boolean
    export: boolean
  }
  host_supplied?: boolean
}

export function useKnowledgeProviders() {
  return useQuery({
    queryKey: [...organizationAgentsKey, 'providers'] as const,
    queryFn: () =>
      theoremJson<{
        providers: ProviderDescriptor[]
        host_supplied: string | null
      }>(`${ORGANIZATION}/knowledge/providers`),
    staleTime: 60_000,
  })
}

export interface EvaluationCandidate {
  label: string
  provider: string
  limit?: number
}

export interface EvaluationReport {
  agent_id: string
  base_organization_revision: number
  snapshot_hash: string
  snapshot_documents: number
  kind: 'storage_only' | 'configuration'
  differences: string[]
  source_unchanged: boolean
  candidates: {
    label: string
    provider: ProviderDescriptor
    limit: number
    mean_recall: number | null
    mean_latency_us: number
    documents_after: number
    queries: {
      query: string
      returned: string[]
      expected: string[]
      recall: number | null
    }[]
  }[]
}

export function runEvaluation(
  agentId: string,
  candidates: EvaluationCandidate[],
  queries: string[],
): Promise<EvaluationReport> {
  return write(`${AGENTS}/${encodeURIComponent(agentId)}/evaluations`, 'POST', {
    candidates,
    workload: queries.map((query) => ({ query })),
  })
}

/** Recall as a percentage, or a dash when nothing was expected. */
export function percent(value: number | null): string {
  return value === null ? '–' : `${Math.round(value * 100)}%`
}
