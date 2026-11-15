// SOURCING: Theorem's session graph routes (Travis-Gilbert/Theorem#1075: rustyred-thg-server theorem_chat_sessions over theorem-harness-runtime theorem_chat_tree), reached through ./passthrough until the vendored SDK carries them; @tanstack/react-query for the cache. The shapes mirror the Rust structs field for field.
import {
  queryOptions,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query'
import { mutate } from './client'
import { organizationKey } from './organization'
import type { Organization, ThreadEntry } from './organization'
import { theoremJson } from './passthrough'

const BASE = '/api/chat/v1'

/** A chat in its fork tree, as `GET /threads/:id/tree` and the graph read describe it. */
export type SessionTreeNode = {
  threadId: string
  title: string
  projectId: string
  status: 'regular' | 'archived' | 'deleted'
  createdAtMs: number
  lastMessageAtMs?: number
  activeRunId?: string
  /** Provenance: the chat this one was forked from. */
  forkedFromThreadId?: string
  /** Authority: this chat's parent when the tree is rooted at its main. */
  authorityParentThreadId?: string
  /** Fork edges between this chat and the main. */
  depth: number
  isMain: boolean
  isOrigin: boolean
  /** In a project graph, whether the chat belongs to the project. */
  inScope: boolean
}

/** How the tree's main was decided. */
export type MainResolution = 'origin' | 'chosen' | 'fallback' | 'none'

export type SessionTree = {
  schema: string
  treeId: string
  originThreadId: string
  mainThreadId?: string
  chosenMainThreadId?: string
  mainResolution: MainResolution
  revision: number
  updatedAtMs?: number
  nodes: SessionTreeNode[]
}

export type SessionConnection = {
  kind: 'continued' | 'message'
  fromThreadId: string
  toThreadId: string
  /** For messages: whether any of them spoke for the person. */
  voice?: 'session' | 'user'
  count: number
  lastAtMs: number
}

export type SessionOutput = {
  outputId: string
  kind: string
  title: string
  threadId: string
  artifactId?: string
  documentId?: string
  updatedAtMs: number
}

export type ToolUse = { name: string; calls: number; failed: number }

export type GraphScope =
  { kind: 'project'; projectId: string } | { kind: 'tree'; treeId: string }

export type SessionGraphRead = {
  schema: string
  scope: GraphScope
  trees: SessionTree[]
  connections: SessionConnection[]
  artifacts: Record<string, SessionOutput[]>
  documents: Record<string, SessionOutput[]>
  tools: Record<string, ToolUse[]>
  notServed: { facet: string; reason: string }[]
}

/** The `?sessions=` value a graph is opened by: `project:<id>` or `tree:<any chat of it>`. */
export const scopeParam = (scope: GraphScope) =>
  scope.kind === 'project'
    ? `project:${scope.projectId}`
    : `tree:${scope.treeId}`

export function parseScope(value: unknown): GraphScope | undefined {
  if (typeof value !== 'string') return undefined
  const at = value.indexOf(':')
  const kind = value.slice(0, at)
  const id = value.slice(at + 1)
  if (at < 1 || !id) return undefined
  if (kind === 'project') return { kind, projectId: id }
  if (kind === 'tree') return { kind, treeId: id }
  return undefined
}

export const sessionGraphKey = ['theorem', 'session-graph'] as const

export const sessionGraphQuery = (scope: GraphScope) =>
  queryOptions({
    queryKey: [...sessionGraphKey, scopeParam(scope)],
    queryFn: () =>
      theoremJson<SessionGraphRead>(
        `${BASE}/session-graph?${
          scope.kind === 'project'
            ? `projectId=${encodeURIComponent(scope.projectId)}`
            : `treeId=${encodeURIComponent(scope.treeId)}`
        }`,
      ),
  })

/**
 * Makes a chat its tree's main: the tree is re-rooted at it, and it may then
 * message the others on the person's behalf. The revision the person saw goes
 * with it, so a choice made elsewhere meanwhile is refused, not overwritten.
 */
export function useMakeMain() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({
      threadId,
      expectedRevision,
    }: {
      threadId: string
      expectedRevision?: number
    }) =>
      mutate((headers) =>
        theoremJson<{ tree: SessionTree }>(
          `${BASE}/threads/${encodeURIComponent(threadId)}/main`,
          { method: 'POST', body: { expectedRevision }, headers },
        ),
      ),
    onSettled: () =>
      Promise.all([
        client.invalidateQueries({ queryKey: sessionGraphKey }),
        client.invalidateQueries({ queryKey: organizationKey }),
      ]),
  })
}

/**
 * Whether a session has a graph worth opening: it was forked or continued
 * from another, or another was from it. Session messages only pass inside a
 * fork tree, so a session with connections always has a fork to show.
 */
export function inSessionGraph(
  read: Pick<Organization, 'threads'>,
  threadId: string,
): boolean {
  return read.threads.some(
    (thread) =>
      thread.origin !== undefined &&
      thread.origin.threadId !== thread.threadId &&
      (thread.threadId === threadId || thread.origin.threadId === threadId),
  )
}

/** Whether any session filed in the project has a graph worth opening. */
export function projectHasSessionGraph(
  read: Pick<Organization, 'threads'>,
  projectId: string,
): boolean {
  const members = new Set(
    read.threads
      .filter((t: ThreadEntry) =>
        t.memberships.some((m) => m.projectId === projectId),
      )
      .map((t) => t.threadId),
  )
  return read.threads.some(
    (thread) =>
      thread.origin !== undefined &&
      thread.origin.threadId !== thread.threadId &&
      (members.has(thread.threadId) || members.has(thread.origin.threadId)),
  )
}
