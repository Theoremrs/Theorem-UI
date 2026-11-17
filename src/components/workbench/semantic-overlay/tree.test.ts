// SOURCING: none — bun:test over ./tree with the feed recorded from the real core (feed.fixture.json) and hand-made diffs
import { describe, expect, test } from 'bun:test'
import type { Node, SemanticDiff, SemanticTree } from '@/lib/workbench/wire'
import fixture from './feed.fixture.json'
import {
  activeNode,
  applyDiff,
  createStore,
  parentsOf,
  parseTree,
  parseUpdate,
  reduce,
  treeOf,
} from './tree'
import type { Tree, Update } from './tree'

const updates = fixture.updates.map((json) => parseUpdate(json)!)

function node(id: string, children: string[] = [], over: Partial<Node> = {}): Node {
  return {
    id,
    role: 'group',
    name: id,
    state: {
      focused: false,
      selected: false,
      disabled: false,
      busy: false,
      expanded: null,
      description: null,
      symlink: false,
      ignored: false,
      hidden: false,
      modified: false,
    },
    rect: { x: 0, y: 0, width: 4, height: 1 },
    actions: [],
    binding: { type: 'none' },
    children,
    ...over,
  }
}

const tree = (root: string, ...nodes: Node[]): SemanticTree => ({ root, nodes })

/** Rust's `SemanticTree::validate`: one node per id, every child present, one parent each, all reachable. */
function validate(t: Tree): string | undefined {
  if (!t.nodes.has(t.root)) return 'missing root'
  const owned = new Set<string>()
  for (const n of t.nodes.values())
    for (const c of n.children) {
      if (!t.nodes.has(c)) return `missing child ${c}`
      if (c === t.root || owned.has(c)) return `second parent ${c}`
      owned.add(c)
    }
  const seen = new Set<string>()
  const stack = [t.root]
  while (stack.length) {
    const id = stack.pop()!
    if (seen.has(id)) continue
    seen.add(id)
    stack.push(...t.nodes.get(id)!.children)
  }
  for (const id of t.nodes.keys()) if (!seen.has(id)) return `unreachable ${id}`
  return undefined
}

describe('the feed recorded from the real core', () => {
  test('starts with a full tree and then only diffs', () => {
    expect(updates[0]!.type).toBe('full')
    expect(updates.slice(1).every((u) => u.type === 'diff')).toBe(true)
  })

  test('every update leaves a tree Rust would validate, with the parts each diff names changed', () => {
    let held: Tree | undefined
    for (const update of updates) {
      const next = reduce(held, update)
      expect(next).toBeDefined()
      expect(validate(next!)).toBeUndefined()
      if (held && update.type === 'diff') {
        for (const added of update.diff.added) expect(held.nodes.has(added.id)).toBe(false)
        for (const changed of update.diff.changed) expect(next!.nodes.get(changed.id)).toBe(changed)
        for (const removed of update.diff.removed) expect(next!.nodes.has(removed)).toBe(false)
        // Everything a diff does not name is the very same node.
        const named = new Set([
          ...update.diff.added.map((n) => n.id),
          ...update.diff.changed.map((n) => n.id),
        ])
        for (const [id, kept] of held.nodes)
          if (!named.has(id) && next!.nodes.has(id)) expect(next!.nodes.get(id)).toBe(kept)
      }
      held = next
    }
  })

  test('the Files rows arrive with level, position and set size, and the picker with options to choose', () => {
    let held: Tree | undefined
    for (const update of updates) held = reduce(held, update)
    const row = held!.nodes.get('p3/f:docs')!
    expect(row).toMatchObject({ role: 'treeItem', level: 1, posInSet: 2, setSize: 9 })
    expect(held!.nodes.get('p2/row-0')).toMatchObject({ role: 'menuItem' })
  })

  test('focus is the last node that says it is focused', () => {
    let held: Tree | undefined
    const seen: (string | undefined)[] = []
    for (const update of updates) {
      held = reduce(held, update)
      seen.push(activeNode(held!))
    }
    // The composer holds focus at load; after the Files chord the Files panel does (no row is the cursor yet), then its first row; the picker's row once the picker opens.
    expect(seen[0]).toBe('p1/composer:text')
    expect(seen[2]).toBe('body:p3')
    expect(seen[3]).toBe('p3/f:.github')
    expect(seen.at(-1)).toBe('p2/row-0')
  })
})

describe('applyDiff', () => {
  const base = treeOf(tree('r', node('r', ['a', 'b']), node('a'), node('b')))

  test('removes, replaces and adds as SemanticTree::apply does', () => {
    const diff: SemanticDiff = {
      added: [node('c')],
      changed: [node('r', ['a', 'c']), node('a', [], { name: 'A' })],
      removed: ['b'],
    }
    const next = applyDiff(base, diff)!
    expect([...next.nodes.keys()].sort()).toEqual(['a', 'c', 'r'])
    expect(next.nodes.get('a')!.name).toBe('A')
    expect(next.nodes.get('r')!.children).toEqual(['a', 'c'])
    expect(next.root).toBe('r')
    expect(validate(next)).toBeUndefined()
  })

  test('a set root replaces the root', () => {
    const next = applyDiff(
      treeOf(tree('r', node('r', ['a']), node('a'))),
      { added: [node('s', ['a'])], changed: [node('r')], removed: [], root: 's' },
    )!
    expect(next.root).toBe('s')
  })

  test('does not mutate the tree it patches', () => {
    applyDiff(base, { added: [], changed: [node('a', [], { name: 'X' })], removed: [] })
    expect(base.nodes.get('a')!.name).toBe('a')
  })

  test.each([
    ['before any full tree', undefined, { added: [], changed: [], removed: [] }],
    ['a changed node it does not hold', base, { added: [], changed: [node('zz')], removed: [] }],
    ['a removed node it does not hold', base, { added: [], changed: [], removed: ['zz'] }],
    ['an added node it already holds', base, { added: [node('a')], changed: [], removed: [] }],
    ['a child that is not there', base, { added: [], changed: [node('r', ['a', 'gone'])], removed: [] }],
    ['a removed node still listed as a child', base, { added: [], changed: [], removed: ['b'] }],
    ['a root it does not hold', base, { added: [], changed: [], removed: [], root: 'nope' }],
  ] as [string, Tree | undefined, SemanticDiff][])(
    'refuses a diff that does not fit: %s',
    (_, held, diff) => {
      expect(applyDiff(held, diff)).toBeUndefined()
    },
  )
})

