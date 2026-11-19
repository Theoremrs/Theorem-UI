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
  /** Where the skill comes from, when an MCP server serves it (SEP-2640).
   * The id then carries the connection, so two servers' identically named
   * skills stay distinct. Absent for native packs and documents. */
  source?: {
    kind: 'mcp'
    connection: string
    uri: string
    dynamic: boolean
  }
}

type SkillsBody = {
  plugins?: (PluginEntry & { description?: string | null })[]
  skills?: (Omit<SkillEntry, 'plugin'> & {
    plugin?: string | null
    source?: SkillEntry['source'] | null
  })[]
}

export const catalogQuery = queryOptions({
  queryKey: ['theorem', 'skills'],
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

const NONE = { plugins: [] as PluginEntry[], skills: [] as SkillEntry[] }

/** Plugins and skills this person's turns can load; empty until Theorem answers. */
export function useCatalogEntries() {
  const { data = NONE, error } = useQuery(catalogQuery)
  return { ...data, error }
}
