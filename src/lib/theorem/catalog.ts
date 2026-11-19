// SOURCING: @tanstack/react-query (the plugins and skills Theorem serves at /api/chat/v1/skills, through lib/theorem/passthrough)
import { queryOptions, useQuery } from '@tanstack/react-query'
import { isNotServed, theoremJson } from './passthrough'

export type PluginEntry = {
  id: string
  name: string
  description?: string
  skillCount?: number
}

export type SkillEntry = {
  id: string
  name: string
  description?: string
  /** The owning plugin's name, absent for a standalone skill. */
  plugin?: string
  /** Provenance stays attached to imported and MCP-served skills. */
  source?:
    | {
        kind: 'mcp'
        connection: string
        connectionLabel?: string
        uri: string
        dynamic: boolean
      }
    | {
        kind: 'import'
        installationId: string | null
        source: string | null
        version: string | null
      }
}

type SkillsBody = {
  plugins?: (PluginEntry & { description?: string | null })[]
  skills?: (Omit<SkillEntry, 'plugin'> & {
    plugin?: string | null
    source?: SkillEntry['source'] | null
  })[]
}

export const catalogKey = ['theorem', 'skills'] as const

export const catalogQuery = queryOptions({
  queryKey: catalogKey,
  queryFn: async () => {
    const body = await theoremJson<SkillsBody>('/api/chat/v1/skills')
    return {
      plugins: (body.plugins ?? []).map(({ description, ...plugin }) => ({
        ...plugin,
        ...(description ? { description } : {}),
      })),
      skills: (body.skills ?? []).map(({ plugin, source, ...skill }) => ({
        ...skill,
        ...(plugin ? { plugin } : {}),
        ...(source ? { source } : {}),
      })),
    }
  },
  staleTime: 5 * 60_000,
  retry: (count, error) => !isNotServed(error) && count < 2,
})

/** The source shown beside a name, so identically named skills remain distinguishable. */
export const skillOrigin = (
  skill: Pick<SkillEntry, 'plugin' | 'source'>,
): string | undefined =>
  skill.plugin ??
  (skill.source?.kind === 'mcp'
    ? (skill.source.connectionLabel ?? skill.source.connection)
    : (skill.source?.source ?? undefined))

const NONE = { plugins: [] as PluginEntry[], skills: [] as SkillEntry[] }

/** Plugins and skills this person's turns can load; empty until Theorem answers. */
export function useCatalogEntries() {
  const { data = NONE, error } = useQuery(catalogQuery)
  return { ...data, error }
}
