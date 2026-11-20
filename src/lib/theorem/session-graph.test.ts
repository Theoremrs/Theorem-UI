// SOURCING: bun:test over the pure projection in ./session-graph and the scope helpers in ./sessions
import { describe, expect, test } from 'bun:test'
import {
  SHOW_ALL,
  describeEdges,
  projectSessionGraph,
  sessionNodeId,
} from './session-graph'
import type { SessionGraphRead, SessionTreeNode } from './sessions'
import {
  inSessionGraph,
  parseScope,
  projectHasSessionGraph,
  scopeParam,
} from './sessions'
import type { ThreadEntry } from './organization'

const chat = (
  threadId: string,
  createdAtMs: number,
  over: Partial<SessionTreeNode> = {},
): SessionTreeNode => ({
  threadId,
  title: threadId,
  projectId: 'p',
  status: 'regular',
  createdAtMs,
  depth: 0,
  isMain: false,
  isOrigin: false,
  inScope: true,
  ...over,
})

// root ── a ── b, rooted at the origin.
const atOrigin: SessionGraphRead = {
  schema: 'theorem-session-graph/1',
  scope: { kind: 'project', projectId: 'p' },
  trees: [
    {
      schema: 'theorem-session-tree/1',
      treeId: 'root',
      originThreadId: 'root',
      mainThreadId: 'root',
      mainResolution: 'origin',
      revision: 0,
      nodes: [
        chat('b', 3, {
          forkedFromThreadId: 'a',
          authorityParentThreadId: 'a',
          depth: 2,
        }),
        chat('root', 1, { isMain: true, isOrigin: true }),
        chat('a', 2, {
          forkedFromThreadId: 'root',
          authorityParentThreadId: 'root',
          depth: 1,
        }),
      ],
    },
  ],
  connections: [
    {
      kind: 'continued',
      fromThreadId: 'root',
      toThreadId: 'later',
      count: 1,
      lastAtMs: 9,
    },
    {
      kind: 'message',
      fromThreadId: 'root',
      toThreadId: 'b',
      voice: 'user',
      count: 3,
      lastAtMs: 8,
    },
  ],
  artifacts: {
    a: [
      {
        outputId: 'art1',
        kind: 'artifact',
        title: 'Chart',
        threadId: 'a',
        updatedAtMs: 5,
      },
    ],
  },
  documents: {
    b: [
      {
        outputId: 'doc1',
        kind: 'document',
        title: 'Notes',
        threadId: 'b',
        updatedAtMs: 6,
      },
    ],
  },
  tools: {
    root: [
      { name: 'search', calls: 2, failed: 0 },
      { name: 'run', calls: 5, failed: 1 },
    ],
  },
  notServed: [],
}

const ids = (graph: ReturnType<typeof projectSessionGraph>) =>
  graph.nodes.map((n) => n.id)
const edgeIds = (graph: ReturnType<typeof projectSessionGraph>) =>
  graph.edges.map((e) => e.id)