describe('parsing', () => {
  test('reads the two messages and the core’s bare tree, and nothing else', () => {
    expect(parseUpdate('{"type":"full","tree":{"root":"r","nodes":[]}}')?.type).toBe('full')
    expect(parseUpdate('{"type":"diff","diff":{"added":[],"changed":[],"removed":[]}}')?.type).toBe('diff')
    expect(parseUpdate('{"type":"diff","diff":{"added":[]}}')).toBeUndefined()
    expect(parseUpdate('{"type":"other"}')).toBeUndefined()
    expect(parseUpdate('not json')).toBeUndefined()
    expect(parseUpdate('null')).toBeUndefined()
    expect(parseTree('{"root":"r","nodes":[]}')?.root).toBe('r')
    expect(parseTree('[]')).toBeUndefined()
  })
})

describe('parentsOf', () => {
  test('ignores a second claim on a child and a claim on the root', () => {
    const parents = parentsOf(
      treeOf(tree('r', node('r', ['a']), node('a', ['r']), node('b', ['a']))),
    )
    expect(parents.get('a')).toBe('r')
    expect(parents.has('r')).toBe(false)
  })
})

describe('the store', () => {
  const full = (nodes: Node[], root = nodes[0]!.id): Update => ({
    type: 'full',
    tree: tree(root, ...nodes),
  })

  test('wakes only the nodes a diff names, and the parent of one whose role changed', () => {
    const store = createStore()
    store.push(full([node('r', ['a', 'b', 'c']), node('a'), node('b'), node('c')]))
    const woken: string[] = []
    for (const id of ['r', 'a', 'b', 'c'])
      store.subscribeNode(id, () => woken.push(id))
    store.push({
      type: 'diff',
      diff: { added: [], changed: [node('a', [], { name: 'A' })], removed: [] },
    })
    expect(woken).toEqual(['a'])
    woken.length = 0
    store.push({
      type: 'diff',
      diff: { added: [], changed: [node('b', [], { role: 'button' })], removed: [] },
    })
    expect(woken.sort()).toEqual(['b', 'r'])
  })

  test('keeps the same shape object until the structure changes', () => {
    const store = createStore()
    store.push(full([node('r', ['a', 'b']), node('a'), node('b')]))
    const shape = store.shape()
    store.push({
      type: 'diff',
      diff: { added: [], changed: [node('a', [], { text: 'streamed' })], removed: [] },
    })
    expect(store.shape()).toBe(shape)
    store.push({
      type: 'diff',
      diff: { added: [node('c')], changed: [node('r', ['a', 'b', 'c'])], removed: [] },
    })
    expect(store.shape()).not.toBe(shape)
    // The part that did not change is the very same object, so a renderer skips it.
    expect(store.shape()!.children[0]).toBe(shape!.children[0])
  })

  test('answers false for a diff that does not fit and holds what it had', () => {
    const store = createStore()
    expect(store.push({ type: 'diff', diff: { added: [], changed: [], removed: [] } })).toBe(false)
    store.push(full([node('r', ['a']), node('a')]))
    expect(store.push({ type: 'diff', diff: { added: [], changed: [node('zz')], removed: [] } })).toBe(false)
    expect(store.node('a')).toBeDefined()
  })

  test('mirrors only a focused text box that has text and a caret and takes input', () => {
    const edit = (over: Partial<Node>): Node =>
      node('t', [], {
        role: 'textBox',
        text: 'hello',
        selection: { anchor: 5, focus: 5 },
        ...over,
        state: { ...node('t').state, focused: true, ...(over.state ?? {}) },
      })
    const mirrored = (field: Node) => {
      const store = createStore()
      store.push(full([node('r', ['t']), field]))
      return store.mirrored()
    }
    expect(mirrored(edit({}))).toBe('t')
    expect(mirrored(edit({ selection: undefined }))).toBeUndefined()
    expect(mirrored(edit({ text: undefined, selection: undefined }))).toBeUndefined()
    expect(mirrored(edit({ role: 'region' }))).toBeUndefined()
    expect(mirrored(edit({ state: { ...node('t').state, focused: true, disabled: true } }))).toBeUndefined()
  })

  test('a full tree replaces everything and wakes everything', () => {
    const store = createStore()
    store.push(full([node('r', ['a']), node('a')]))
    let woken = 0
    store.subscribeNode('a', () => (woken += 1))
    store.replace(tree('r', node('r', ['a']), node('a')))
    expect(woken).toBe(1)
  })
})
