// SOURCING: hand-roll, over the generated wire types (src/lib/workbench/wire SemanticTree, SemanticDiff, Node) and React's useSyncExternalStore: no library models the Rust core's own semantic feed (terminal/crates/workbench-core/src/semantics.rs, `{type: "full"|"diff"}` JSON), and `SemanticTree::apply` there is the one definition of how a diff patches a tree. This is that definition in TypeScript, plus a per-node store so a diff touches only the nodes it names.
import type {
  Node,
  NodeId,
  SemanticDiff,
  SemanticTree,
} from '@/lib/workbench/wire'
import { arrange, share } from './aria'
import type { Placed } from './aria'

/** One message of the feed, parsed: the first tree, or the change from the one before. */
export type Update =
  | { type: 'full'; tree: SemanticTree }
  | { type: 'diff'; diff: SemanticDiff }

/** The tree as the overlay holds it: every node by id, and the root. Nodes are never mutated, only replaced. */
export interface Tree {
  readonly root: NodeId
  readonly nodes: ReadonlyMap<NodeId, Node>
}

/** A feed message, or `undefined` when it is not one (the overlay ignores it and keeps what it has). */
export function parseUpdate(json: string): Update | undefined {
  let value: unknown
  try {
    value = JSON.parse(json)
  } catch {
    return undefined
  }
  if (typeof value !== 'object' || value === null) return undefined
  const message = value as { type?: unknown; tree?: unknown; diff?: unknown }
  if (message.type === 'full' && isTree(message.tree))
    return { type: 'full', tree: message.tree }
  if (message.type === 'diff' && isDiff(message.diff))
    return { type: 'diff', diff: message.diff }
  return undefined
}

/** `handle.semantics()` answers a bare `SemanticTree`, the same shape `full` carries. */
export function parseTree(json: string): SemanticTree | undefined {
  try {
    const value: unknown = JSON.parse(json)
    return isTree(value) ? value : undefined
  } catch {
    return undefined
  }
}

function isTree(value: unknown): value is SemanticTree {
  if (typeof value !== 'object' || value === null) return false
  const tree = value as Partial<SemanticTree>
  return typeof tree.root === 'string' && Array.isArray(tree.nodes)
}

function isDiff(value: unknown): value is SemanticDiff {
  if (typeof value !== 'object' || value === null) return false
  const diff = value as Partial<SemanticDiff>
  return (
    Array.isArray(diff.added) &&
    Array.isArray(diff.changed) &&
    Array.isArray(diff.removed)
  )
}

export function treeOf(tree: SemanticTree): Tree {
  return {
    root: tree.root,
    nodes: new Map(tree.nodes.map((node) => [node.id, node])),
  }
}

/**
 * Applies a diff exactly as `SemanticTree::apply` does in Rust (removed nodes go, changed nodes are
 * replaced by id, added nodes join, a set `root` replaces the root), and refuses one that does not fit
 * the tree it is applied to, with `undefined`: a changed or removed id the tree does not hold, an added
 * id it already holds, a root or child that is not in the result. Rust builds each diff from the tree
 * it published before, so any of those means this side has missed an update; the caller resyncs from
 * `handle.semantics()` (or waits for the next full tree) instead of showing a half-patched interface.
 */
export function applyDiff(
  tree: Tree | undefined,
  diff: SemanticDiff,
): Tree | undefined {
  if (!tree) return undefined
  const nodes = new Map(tree.nodes)
  for (const id of diff.removed) if (!nodes.delete(id)) return undefined
  for (const node of diff.changed) {
    if (!nodes.has(node.id)) return undefined
    nodes.set(node.id, node)
  }
  for (const node of diff.added) {
    if (nodes.has(node.id)) return undefined
    nodes.set(node.id, node)
  }
  const root = diff.root ?? tree.root
  if (!nodes.has(root)) return undefined
  for (const node of nodes.values())
    for (const child of node.children) if (!nodes.has(child)) return undefined
  return { root, nodes }
}

/**
 * The next tree for an update, `undefined` when a diff does not fit (see `applyDiff`). A full tree
 * always fits: it replaces whatever is held.
 */
export function reduce(
  tree: Tree | undefined,
  update: Update,
): Tree | undefined {
  return update.type === 'full' ? treeOf(update.tree) : applyDiff(tree, update.diff)
}

/**
 * The parent of every node. Rust guarantees one parent each (`SemanticTree::validate`); a second
 * claim on a child here is ignored so a broken tree cannot loop the overlay.
 */
export function parentsOf(tree: Tree): Map<NodeId, NodeId> {
  const parents = new Map<NodeId, NodeId>()
  for (const node of tree.nodes.values())
    for (const child of node.children)
      if (child !== tree.root && !parents.has(child)) parents.set(child, node.id)
  return parents
}

/**
 * The node focus is on: the last node, in reading order, that says it is focused. The core marks the
 * focused group, its active tab and its tab panel, and the panel then marks its own row or field, so
 * the deepest and latest claim is the one the keyboard acts on.
 */
export function activeNode(tree: Tree): NodeId | undefined {
  let found: NodeId | undefined
  const seen = new Set<NodeId>()
  const walk = (id: NodeId) => {
    if (seen.has(id)) return
    seen.add(id)
    const node = tree.nodes.get(id)
    if (!node) return
    if (node.state.focused) found = id
    for (const child of node.children) walk(child)
  }
  walk(tree.root)
  return found
}

