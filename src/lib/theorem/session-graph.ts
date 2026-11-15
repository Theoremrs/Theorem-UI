// SOURCING: none: a pure projection over Theorem's session graph read (./sessions, `GET /api/chat/v1/session-graph`). The facets and the rule that viewing changes nothing are docs/plans/projects-sidebar-and-session-graph.md §9.
//
// A session graph is a view, P(read, show, titles): it turns the read into
// nodes and edges and writes nothing. Each edge kind comes from one part of
// the read:
//
// - Forks: the fork tree, rooted at the main chat. An edge joins a chat to its
//   authority parent, so making another chat main turns the path between the
//   two around and leaves every other edge where it was.
// - Connections: a chat continued from another (`Thread.origin`), and session
//   messages, with how many and whether any spoke for the person.
// - Artifacts, documents and tools: what each chat made and called.
//
// Facets the person hides are left out here, never drawn and then covered.
import type { SessionGraphShow } from '@/lib/program/api'
import type {
  SessionGraphRead,
  SessionOutput,
  SessionTreeNode,
  ToolUse,
} from './sessions'

export type SessionNode = {
  kind: 'session'
  id: string
  threadId: string
  title: string
  status: SessionTreeNode['status']
  isMain: boolean
  isOrigin: boolean
  /** The only chat in its tree: its main and origin by definition, so neither is worth marking. */
  solo: boolean
  running: boolean
  lastMovedMs: number
  /** The tree it belongs to, and that tree's authority revision; absent for a chat drawn only as a connection's other end. */
  treeId?: string
  revision?: number
  forkedFromThreadId?: string
  /** Drawn because a chat in scope connects to it: in another project, or in no tree read here. */
  outside: boolean
}

export type OutputNode = {
  kind: 'artifact' | 'document'
  id: string
  outputId: string
  threadId: string
  title: string
  outputKind: string
  updatedAtMs: number
}

export type ToolsNode = {
  kind: 'tools'
  id: string
  threadId: string
  /** Most called first. */
  tools: readonly ToolUse[]
}

export type GraphNode = SessionNode | OutputNode | ToolsNode

export type Relation = 'fork' | 'continued' | 'message' | 'made' | 'used'

export type GraphEdge = {
  id: string
  source: string
  target: string
  relation: Relation
  /** Messages: how many were sent. */
  count?: number
  /** Messages: some spoke for the person. */
  forPerson?: boolean
}

export type ProjectedGraph = {
  nodes: readonly GraphNode[]
  edges: readonly GraphEdge[]
  /** Sessions in a project graph left out because nothing joins them to another: no fork, continuation or message. */
  lone: number
}

export const sessionNodeId = (threadId: string) => `session:${threadId}`

/** Every facet shown: a new view starts here, and Theorem fills a facet a view left out the same way. */
export const SHOW_ALL: SessionGraphShow = {
  sessions: true,
  forks: true,
  connections: true,
  artifacts: true,
  documents: true,
  tools: true,
}

export const FACET_LABEL: Readonly<Record<keyof SessionGraphShow, string>> = {
  sessions: 'Sessions',
  forks: 'Forks',
  connections: 'Connections',
  artifacts: 'Artifacts',
  documents: 'Documents',
  tools: 'Tools',
}

/** How each relation reads in words, from its target: "B forked from A". */
export const RELATION_LABEL: Readonly<Record<Relation, string>> = {
  fork: 'branches from',
  continued: 'continues',
  message: 'was messaged by',
  made: 'was made in',
  used: 'were called in',
}

/** The main first, then out from it, oldest first: the order ELK keeps side-by-side nodes in, so a refresh does not reshuffle them. */
const treeOrder = (a: SessionTreeNode, b: SessionTreeNode) =>
  Number(b.isMain) - Number(a.isMain) ||
  a.depth - b.depth ||
  a.createdAtMs - b.createdAtMs ||
  a.threadId.localeCompare(b.threadId)

function sessionNode(
  node: SessionTreeNode,
  tree: { treeId: string; revision: number; nodes: readonly unknown[] },
): SessionNode {
  return {
    kind: 'session',
    id: sessionNodeId(node.threadId),
    threadId: node.threadId,
    title: node.title || 'New chat',
    status: node.status,
    isMain: node.isMain,
    isOrigin: node.isOrigin,
    solo: tree.nodes.length === 1,
    running: node.activeRunId !== undefined,
    lastMovedMs: node.lastMessageAtMs ?? node.createdAtMs,
    treeId: tree.treeId,
    revision: tree.revision,
    forkedFromThreadId: node.forkedFromThreadId,
    outside: !node.inScope,
  }
}

function outputNodes(
  kind: OutputNode['kind'],
  outputs: Readonly<Record<string, readonly SessionOutput[]>>,
  threadIds: readonly string[],
): OutputNode[] {
  return threadIds.flatMap((threadId) =>
    [...(outputs[threadId] ?? [])]
      .sort(
        (a, b) =>
          b.updatedAtMs - a.updatedAtMs || a.outputId.localeCompare(b.outputId),
      )
      .map((output) => ({
        kind,
        id: `${kind}:${output.outputId}`,
        outputId: output.outputId,
        threadId,
        title: output.title || 'Untitled',
        outputKind: output.kind,
        updatedAtMs: output.updatedAtMs,
      })),
  )
}

