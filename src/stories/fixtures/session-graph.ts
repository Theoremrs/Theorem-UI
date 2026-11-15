// SOURCING: none: a fork tree in the Theorem project, typed against lib/theorem/sessions and lib/program/api so it cannot drift from the contract. Choosing a main re-roots the tree the way Theorem's theorem_chat_tree does (the path between the old and new main turns around, every other edge stays), and saved views are kept in memory, so the canvas can be scripted end to end.
import type { SavedSessionGraph, SessionGraphSummary } from '@/lib/program/api'
import type {
  SessionGraphRead,
  SessionTree,
  SessionTreeNode,
} from '@/lib/theorem/sessions'
import type { FakeRoutes } from '../fake-theorem'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const BASE = '/api/chat/v1'

type Chat = Omit<
  SessionTreeNode,
  'authorityParentThreadId' | 'depth' | 'isMain' | 'isOrigin'
>

const ok = (result: unknown) => ({ ok: true, result })
/** A tool's refusal, as lib/theorem/native's callTool reads it out of the envelope. */
const refusal = (code: string, message: string) => ({
  ok: false,
  result: { refusal: { code, message } },
})
const refuse = (status: number, code: string, title: string) =>
  new Response(JSON.stringify({ code, title }), {
    status,
    headers: { 'content-type': 'application/problem+json' },
  })

