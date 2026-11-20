import { describe, expect, it } from 'bun:test'
import type { ProgramDefinition } from './contracts'
import {
  NODE_WIDTH,
  ghostPlaces,
  inputHandle,
  layoutProgram,
  nodeHeight,
  nodeIdFor,
  outputHandle,
  portClass,
  portOfHandle,
  toFlowEdges,
  toFlowNodes,
} from './flow'

const port = (id: string) => ({ id, shape_id: 'theorem.monitor.snapshot.v1' })
const program = {
  name: 'Price watch',
  nodes: [
    {
      id: 'fetch',
      inputs: [],
      outputs: [port('snapshot')],
      kind: 'source',
      selector: { plane: 'scenario' },
    },
    { id: 'notify', inputs: [port('noticed')], outputs: [], kind: 'sink' },
  ],
  edges: [
    {
      id: 'e1',
      from_node: 'fetch',
      from_port: 'snapshot',
      to_node: 'notify',
      to_port: 'noticed',
    },
  ],
} as unknown as ProgramDefinition

describe('program flow', () => {
  it('keeps edges on the exact ports they connect', () => {
    const edge = toFlowEdges(program, {})[0]!
    expect(edge.sourceHandle).toBe(outputHandle('snapshot'))
    expect(edge.targetHandle).toBe(inputHandle('noticed'))
    expect(portOfHandle(edge.sourceHandle)).toBe('snapshot')
  })

  it('shows liveness Theorem reported and otherwise dormant', () => {
    const nodes = toFlowNodes(program, {}, { fetch: 'running' })
    expect(nodes[0]!.data.liveness).toBe('running')
    expect(nodes[1]!.data.liveness).toBe('dormant')
    expect(toFlowEdges(program, { fetch: 'running' })[0]!.animated).toBe(true)
  })

  it('keeps saved positions and places the rest', async () => {
    const placed = await layoutProgram(program, {
      nodes: { fetch: { x: 7, y: 9 } },
    })
    expect(placed.fetch).toEqual({ x: 7, y: 9 })
    expect(placed.notify).toBeDefined()
  })

  it('classifies ports into at most five classes', () => {
    const classes = new Set(
      [
        'tabular_any',
        'graph_nodes',
        'theorem.graph-lisp.value.v1',
        'theorem.monitor.snapshot.v1',
        'anything',
      ].map((shape) => portClass(shape)),
    )
    expect(classes.size).toBeLessThanOrEqual(5)
  })

  it('never reuses a node id', () => {
    expect(nodeIdFor(program, 'Fetch')).toBe('fetch-2')
    expect(nodeIdFor(program, 'Verify')).toBe('verify')
  })
})

describe('placing nodes with no saved place', () => {
  // fetch -> notify; ELK alone puts fetch at (12, 12) and notify at (356, 12).
  const HEIGHT = nodeHeight(program.nodes[0]!)
  const group = (members: string[], x: number, y: number) => ({
    id: 'g',
    label: 'Group',
    x,
    y,
    width: 296,
    height: 156,
    members,
  })
  const note = (x: number, y: number, width: number, height: number) => ({
    id: 'n',
    text: 'Note',
    x,
    y,
    width,
    height,
  })

  it('a new node goes beside the saved node it is wired to, not onto it', async () => {
    const fresh = await layoutProgram(program, null)
    expect(fresh).toEqual({
      fetch: { x: 12, y: 12 },
      notify: { x: 356, y: 12 },
    })
    // fetch was dragged to where ELK would put notify.
    const placed = await layoutProgram(program, {
      nodes: { fetch: { x: 356, y: 12 } },
    })
    expect(placed).toEqual({
      fetch: { x: 356, y: 12 },
      notify: { x: 356 + NODE_WIDTH + 96, y: 12 },
    })
  })

  it('a node saved inside a group is where its group puts it on the canvas', async () => {
    const placed = await layoutProgram(program, {
      nodes: { fetch: { x: 24, y: 48 } },
      groups: [group(['fetch'], 1000, 500)],
    })
    expect(placed.fetch).toEqual({ x: 24, y: 48 })
    expect(placed.notify).toEqual({ x: 1024 + NODE_WIDTH + 96, y: 548 })
  })

  it('a new node is moved down past a note it would land on', async () => {
    const placed = await layoutProgram(program, {
      nodes: { fetch: { x: 12, y: 12 } },
      notes: [note(356, 12, 200, 100)],
    })
    expect(placed.notify).toEqual({ x: 356, y: 12 + 100 + 20 })
  })

  it('a new node wired to nothing saved goes below everything on the canvas', async () => {
    const lone = {
      ...program,
      nodes: [
        ...program.nodes,
        { id: 'extra', inputs: [], outputs: [], kind: 'sink' },
      ],
    } as unknown as ProgramDefinition
    const placed = await layoutProgram(lone, {
      nodes: { fetch: { x: 12, y: 12 }, notify: { x: 356, y: 12 } },
      notes: [note(0, 300, 100, 50)],
    })
    expect(placed.extra).toEqual({ x: 0, y: 350 + 40 })
  })

  it('a proposal’s new nodes go below the groups and notes too', async () => {
    const proposed = {
      ...program,
      nodes: [
        ...program.nodes,
        { id: 'extra', inputs: [port('in')], outputs: [], kind: 'sink' },
      ],
    } as unknown as ProgramDefinition
    // notify is inside a group lower down; its own place is relative to it.
    const places = await ghostPlaces(
      proposed,
      { fetch: { x: 12, y: 12 }, notify: { x: 24, y: 48 } },
      { groups: [group(['notify'], 400, 600)] },
    )
    expect(places.extra!.y).toBe(600 + 156 + 96)
    expect(places.extra!.y).toBeGreaterThan(12 + HEIGHT)
  })
})

describe('muted branches', () => {
  it('marks everything downstream of a muted node undetermined, and nothing upstream', async () => {
    const { mutedDownstream } = await import('./flow')
    const node = (id: string, muted = false) =>
      ({ id, muted, bypassed: false, inputs: [], outputs: [] }) as never
    const edge = (id: string, from: string, to: string) =>
      ({
        id,
        from_node: from,
        from_port: 'o',
        to_node: to,
        to_port: 'i',
      }) as never
    const found = mutedDownstream({
      nodes: [node('a'), node('b', true), node('c'), node('d')],
      edges: [edge('ab', 'a', 'b'), edge('bc', 'b', 'c'), edge('cd', 'c', 'd')],
    } as never)
    expect([...found.nodes].sort()).toEqual(['c', 'd'])
    expect([...found.edges].sort()).toEqual(['bc', 'cd'])
  })
})

describe('waypoints', () => {
  it('go on the leg of the route they lengthen least', async () => {
    const { insertWaypoint } = await import('./flow')
    const route = insertWaypoint(
      [{ x: 100, y: 0 }],
      { x: 0, y: 0 },
      { x: 200, y: 0 },
      { x: 150, y: 10 },
    )
    expect(route).toEqual([
      { x: 100, y: 0 },
      { x: 150, y: 10 },
    ])
  })
})