describe('projectSessionGraph', () => {
  test('forks join each chat to its authority parent, the main first', () => {
    const graph = projectSessionGraph(atOrigin, SHOW_ALL)
    expect(ids(graph).slice(0, 3)).toEqual([
      'session:root',
      'session:a',
      'session:b',
    ])
    expect(edgeIds(graph)).toContain('fork:root->a')
    expect(edgeIds(graph)).toContain('fork:a->b')
  })

  test('a branch made main turns the path to the old main around and nothing else', () => {
    const flipped: SessionGraphRead = {
      ...atOrigin,
      trees: [
        {
          ...atOrigin.trees[0]!,
          mainThreadId: 'b',
          chosenMainThreadId: 'b',
          mainResolution: 'chosen',
          revision: 1,
          nodes: [
            chat('root', 1, {
              isOrigin: true,
              authorityParentThreadId: 'a',
              depth: 2,
            }),
            chat('a', 2, {
              forkedFromThreadId: 'root',
              authorityParentThreadId: 'b',
              depth: 1,
            }),
            chat('b', 3, { forkedFromThreadId: 'a', isMain: true }),
          ],
        },
      ],
    }
    const graph = projectSessionGraph(flipped, SHOW_ALL)
    expect(graph.nodes[0]).toMatchObject({
      threadId: 'b',
      isMain: true,
      revision: 1,
    })
    expect(graph.nodes.find((n) => n.id === 'session:root')).toMatchObject({
      isOrigin: true,
      isMain: false,
    })
    expect(edgeIds(graph).filter((id) => id.startsWith('fork:'))).toEqual([
      'fork:b->a',
      'fork:a->root',
    ])
  })

  test('a connection to a chat outside every tree draws it, named from the titles given', () => {
    const graph = projectSessionGraph(
      atOrigin,
      SHOW_ALL,
      new Map([['later', 'Follow-up']]),
    )
    expect(graph.nodes.find((n) => n.id === 'session:later')).toMatchObject({
      title: 'Follow-up',
      outside: true,
    })
    expect(graph.edges.find((e) => e.relation === 'message')).toMatchObject({
      source: sessionNodeId('root'),
      target: sessionNodeId('b'),
      count: 3,
      forPerson: true,
    })
  })

  test('outputs and tools hang from the chat that made and called them', () => {
    const graph = projectSessionGraph(atOrigin, SHOW_ALL)
    expect(edgeIds(graph)).toEqual(
      expect.arrayContaining([
        'made:artifact:art1',
        'made:document:doc1',
        'used:tools:root',
      ]),
    )
    const tools = graph.nodes.find((n) => n.kind === 'tools')
    expect(tools?.kind === 'tools' && tools.tools.map((t) => t.name)).toEqual([
      'run',
      'search',
    ])
  })

  test('a hidden facet is left out, with the edges it carried', () => {
    const noForks = projectSessionGraph(atOrigin, { ...SHOW_ALL, forks: false })
    expect(noForks.edges.some((e) => e.relation === 'fork')).toBe(false)
    expect(ids(noForks)).toContain('session:b')

    const noConnections = projectSessionGraph(atOrigin, {
      ...SHOW_ALL,
      connections: false,
    })
    expect(ids(noConnections)).not.toContain('session:later')
    expect(
      noConnections.edges.some(
        (e) => e.relation === 'message' || e.relation === 'continued',
      ),
    ).toBe(false)

    const outputsOnly = projectSessionGraph(atOrigin, {
      ...SHOW_ALL,
      sessions: false,
      tools: false,
    })
    expect(ids(outputsOnly)).toEqual(['artifact:art1', 'document:doc1'])
    expect(outputsOnly.edges).toEqual([])
  })

  test('a project graph counts a session nothing joins instead of drawing it', () => {
    const withLone: SessionGraphRead = {
      ...atOrigin,
      trees: [
        ...atOrigin.trees,
        {
          ...atOrigin.trees[0]!,
          treeId: 'solo',
          originThreadId: 'solo',
          nodes: [chat('solo', 4, { isMain: true, isOrigin: true })],
        },
      ],
    }
    const graph = projectSessionGraph(withLone, SHOW_ALL)
    expect(ids(graph)).not.toContain('session:solo')
    expect(graph.lone).toBe(1)
    expect(graph.nodes.find((n) => n.id === 'session:root')).toMatchObject({
      solo: false,
    })
    // Read as its own tree, the same session is the graph.
    const asTree = projectSessionGraph(
      { ...withLone, scope: { kind: 'tree', treeId: 'solo' } },
      SHOW_ALL,
    )
    expect(ids(asTree)).toContain('session:solo')
    expect(asTree.lone).toBe(0)
    // Alone in its tree, it is main and origin by definition, so it is not marked.
    expect(asTree.nodes.find((n) => n.id === 'session:solo')).toMatchObject({
      solo: true,
    })
  })

  test('the same read and facets give the same graph', () => {
    expect(projectSessionGraph(atOrigin, SHOW_ALL)).toEqual(
      projectSessionGraph(atOrigin, SHOW_ALL),
    )
  })

  test('every edge reads as a sentence', () => {
    const sentences = describeEdges(projectSessionGraph(atOrigin, SHOW_ALL))
    expect(sentences).toContain('a branches from root')
    expect(sentences).toContain('root sent b 3 messages, some on your behalf')
    expect(sentences).toContain('Chart was made in a')
    expect(sentences).toContain('root called run, search')
  })
})

describe('scope', () => {
  test('a scope round-trips through the search param', () => {
    for (const scope of [
      { kind: 'project', projectId: 'proj:a' },
      { kind: 'tree', treeId: 't1' },
    ] as const)
      expect(parseScope(scopeParam(scope))).toEqual(scope)
    expect(parseScope('nonsense')).toBeUndefined()
    expect(parseScope('tree:')).toBeUndefined()
    expect(parseScope(3)).toBeUndefined()
  })
})

describe('which sessions have a graph', () => {
  const thread = (
    threadId: string,
    over: Partial<ThreadEntry> = {},
  ): ThreadEntry => ({
    threadId,
    title: threadId,
    homeProjectId: 'inbox',
    revision: 1,
    createdAtMs: 1,
    memberships: [],
    attention: { reasons: [], running: false },
    ...over,
  })
  const read = {
    threads: [
      thread('root', {
        memberships: [
          { projectId: 'p', by: 'user', pinned: true, why: '', atMs: 1 },
        ],
      }),
      thread('fork', {
        origin: {
          kind: 'forked',
          threadId: 'root',
          branchId: 'b',
          messageId: 'm',
        },
      }),
      thread('alone', {
        memberships: [
          { projectId: 'q', by: 'user', pinned: true, why: '', atMs: 1 },
        ],
      }),
    ],
  }
  test('a session forked from or into another has one; a lone session does not', () => {
    expect(inSessionGraph(read, 'root')).toBe(true)
    expect(inSessionGraph(read, 'fork')).toBe(true)
    expect(inSessionGraph(read, 'alone')).toBe(false)
  })
  test('a project has one when a member session does', () => {
    expect(projectHasSessionGraph(read, 'p')).toBe(true)
    expect(projectHasSessionGraph(read, 'q')).toBe(false)
  })
})
