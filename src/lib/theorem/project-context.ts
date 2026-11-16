// SOURCING: @tanstack/react-query over lib/theorem/passthrough and client.mutate (the CSRF and idempotency headers every Theorem mutation carries), for routes the vendored SDK has no client for yet; the wire types are copied from Theorem's docs/plans/project-context/CONTRACT.md, and the Library's from GET /api/chat/v1/library (rustyred-thg-server theorem_chat_library). A revisioned edit is re-read and re-applied once on a conflict, as lib/theorem/spaces edits a Space.
import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { TheoremError } from '@theoremharness/sdk'
import { mutate } from './client'
import { isNotServed, theoremJson } from './passthrough'

/** A source a turn can read by reference: what the Library lists. */
export type ContextReference = {
  kind: 'upload' | 'graph_document' | 'record_view' | 'record'
  id: string
}

export type ContextDocument = { reference: ContextReference; title: string }
export type ContextRepository = { fullName: string }
export type ContextLink = { url: string; title?: string }

/** What a project gives every session in it, beside its instructions. */
export type ProjectContext = {
  schema: string
  projectId: string
  /** 0 for a project whose context was never written. */
  revision: number
  documents: ContextDocument[]
  repositories: ContextRepository[]
  links: ContextLink[]
  /** Null: every enabled connection. A list: only these. */
  connections: string[] | null
  updatedAtMs: number
}

export type ProjectContextBody = Pick<
  ProjectContext,
  'documents' | 'repositories' | 'links' | 'connections'
>

export type ProjectContextKind =
  'documents' | 'repositories' | 'links' | 'connections'

/** One Library entry; `reference` is what the project's context keeps. */
export type LibraryItem = {
  kind: ContextReference['kind']
  id: string
  title: string
  projectId?: string
  revision: number
  updatedAtMs: number
  /** Whether a turn can read it now. A failed or removed source is listed, never usable. */
  usable: boolean
  reference: ContextReference
  detail: Record<string, unknown>
}

/** The contract's bounds, checked here so a person sees them before Theorem refuses. */
export const CONTEXT_LIMITS = {
  documents: 32,
  repositories: 32,
  links: 64,
  connections: 64,
  titleBytes: 200,
  urlBytes: 2048,
} as const

const bytes = (text: string) => new TextEncoder().encode(text).length

const contextPath = (projectId: string) =>
  `/api/chat/v1/projects/${encodeURIComponent(projectId)}/context`

export const projectContextApi = {
  get: (projectId: string) =>
    theoremJson<ProjectContext>(contextPath(projectId)),
  put: (projectId: string, revision: number, body: ProjectContextBody) =>
    mutate((headers) =>
      theoremJson<ProjectContext>(contextPath(projectId), {
        method: 'PUT',
        headers: { ...headers, 'If-Match': String(revision) },
        body,
      }),
    ),
  library: (projectId: string) =>
    theoremJson<{ items: LibraryItem[] }>(
      `/api/chat/v1/library?${new URLSearchParams({ projectId })}`,
    ),
}

export const projectContextKey = (projectId: string) =>
  ['theorem', 'project-context', projectId] as const

export const projectContextQuery = (projectId: string) =>
  queryOptions({
    queryKey: projectContextKey(projectId),
    queryFn: () => projectContextApi.get(projectId),
    staleTime: 30_000,
    // A Theorem without the route, or a project it refuses, will not change on a retry.
    retry: false,
  })

export const useProjectContext = (projectId: string | undefined) =>
  useQuery({
    ...projectContextQuery(projectId ?? ''),
    enabled: projectId !== undefined,
  })

export const libraryQuery = (projectId: string) =>
  queryOptions({
    queryKey: ['theorem', 'library', projectId] as const,
    queryFn: async () => (await projectContextApi.library(projectId)).items,
    staleTime: 30_000,
  })

export const useLibrary = (projectId: string, enabled: boolean) =>
  useQuery({ ...libraryQuery(projectId), enabled })