/**
 * The graph the read draws with these facets shown. Pure: the same read and
 * facets give the same graph, and nothing is written anywhere. `titles` names
 * a chat a connection reaches outside every tree read here.
 */
export function projectSessionGraph(
  read: SessionGraphRead,
  show: SessionGraphShow,
  titles: ReadonlyMap<string, string> = new Map(),
): ProjectedGraph {
  const sessions: SessionNode[] = []
  const edges: GraphEdge[] = []
  // A project graph reads every member, and most stand alone. A graph is of
  // relations, so a session with nothing joining it is counted, not drawn.
  const connected = new Set(
    read.connections.flatMap((c) =>
      c.fromThreadId === c.toThreadId ? [] : [c.fromThreadId, c.toThreadId],
    ),
  )
  let lone = 0
  for (const tree of read.trees) {
    const only = tree.nodes.length === 1 ? tree.nodes[0] : undefined
    if (
      read.scope.kind === 'project' &&
      only &&
      !connected.has(only.threadId)
    ) {
      lone += 1
      continue
    }
    for (const node of [...tree.nodes].sort(treeOrder)) {
      sessions.push(sessionNode(node, tree))
      const parent = node.authorityParentThreadId
      if (show.forks && parent && parent !== node.threadId)
        edges.push({
          id: `fork:${parent}->${node.threadId}`,
          source: sessionNodeId(parent),
          target: sessionNodeId(node.threadId),
          relation: 'fork',
        })
    }
  }
  const inTrees = new Set(sessions.map((s) => s.threadId))

  if (show.connections) {
    const outside = new Map<string, SessionNode>()
    for (const connection of read.connections) {
      const { fromThreadId: from, toThreadId: to } = connection
      if (from === to) continue
      for (const threadId of [from, to])
        if (!inTrees.has(threadId) && !outside.has(threadId))
          outside.set(threadId, {
            kind: 'session',
            id: sessionNodeId(threadId),
            threadId,
            title: titles.get(threadId) || 'Another session',
            status: 'regular',
            isMain: false,
            isOrigin: false,
            solo: false,
            running: false,
            lastMovedMs: connection.lastAtMs,
            outside: true,
          })
      edges.push({
        id: `${connection.kind}:${from}->${to}`,
        source: sessionNodeId(from),
        target: sessionNodeId(to),
        relation: connection.kind,
        ...(connection.kind === 'message'
          ? { count: connection.count, forPerson: connection.voice === 'user' }
          : {}),
      })
    }
    sessions.push(...outside.values())
  }

  const owners = sessions.map((s) => s.threadId)
  const nodes: GraphNode[] = show.sessions ? [...sessions] : []
  if (show.artifacts)
    nodes.push(...outputNodes('artifact', read.artifacts, owners))
  if (show.documents)
    nodes.push(...outputNodes('document', read.documents, owners))
  if (show.tools)
    for (const threadId of owners) {
      const tools = read.tools[threadId]
      if (tools?.length)
        nodes.push({
          kind: 'tools',
          id: `tools:${threadId}`,
          threadId,
          tools: [...tools].sort(
            (a, b) => b.calls - a.calls || a.name.localeCompare(b.name),
          ),
        })
    }

  if (show.sessions)
    for (const node of nodes) {
      if (node.kind === 'session') continue
      edges.push({
        id: `${node.kind === 'tools' ? 'used' : 'made'}:${node.id}`,
        source: sessionNodeId(node.threadId),
        target: node.id,
        relation: node.kind === 'tools' ? 'used' : 'made',
      })
    }

  // An edge is drawn only between nodes that are: hiding sessions takes every edge with them.
  const drawn = new Set(nodes.map((n) => n.id))
  return {
    nodes,
    edges: edges.filter((e) => drawn.has(e.source) && drawn.has(e.target)),
    lone,
  }
}

/** A node's name, for the list beside the graph and for screen readers. */
export function nodeName(node: GraphNode): string {
  if (node.kind === 'tools') return 'Tools'
  return node.title
}

/** Each edge as a sentence, for the list beside the graph and for screen readers. */
export function describeEdges(graph: ProjectedGraph): string[] {
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]))
  return graph.edges.map((edge) => {
    const source = nodes.get(edge.source)!
    const target = nodes.get(edge.target)!
    if (edge.relation === 'message')
      return `${nodeName(source)} sent ${nodeName(target)} ${edge.count === 1 ? 'a message' : `${edge.count} messages`}${edge.forPerson ? ', some on your behalf' : ''}`
    if (edge.relation === 'used')
      return `${nodeName(source)} called ${(target as ToolsNode).tools.map((t) => t.name).join(', ')}`
    return `${nodeName(target)} ${RELATION_LABEL[edge.relation]} ${nodeName(source)}`
  })
}