export function sessionGraphRoutes(now: number): FakeRoutes {
  const chat = (
    threadId: string,
    title: string,
    ageHours: number,
    extra: Partial<Chat> = {},
  ): Chat => ({
    threadId,
    title,
    projectId: 'project-theorem',
    status: 'regular',
    createdAtMs: now - ageHours * HOUR,
    lastMessageAtMs: now - (ageHours / 3) * HOUR,
    inScope: true,
    ...extra,
  })
  const ORIGIN = 'thread-graph-memory'
  const chats: Chat[] = [
    chat(ORIGIN, 'Graph memory', 30),
    chat('thread-graph-index', 'Index design', 26, {
      forkedFromThreadId: ORIGIN,
      activeRunId: 'run-index',
    }),
    chat('thread-graph-eviction', 'Eviction policy', 20, {
      forkedFromThreadId: ORIGIN,
    }),
    chat('thread-graph-bench', 'Index benchmarks', 12, {
      forkedFromThreadId: 'thread-graph-index',
    }),
    chat('thread-graph-ttl', 'TTL experiment', 9, {
      forkedFromThreadId: 'thread-graph-eviction',
      status: 'archived',
    }),
  ]
  let main = ORIGIN
  let revision = 0

  /** The fork tree rooted at the main: each chat's parent is its neighbour on the path to the main. */
  function tree(): SessionTree {
    const neighbours = new Map<string, string[]>()
    const link = (a: string, b: string) =>
      neighbours.set(a, [...(neighbours.get(a) ?? []), b])
    for (const c of chats)
      if (c.forkedFromThreadId) {
        link(c.threadId, c.forkedFromThreadId)
        link(c.forkedFromThreadId, c.threadId)
      }
    const parent = new Map<string, string>()
    const depth = new Map([[main, 0]])
    const queue = [main]
    while (queue.length) {
      const at = queue.shift()!
      for (const next of neighbours.get(at) ?? [])
        if (!depth.has(next)) {
          depth.set(next, depth.get(at)! + 1)
          parent.set(next, at)
          queue.push(next)
        }
    }
    return {
      schema: 'theorem-session-tree/1',
      treeId: ORIGIN,
      originThreadId: ORIGIN,
      mainThreadId: main,
      ...(main === ORIGIN ? {} : { chosenMainThreadId: main }),
      mainResolution: main === ORIGIN ? 'origin' : 'chosen',
      revision,
      nodes: chats.map((c) => ({
        ...c,
        authorityParentThreadId: parent.get(c.threadId),
        depth: depth.get(c.threadId) ?? 0,
        isMain: c.threadId === main,
        isOrigin: c.threadId === ORIGIN,
      })),
    }
  }

  const lone = (threadId: string, title: string): SessionTree => ({
    schema: 'theorem-session-tree/1',
    treeId: threadId,
    originThreadId: threadId,
    mainThreadId: threadId,
    mainResolution: 'origin',
    revision: 0,
    nodes: [
      {
        ...chat(threadId, title, 4),
        depth: 0,
        isMain: true,
        isOrigin: true,
      },
    ],
  })

  function read(scope: SessionGraphRead['scope']): SessionGraphRead {
    return {
      schema: 'theorem-session-graph/1',
      scope,
      trees:
        scope.kind === 'project'
          ? [
              tree(),
              lone('thread-graph-memory-next', 'Graph memory, continued'),
              lone('thread-python-sdk', 'Python SDK'),
              lone('thread-learning-loop', 'PR learning loop'),
            ]
          : [tree()],
      connections: [
        {
          kind: 'continued',
          fromThreadId: ORIGIN,
          toThreadId: 'thread-graph-memory-next',
          count: 1,
          lastAtMs: now - 2 * HOUR,
        },
        {
          kind: 'message',
          fromThreadId: main,
          toThreadId:
            main === 'thread-graph-bench' ? ORIGIN : 'thread-graph-bench',
          voice: 'user',
          count: 3,
          lastAtMs: now - 40 * MINUTE,
        },
        {
          kind: 'message',
          fromThreadId: 'thread-graph-bench',
          toThreadId: 'thread-graph-index',
          voice: 'session',
          count: 1,
          lastAtMs: now - 25 * MINUTE,
        },
      ],
      artifacts: {
        'thread-graph-bench': [
          {
            outputId: 'output-recall-chart',
            kind: 'artifact',
            title: 'Recall at k chart',
            threadId: 'thread-graph-bench',
            artifactId: 'artifact-recall-chart',
            updatedAtMs: now - 50 * MINUTE,
          },
        ],
      },
      documents: {
        'thread-graph-eviction': [
          {
            outputId: 'output-eviction-notes',
            kind: 'document',
            title: 'Eviction notes',
            threadId: 'thread-graph-eviction',
            documentId: 'document-eviction-notes',
            updatedAtMs: now - 3 * HOUR,
          },
        ],
      },
      tools: {
        'thread-graph-bench': [
          { name: 'run_tests', calls: 12, failed: 1 },
          { name: 'read_file', calls: 9, failed: 0 },
          { name: 'search', calls: 4, failed: 0 },
          { name: 'grep', calls: 3, failed: 0 },
          { name: 'edit', calls: 2, failed: 0 },
        ],
      },
      notServed: [],
    }
  }

  const views = new Map<string, SavedSessionGraph>()
  const summary = ({
    layout: _layout,
    show: _show,
    created_at_ms: _created,
    ...rest
  }: SavedSessionGraph): SessionGraphSummary => rest

  function programmableGraph(args: Record<string, unknown>) {
    switch (args.action) {
      case 'list':
        return ok({
          programs: [],
          session_graphs: [...views.values()]
            .sort((a, b) => b.updated_at_ms - a.updated_at_ms)
            .map(summary),
        })
      case 'load_session_graph': {
        const view = views.get(String(args.node_id))
        return view
          ? ok(view)
          : refusal('session_graph_not_found', 'There is no such graph.')
      }
      case 'save_session_graph': {
        const id = typeof args.node_id === 'string' ? args.node_id : undefined
        const held = id ? views.get(id) : undefined
        if (held && args.expected_revision !== held.revision)
          return refusal(
            'session_graph_revision_conflict',
            'This graph was saved elsewhere since it was opened.',
          )
        const at = Date.now()
        const view: SavedSessionGraph = {
          node_id: id ?? `session-graph-${views.size + 1}`,
          kind: 'session_graph',
          name: String(args.name),
          scope: args.scope as SavedSessionGraph['scope'],
          layout: args.layout ?? {},
          show: {
            sessions: true,
            forks: true,
            connections: true,
            artifacts: true,
            documents: true,
            tools: true,
            ...(args.show as object),
          },
          revision: (held?.revision ?? 0) + 1,
          created_at_ms: held?.created_at_ms ?? at,
          updated_at_ms: at,
        }
        views.set(view.node_id, view)
        return ok(view)
      }
      case 'delete_session_graph':
        views.delete(String(args.node_id))
        return ok({ node_id: args.node_id })
      default:
        return refuse(404, 'not_in_this_story', 'Not in this story')
    }
  }

  return {
    [`GET ${BASE}/session-graph`]: (_params, request) => {
      const query = new URL(request.url).searchParams
      const projectId = query.get('projectId')
      return read(
        projectId
          ? { kind: 'project', projectId }
          : { kind: 'tree', treeId: ORIGIN },
      )
    },
    [`GET ${BASE}/threads/:threadId/tree`]: () => tree(),
    [`POST ${BASE}/threads/:threadId/main`]: async (
      { threadId = '' },
      request,
    ) => {
      const body = (await request.json()) as { expectedRevision?: number }
      const target = chats.find((c) => c.threadId === threadId)
      if (!target) return refuse(404, 'chat_not_found', 'There is no such chat')
      if (target.status !== 'regular')
        return refuse(
          400,
          'invalid_chat_field',
          'Restore the chat to make it main',
        )
      if (
        body.expectedRevision !== undefined &&
        body.expectedRevision !== revision
      )
        return refuse(
          409,
          'chat_revision_conflict',
          'The tree changed since it was read',
        )
      const previous = main
      main = threadId
      revision += 1
      return {
        authority: {
          schema: 'theorem-tree-authority/1',
          tenantId: 'story',
          treeId: ORIGIN,
          mainThreadId: main,
          previousMainThreadId: previous,
          revision,
          updatedAtMs: Date.now(),
        },
        receipt: { receiptId: `receipt-main-${revision}` },
        tree: tree(),
      }
    },
    [`POST /api/environment/v1/tools/:name/call`]: async (
      { name },
      request,
    ) => {
      if (name !== 'programmable_graph' && name !== 'programmable_graph_apply')
        return refuse(404, 'not_in_this_story', 'Not in this story')
      return programmableGraph(
        (await request.json()) as Record<string, unknown>,
      )
    },
  }
}
