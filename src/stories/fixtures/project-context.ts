// SOURCING: Theorem's project context routes as docs/plans/project-context/CONTRACT.md states them (revision 0 before the first write, If-Match on every write, 409/428/422 refusals), the chat Library's listing (GET /api/chat/v1/library) over the story's own notes and uploads, and the Connections routes' list, GitHub and tool roster shapes (lib/theorem/connections), so the composer's Connections chip shows the project's choice. Kept in memory so a story can add and remove context and see it stay.
import type {
  Connection,
  ConnectionList,
  GithubConnection,
  ToolGroup,
} from '@/lib/theorem/connections'
import { titleOf } from '@/lib/theorem/notes'
import type {
  LibraryItem,
  ProjectContext,
  ProjectContextBody,
} from '@/lib/theorem/project-context'
import type { FakeRoutes } from '../fake-theorem'
import { documentFixtures, uploadFixtures } from './notes'

const BASE = '/api/chat/v1'

const problem = (
  status: number,
  code: string,
  title: string,
  detail?: string,
) =>
  new Response(JSON.stringify({ code, title, detail, status }), {
    status,
    headers: { 'content-type': 'application/problem+json' },
  })

const UPLOAD_TITLES: Record<string, string> = {
  'upload-paper': 'Spaces and their notes.pdf',
  'upload-tone': 'Reference tone.mp3',
  'upload-clip': 'Walkthrough.mp4',
  'upload-icon': 'app-icon.svg',
}

const ok = { state: 'ok' } as const

export const storyConnections: Connection[] = [
  {
    id: 'github',
    kind: 'github',
    label: 'GitHub',
    status: 'connected',
    enabled: true,
    account: { label: 'theorem-story' },
    health: ok,
  },
  {
    id: 'google_gmail',
    kind: 'google',
    label: 'Gmail',
    status: 'connected',
    enabled: true,
    health: ok,
  },
  {
    id: 'google_drive',
    kind: 'google',
    label: 'Google Drive',
    status: 'needs_auth',
    enabled: true,
    health: { state: 'unknown' },
  },
  {
    id: 'mcp:linear',
    kind: 'mcp',
    label: 'Linear',
    status: 'connected',
    enabled: true,
    health: ok,
  },
]

const STORY_TOOLS: Record<string, string[]> = {
  github: ['search_issues', 'create_issue'],
  google_gmail: ['search_messages', 'send_message'],
  google_drive: ['search_files'],
  'mcp:linear': ['search_issues', 'create_issue'],
}

const repo = (id: number, fullName: string, tracked: boolean) => ({
  id,
  fullName,
  private: false,
  tracked,
})

export function storyGithub(): GithubConnection {
  return {
    ...storyConnections[0]!,
    installations: [
      {
        id: 1,
        account: 'theorem-story',
        repositorySelection: 'selected',
        repos: [
          repo(11, 'theorem-story/theorem', true),
          repo(12, 'theorem-story/theorem-ui', true),
          repo(13, 'theorem-story/platinum', true),
          repo(14, 'theorem-story/scratch', false),
        ],
      },
    ],
    availableActions: [],
    subscribedEvents: [],
    webhook: {
      configured: true,
      counts: { received: 0, processed: 0, pending: 0, failed: 0 },
    },
  }
}

/** The Library the story's projects can pick from: its notes, its uploads, and one source that failed. */
export function storyLibrary(projectId: string, now: number): LibraryItem[] {
  const notes = Object.entries(documentFixtures).map(
    ([id, markdown], index): LibraryItem => ({
      kind: 'graph_document',
      id,
      title: titleOf(markdown),
      revision: 1,
      updatedAtMs: now - index * 60_000,
      usable: true,
      reference: { kind: 'graph_document', id },
      detail: {},
    }),
  )
  const uploads = Object.keys(uploadFixtures).map((id, index): LibraryItem => ({
    kind: 'upload',
    id,
    title: UPLOAD_TITLES[id] ?? id,
    projectId,
    revision: 1,
    updatedAtMs: now - (index + 20) * 60_000,
    usable: true,
    reference: { kind: 'upload', id },
    detail: { mime: uploadFixtures[id]?.mime },
  }))
  const failed: LibraryItem = {
    kind: 'upload',
    id: 'upload-failed',
    title: 'Scanned contract.pdf',
    projectId,
    revision: 1,
    updatedAtMs: now - 90 * 60_000,
    usable: false,
    reference: { kind: 'upload', id: 'upload-failed' },
    detail: { state: 'failed' },
  }
  return [...notes, ...uploads, failed]
}

