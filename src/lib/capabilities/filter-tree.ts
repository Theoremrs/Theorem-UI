// SOURCING: none — the editable form of a QueryFilter tree (and/or groups, negations, leaves) for the
// view editor. No query-builder library models this contract's own tree with its untouched-node
// guarantee, and the leaf reading and typing are model.ts's (rowOfFilter, filterOfRow), so one rule
// stays one source. The promise: a filter read in and written out unedited is the same filter, and an
// edit changes the node it names and nothing else.
import type { QueryFilter, ResolvedField } from './contract'
import { filterOfRow, rowOfFilter } from './model'
import type { FilterRow, LeafFilter, LeafOp } from './model'

/** One node of the tree being edited. Ids are stable while the editor is open. */
export type EditNode =
  | { id: string; kind: 'group'; op: 'and' | 'or'; children: EditNode[] }
  | { id: string; kind: 'not'; child: EditNode }
  /**
   * A comparison over one field. `original` is the leaf as it was read; it is
   * dropped on the first edit, so an untouched leaf writes back exactly as it
   * came, whatever value its text form could not say.
   */
  | { id: string; kind: 'leaf'; row: FilterRow; original?: LeafFilter }
  /** A node this client does not know how to edit: kept, shown, removable. */
  | { id: string; kind: 'opaque'; original: unknown }

let minted = 0
const freshId = () => `node-${++minted}`

const LEAF_OPS: ReadonlySet<string> = new Set<LeafOp>([
  'eq',
  'ne',
  'in',
  'lt',
  'lte',
  'gt',
  'gte',
  'contains',
  'is_empty',
  'is_not_empty',
])

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

/** Whether a node is a leaf this editor can show as a row. */
function editableLeaf(node: Record<string, unknown>): node is LeafFilter {
  if (!LEAF_OPS.has(String(node.op)) || typeof node.fieldKey !== 'string')
    return false
  return node.op !== 'in' || Array.isArray(node.values)
}

/** The tree the editor holds for a filter. */
export function editTree(filter: QueryFilter): EditNode {
  const node: unknown = filter
  if (!isRecord(node)) return { id: freshId(), kind: 'opaque', original: node }
  if ((node.op === 'and' || node.op === 'or') && Array.isArray(node.conditions))
    return {
      id: freshId(),
      kind: 'group',
      op: node.op,
      children: (node.conditions as QueryFilter[]).map(editTree),
    }
  if (node.op === 'not' && isRecord(node.condition))
    return {
      id: freshId(),
      kind: 'not',
      child: editTree(node.condition as QueryFilter),
    }
  if (editableLeaf(node))
    return {
      id: freshId(),
      kind: 'leaf',
      row: rowOfFilter(node),
      original: node,
    }
  return { id: freshId(), kind: 'opaque', original: node }
}

/** The filter a tree means: untouched nodes exactly as read, edited leaves typed by their field. */
export function treeFilter(
  node: EditNode,
  fieldFor: (fieldKey: string) => ResolvedField | undefined,
): QueryFilter {
  switch (node.kind) {
    case 'group':
      return {
        op: node.op,
        conditions: node.children.map((child) => treeFilter(child, fieldFor)),
      }
    case 'not':
      return { op: 'not', condition: treeFilter(node.child, fieldFor) }
    case 'leaf':
      return node.original ?? filterOfRow(node.row, fieldFor)
    case 'opaque':
      return node.original as QueryFilter
  }
}

/** A new leaf, edited from the start. */
export const newLeaf = (row: FilterRow): EditNode => ({
  id: freshId(),
  kind: 'leaf',
  row,
})

/** Rebuild the tree with one node changed; `undefined` from `change` removes it. */
function mapNode(
  node: EditNode,
  id: string,
  change: (node: EditNode) => EditNode | undefined,
): EditNode | undefined {
  if (node.id === id) return change(node)
  switch (node.kind) {
    case 'group': {
      const children = node.children
        .map((child) => mapNode(child, id, change))
        .filter((child): child is EditNode => child !== undefined)
      return { ...node, children }
    }
    case 'not': {
      const child = mapNode(node.child, id, change)
      // A negation of nothing is not a filter anyone wrote: it goes with its child.
      return child ? { ...node, child } : undefined
    }
    case 'leaf':
    case 'opaque':
      return node
  }
}

/** The empty `and`, which the contract reads as every record. */
const everyRecord = (): EditNode => ({
  id: freshId(),
  kind: 'group',
  op: 'and',
  children: [],
})

const update = (
  tree: EditNode,
  id: string,
  change: (node: EditNode) => EditNode | undefined,
) => mapNode(tree, id, change) ?? everyRecord()

/** Edit one leaf's field, op or value. */
export const setLeaf = (tree: EditNode, id: string, row: FilterRow) =>
  update(tree, id, (node) =>
    node.kind === 'leaf' ? { id: node.id, kind: 'leaf', row } : node,
  )

/** Remove one node; removing the root leaves every record. */
export const removeNode = (tree: EditNode, id: string) =>
  update(tree, id, () => undefined)

/** Switch a group between all (and) and any (or). */
export const setGroupOp = (tree: EditNode, id: string, op: 'and' | 'or') =>
  update(tree, id, (node) => (node.kind === 'group' ? { ...node, op } : node))

/** Wrap one node in a negation. */
export const negate = (tree: EditNode, id: string) =>
  update(tree, id, (node) => ({ id: freshId(), kind: 'not', child: node }))

/** Replace a negation with the node it negates. */
export const unwrapNot = (tree: EditNode, id: string) =>
  update(tree, id, (node) => (node.kind === 'not' ? node.child : node))

/**
 * Add a child to the group `id` names. Adding at a root that is not a group
 * makes an `and` of the root and the new node: the one structural change the
 * editor makes on its own, and only when asked to add.
 */
function addChild(tree: EditNode, id: string, child: EditNode): EditNode {
  if (tree.id === id && tree.kind !== 'group')
    return { id: freshId(), kind: 'group', op: 'and', children: [tree, child] }
  return update(tree, id, (node) =>
    node.kind === 'group'
      ? { ...node, children: [...node.children, child] }
      : node,
  )
}

/** Add a condition to a group. */
export const addCondition = (tree: EditNode, groupId: string, row: FilterRow) =>
  addChild(tree, groupId, newLeaf(row))

/** Add an empty group to a group. */
export const addGroup = (tree: EditNode, groupId: string, op: 'and' | 'or') =>
  addChild(tree, groupId, { id: freshId(), kind: 'group', op, children: [] })

/** What stops a tree from being saved, in the words the editor numbers its conditions with. */
export function treeProblems(tree: EditNode): string[] {
  const problems: string[] = []
  let at = 0
  const walk = (node: EditNode) => {
    switch (node.kind) {
      case 'group':
        node.children.forEach(walk)
        return
      case 'not':
        walk(node.child)
        return
      case 'leaf':
        at += 1
        if (!node.row.fieldKey) problems.push(`condition ${at} names no field`)
        return
      case 'opaque':
        at += 1
        return
    }
  }
  walk(tree)
  return problems
}