function sameIds(a: readonly NodeId[], b: readonly NodeId[]) {
  return a.length === b.length && a.every((id, at) => id === b[at])
}

/**
 * The focused node if it is a text field the core publishes the text and caret of: a `textBox` with
 * `text` and `selection`, taking input (not disabled). A terminal's screen is `text` without
 * `selection`: it is read, not edited as text.
 */
function mirrorTarget(tree: Tree, active: NodeId | undefined): NodeId | undefined {
  const node = active === undefined ? undefined : tree.nodes.get(active)
  return node &&
    node.role === 'textBox' &&
    node.text !== undefined &&
    node.selection !== undefined &&
    !node.state.disabled
    ? node.id
    : undefined
}

type Listener = () => void

/**
 * The overlay's tree and the listeners of its parts. A part listens to one node id, so a diff wakes
 * the parts of the nodes it names (and the parents whose children it changes), nothing else.
 */
export interface Store {
  /** The current tree, `undefined` before the first full tree. */
  tree: () => Tree | undefined
  node: (id: NodeId) => Node | undefined
  parent: (id: NodeId) => NodeId | undefined
  /** The focused node, or `undefined`. */
  active: () => NodeId | undefined
  /**
   * The focused node when it is a text-edit node whose text and caret the core publishes, which the
   * input field then mirrors; `undefined` otherwise.
   */
  mirrored: () => NodeId | undefined
  /** The elements to render and how they nest; the same object until the structure changes. */
  shape: () => Placed | undefined
  /** Listens to one node: called when it is added, removed or replaced, or when its children's roles change. */
  subscribeNode: (id: NodeId, listener: Listener) => () => void
  /** Listens to the focused node changing. */
  subscribeActive: (listener: Listener) => () => void
  /** Listens to any change at all (the root, the active node). */
  subscribe: (listener: Listener) => () => void
  /**
   * Takes one feed message. Returns false when a diff did not fit and nothing changed: the caller
   * should `replace` the tree from `handle.semantics()`.
   */
  push: (update: Update) => boolean
  /** Sets the whole tree, as a resync from the handle does. */
  replace: (tree: SemanticTree) => void
}

export function createStore(): Store {
  let tree: Tree | undefined
  let parents = new Map<NodeId, NodeId>()
  let active: NodeId | undefined
  let mirrored: NodeId | undefined
  let shape: Placed | undefined
  const byNode = new Map<NodeId, Set<Listener>>()
  const onActive = new Set<Listener>()
  const onAny = new Set<Listener>()

  const wake = (ids: Iterable<NodeId>) => {
    const woken = new Set<Listener>()
    for (const id of ids) for (const listener of byNode.get(id) ?? []) woken.add(listener)
    for (const listener of woken) listener()
  }

  /** Installs `next`; wakes what differs from the tree before it. */
  const install = (next: Tree) => {
    const before = tree
    const nextParents = parentsOf(next)
    const touched = new Set<NodeId>()
    let structural = !before || before.root !== next.root || before.nodes.size !== next.nodes.size
    if (!before) for (const id of next.nodes.keys()) touched.add(id)
    else {
      for (const [id, node] of next.nodes) {
        const old = before.nodes.get(id)
        if (old === node) continue
        touched.add(id)
        if (!old || old.role !== node.role || !sameIds(old.children, node.children))
          structural = true
        // A parent arranges its children by their roles and states: it renders again when one changes.
        const parent = nextParents.get(id)
        if (parent && (!old || old.role !== node.role)) touched.add(parent)
      }
      for (const [id] of before.nodes) {
        if (next.nodes.has(id)) continue
        touched.add(id)
        const parent = parents.get(id)
        if (parent) touched.add(parent)
      }
      if (before.root !== next.root) {
        touched.add(before.root)
        touched.add(next.root)
      }
    }
    tree = next
    parents = nextParents
    if (structural) {
      const placed = arrange(next)
      shape = placed ? share(shape, placed) : undefined
    }
    const nextActive = activeNode(next)
    const nextMirrored = mirrorTarget(next, nextActive)
    wake(touched)
    if (nextActive !== active || nextMirrored !== mirrored) {
      active = nextActive
      mirrored = nextMirrored
      for (const listener of [...onActive]) listener()
    }
    for (const listener of [...onAny]) listener()
  }

  return {
    tree: () => tree,
    node: (id) => tree?.nodes.get(id),
    parent: (id) => parents.get(id),
    active: () => active,
    mirrored: () => mirrored,
    shape: () => shape,
    subscribeNode(id, listener) {
      let set = byNode.get(id)
      if (!set) byNode.set(id, (set = new Set()))
      set.add(listener)
      return () => {
        set.delete(listener)
        if (!set.size) byNode.delete(id)
      }
    },
    subscribeActive(listener) {
      onActive.add(listener)
      return () => onActive.delete(listener)
    },
    subscribe(listener) {
      onAny.add(listener)
      return () => onAny.delete(listener)
    },
    push(update) {
      const next = reduce(tree, update)
      if (!next) return false
      install(next)
      return true
    },
    replace(full) {
      install(treeOf(full))
    },
  }
}