const SEEDED: Record<string, ProjectContextBody> = {
  'project-theorem': {
    documents: [
      {
        reference: { kind: 'graph_document', id: 'doc-track' },
        title: 'Source track',
      },
      {
        reference: { kind: 'upload', id: 'upload-paper' },
        title: 'Spaces and their notes.pdf',
      },
    ],
    repositories: [{ fullName: 'theorem-story/theorem' }],
    links: [
      {
        url: 'https://example.com/spec/project-context',
        title: 'Project context spec',
      },
      { url: 'https://example.com/notes/ownership' },
    ],
    connections: ['github', 'mcp:linear'],
  },
}

const KEYS = ['documents', 'repositories', 'links', 'connections'] as const

/**
 * GET and PUT a project's context, the Library, and the connections it names,
 * answered as the contract says so the column's editors run against the real
 * client code.
 */
export function projectContextRoutes(now: number): FakeRoutes {
  const contexts = new Map<string, ProjectContext>()
  const read = (projectId: string): ProjectContext =>
    contexts.get(projectId) ?? {
      schema: 'theorem-chat-project-context/1',
      projectId,
      revision: SEEDED[projectId] ? 1 : 0,
      ...(SEEDED[projectId] ?? {
        documents: [],
        repositories: [],
        links: [],
        connections: null,
      }),
      updatedAtMs: now - 3 * 60 * 60_000,
    }
  const github = storyGithub()
  const tracked = github.installations.flatMap((i) =>
    i.repos.filter((r) => r.tracked).map((r) => r.fullName.toLowerCase()),
  )
  const withTag = (context: ProjectContext) =>
    new Response(JSON.stringify(context), {
      headers: {
        'content-type': 'application/json',
        etag: `"${context.revision}"`,
      },
    })

  return {
    [`GET ${BASE}/projects/:projectId/context`]: ({ projectId = '' }) =>
      withTag(read(decodeURIComponent(projectId))),
    [`PUT ${BASE}/projects/:projectId/context`]: async (
      { projectId = '' },
      request,
    ) => {
      const id = decodeURIComponent(projectId)
      const current = read(id)
      const match = request.headers.get('if-match')
      if (match === null)
        return problem(
          428,
          'project_context_revision_required',
          'If-Match is required',
        )
      if (Number(match.replaceAll('"', '')) !== current.revision)
        return problem(
          409,
          'chat_revision_conflict',
          'The project context changed',
        )
      const body = (await request.json()) as Record<string, unknown>
      const unknown = Object.keys(body).filter(
        (key) => !(KEYS as readonly string[]).includes(key),
      )
      if (unknown.length)
        return problem(
          422,
          'project_context_invalid',
          'Unknown field',
          unknown[0],
        )
      const next = body as ProjectContextBody
      const untracked = next.repositories.find(
        (r) => !tracked.includes(r.fullName.toLowerCase()),
      )
      if (untracked)
        return problem(
          422,
          'project_context_repository_untracked',
          'Theorem does not track that repository',
          untracked.fullName,
        )
      const unreadable = next.documents.find(
        (d) => d.reference.id === 'upload-failed',
      )
      if (unreadable)
        return problem(
          422,
          'project_context_reference_unreadable',
          'That source cannot be read',
          unreadable.title,
        )
      const saved: ProjectContext = {
        ...current,
        ...next,
        revision: current.revision + 1,
        updatedAtMs: Date.now(),
      }
      contexts.set(id, saved)
      return withTag(saved)
    },
    [`GET ${BASE}/library`]: (_, request) => ({
      items: storyLibrary(
        new URL(request.url).searchParams.get('projectId') ?? 'project-theorem',
        now,
      ),
    }),
    'GET /api/connections/v1': (): ConnectionList => ({
      connections: storyConnections,
      stdioAvailable: false,
    }),
    'GET /api/connections/v1/github': () => github,
    'GET /api/connections/v1/tools': (): { groups: ToolGroup[] } => ({
      groups: storyConnections.map((connection) => ({
        connectionId: connection.id,
        label: connection.label,
        kind: connection.kind,
        enabled: connection.enabled,
        tools: (STORY_TOOLS[connection.id] ?? []).map((name) => ({
          name,
          effect:
            name.startsWith('create') || name.startsWith('send')
              ? 'write'
              : 'read',
        })),
      })),
    }),
  }
}