const bodyOf = ({
  documents,
  repositories,
  links,
  connections,
}: ProjectContext): ProjectContextBody => ({
  documents,
  repositories,
  links,
  connections,
})

const isConflict = (error: unknown) =>
  error instanceof TheoremError && error.statusCode === 409

const problemCode = (error: unknown) =>
  error instanceof TheoremError && error.body && typeof error.body === 'object'
    ? (error.body as { code?: unknown }).code
    : undefined

/**
 * Why a project's context could not be read: a Theorem without the routes
 * answers a bare 404 (its router's fallback) or 405, while a missing project
 * is Theorem's own `chat_resource_not_found`.
 */
export function contextUnavailable(
  error: unknown,
): 'not-served' | 'no-project' | undefined {
  if (!isNotServed(error)) return undefined
  return problemCode(error) === 'chat_resource_not_found'
    ? 'no-project'
    : 'not-served'
}

/**
 * Applies an edit to the project's context as Theorem holds it. The edit is a
 * function of the current context, so one that loses a race is re-read and
 * applied again (once) instead of overwriting what someone else saved.
 */
export function useEditProjectContext(projectId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (
      edit: (context: ProjectContextBody) => ProjectContextBody,
    ) => {
      const attempt = async (fresh: boolean) => {
        const current = fresh
          ? await queryClient.fetchQuery({
              ...projectContextQuery(projectId),
              staleTime: 0,
            })
          : await queryClient.ensureQueryData(projectContextQuery(projectId))
        return projectContextApi.put(
          projectId,
          current.revision,
          edit(bodyOf(current)),
        )
      }
      try {
        return await attempt(false)
      } catch (error) {
        if (!isConflict(error)) throw error
        return attempt(true)
      }
    },
    onSuccess: (context) =>
      queryClient.setQueryData(projectContextKey(projectId), context),
  })
}

/** Why a link cannot be kept, or undefined when it can. */
export function linkProblem(url: string, title: string): string | undefined {
  const trimmed = url.trim()
  if (!trimmed) return 'Enter an address.'
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return 'Enter a full address, starting with https://.'
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')
    return 'Only http and https addresses can be kept.'
  if (bytes(trimmed) > CONTEXT_LIMITS.urlBytes)
    return 'That address is too long.'
  if (bytes(title.trim()) > CONTEXT_LIMITS.titleBytes)
    return 'That title is too long.'
  return undefined
}

/** The link as it is kept: trimmed, and without an empty title. */
export function keptLink(url: string, title: string): ContextLink {
  const name = title.trim()
  return name ? { url: url.trim(), title: name } : { url: url.trim() }
}

/** How a link reads in a list: its title, or the address without its scheme. */
export function linkLabel(link: ContextLink): string {
  if (link.title) return link.title
  try {
    const { host, pathname, search } = new URL(link.url)
    return `${host}${pathname === '/' ? '' : pathname}${search}`
  } catch {
    return link.url
  }
}

export const sameReference = (a: ContextReference, b: ContextReference) =>
  a.kind === b.kind && a.id === b.id

/** A repository's page on GitHub. */
export const repositoryUrl = (fullName: string) =>
  `https://github.com/${fullName.split('/').map(encodeURIComponent).join('/')}`

/** A document's label as the context keeps it: trimmed and within the contract's bound. */
export function documentTitle(title: string): string {
  const name = title.trim() || 'Untitled'
  if (bytes(name) <= CONTEXT_LIMITS.titleBytes) return name
  let cut = name
  while (bytes(`${cut}…`) > CONTEXT_LIMITS.titleBytes) cut = cut.slice(0, -1)
  return `${cut.trimEnd()}…`
}

/** Where a document opens, or undefined for a kind with no page of its own. */
export function documentHref(reference: ContextReference): string | undefined {
  switch (reference.kind) {
    case 'graph_document':
      return `/notes/${encodeURIComponent(reference.id)}`
    case 'upload':
      return `/api/chat/v1/uploads/${encodeURIComponent(reference.id)}/content`
    default:
      return undefined
  }
}
