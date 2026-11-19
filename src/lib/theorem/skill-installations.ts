// SOURCING: the native skill-installations API; React Query owns server state.
import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { mutate } from './client'
import { catalogKey } from './catalog'
import { theoremJson } from './passthrough'

export type SkillFile = {
  path: string
  content?: string
  base64?: string
  mimeType?: string
}
export type ImportedSkill = {
  name: string
  markdown: string
  files?: SkillFile[]
}
export type SkillImport = {
  source: string
  markdown?: string
  files?: SkillFile[]
  manifest?: Record<string, unknown>
  skills?: ImportedSkill[]
  connections?: Record<string, string>
  unsupported?: string[]
}
export type SkillInstallation = {
  installationId: string
  name: string
  source: string
  kind: 'skill' | 'plugin'
  version?: string | null
  revision: number
  status: 'ready' | 'needs_setup' | 'limited'
  skills: { id: string; name: string }[]
  connections: Record<string, string>
  requirements: {
    name: string
    connectionId?: string
    status: 'ready' | 'needs_setup'
  }[]
  unsupported: string[]
}

const path = '/api/chat/v1/skill-installations'
export const installationKeys = ['theorem', 'skill-installations'] as const
export const installationsApi = {
  list: () => theoremJson<{ installations: SkillInstallation[] }>(path),
  import: (body: SkillImport) =>
    mutate((headers) =>
      theoremJson<SkillInstallation>(path, { method: 'POST', headers, body }),
    ),
  setup: (id: string, connections: Record<string, string>) =>
    mutate((headers) =>
      theoremJson<SkillInstallation>(`${path}/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers,
        body: { connections },
      }),
    ),
  remove: (id: string) =>
    mutate((headers) =>
      theoremJson<{ removed: string; retired: string[]; preserved: string[] }>(
        `${path}/${encodeURIComponent(id)}`,
        { method: 'DELETE', headers },
      ),
    ),
}
export const installationsQuery = queryOptions({
  queryKey: installationKeys,
  queryFn: async () => (await installationsApi.list()).installations,
})
export const useSkillInstallations = () => useQuery(installationsQuery)

export function useSkillInstallationMutations() {
  const client = useQueryClient()
  const settle = () =>
    Promise.all([
      client.invalidateQueries({ queryKey: installationKeys }),
      client.invalidateQueries({ queryKey: catalogKey }),
    ])
  const install = useMutation({
    mutationFn: installationsApi.import,
    onSettled: settle,
  })
  const remove = useMutation({
    mutationFn: installationsApi.remove,
    onSettled: settle,
  })
  const setup = useMutation({
    mutationFn: ({
      id,
      connections,
    }: {
      id: string
      connections: Record<string, string>
    }) => installationsApi.setup(id, connections),
    onSettled: settle,
  })
  return { install, remove, setup }
}
