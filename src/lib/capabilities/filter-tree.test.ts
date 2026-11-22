// SOURCING: bun:test over the pure filter-tree editing model in ./filter-tree, with the tracker
// fixture's resolved fields. What is proven is the editor's promise: any QueryFilter reads into the
// editor and back out unchanged, and an edit changes the node it names and nothing else.
import { expect, test } from 'bun:test'
import { matchAll } from './contract'
import type { QueryFilter, ResolvedField } from './contract'
import {
  addCondition,
  addGroup,
  editTree,
  negate,
  removeNode,
  setGroupOp,
  setLeaf,
  treeFilter,
  treeProblems,
  unwrapNot,
} from './filter-tree'
import type { EditNode } from './filter-tree'
import { fieldsByKey } from './model'
import { tasksSchema } from '@/components/capabilities/fixture'

const fields = fieldsByKey(tasksSchema)
const fieldFor = (key: string): ResolvedField | undefined => fields.get(key)
const back = (filter: QueryFilter) => treeFilter(editTree(filter), fieldFor)

/** Every node of a tree, in reading order. */
function nodes(node: EditNode): EditNode[] {
  switch (node.kind) {
    case 'group':
      return [node, ...node.children.flatMap(nodes)]
    case 'not':
      return [node, ...nodes(node.child)]
    case 'leaf':
    case 'opaque':
      return [node]
  }
}
const leaves = (node: EditNode) =>
  nodes(node).filter(
    (one): one is Extract<EditNode, { kind: 'leaf' }> => one.kind === 'leaf',
  )

const deep: QueryFilter = {
  op: 'and',
  conditions: [
    { op: 'eq', fieldKey: 'status', value: 'next' },
    {
      op: 'or',
      conditions: [
        { op: 'contains', fieldKey: 'title', value: 'quick' },
        { op: 'is_empty', fieldKey: 'due_at' },
        {
          op: 'not',
          condition: {
            op: 'and',
            conditions: [
              { op: 'gte', fieldKey: 'effort_minutes', value: 30 },
              { op: 'lt', fieldKey: 'due_at', value: '2026-12-01' },
            ],
          },
        },
      ],
    },
    { op: 'not', condition: { op: 'not', condition: matchAll() } },
    { op: 'in', fieldKey: 'status', values: ['waiting', 'done'] },
    { op: 'is_not_empty', fieldKey: 'assignee' },
    { op: 'or', conditions: [] },
  ],
}

test('any filter reads into the editor and back out unchanged', () => {
  const shapes: QueryFilter[] = [
    matchAll(),
    { op: 'or', conditions: [] },
    { op: 'eq', fieldKey: 'status', value: 'next' },
    { op: 'not', condition: { op: 'eq', fieldKey: 'status', value: 'done' } },
    deep,
    // Values the text editor could not write back the same: kept because they
    // were never edited.
    { op: 'eq', fieldKey: 'effort_minutes', value: 30 },
    { op: 'ne', fieldKey: 'assignee', value: null },
    { op: 'eq', fieldKey: 'meta', value: { nested: [1, 'two'] } },
    { op: 'in', fieldKey: 'effort_minutes', values: [1, 2.5, '3'] },
    { op: 'eq', fieldKey: 'title', value: '  padded  ' },
    // A field the collection no longer declares.
    { op: 'gt', fieldKey: 'retired_field', value: true },
  ]
  for (const filter of shapes) expect(back(filter)).toEqual(filter)
})

test('an op this client does not know is kept as it came', () => {
  const future = {
    op: 'and',
    conditions: [
      { op: 'near', fieldKey: 'where', value: { lat: 1, lng: 2 }, radius: 5 },
      { op: 'eq', fieldKey: 'status', value: 'next' },
    ],
  } as unknown as QueryFilter
  const tree = editTree(future)
  expect(nodes(tree).map((node) => node.kind)).toEqual([
    'group',
    'opaque',
    'leaf',
  ])
  expect(treeFilter(tree, fieldFor)).toEqual(future)
})

test('editing one leaf changes that leaf alone, typed by its field', () => {
  const tree = editTree(deep)
  const effort = leaves(tree).find((leaf) => leaf.row.fieldKey === 'effort_minutes')!
  const edited = setLeaf(tree, effort.id, {
    fieldKey: 'effort_minutes',
    op: 'lte',
    value: ' 45 ',
  })
  const out = treeFilter(edited, fieldFor) as Extract<QueryFilter, { op: 'and' }>
  // The integer comparison reaches the executor as a number.
  const or = out.conditions[1] as Extract<QueryFilter, { op: 'or' }>
  const not = or.conditions[2] as Extract<QueryFilter, { op: 'not' }>
  expect(not.condition).toEqual({
    op: 'and',
    conditions: [
      { op: 'lte', fieldKey: 'effort_minutes', value: 45 },
      { op: 'lt', fieldKey: 'due_at', value: '2026-12-01' },
    ],
  })
  // Everything else is exactly what was read.
  expect(out.conditions.filter((_, at) => at !== 1)).toEqual(
    deep.op === 'and' ? deep.conditions.filter((_, at) => at !== 1) : [],
  )
  expect(or.conditions.slice(0, 2)).toEqual([
    { op: 'contains', fieldKey: 'title', value: 'quick' },
    { op: 'is_empty', fieldKey: 'due_at' },
  ])
})

test('groups switch between all and any, and nest', () => {
  let tree = editTree(matchAll())
  tree = addCondition(tree, tree.id, {
    fieldKey: 'status',
    op: 'eq',
    value: 'next',
  })
  tree = addGroup(tree, tree.id, 'or')
  const inner = nodes(tree).filter((node) => node.kind === 'group')[1]!
  tree = addCondition(tree, inner.id, {
    fieldKey: 'title',
    op: 'contains',
    value: 'plan',
  })
  tree = addCondition(tree, inner.id, {
    fieldKey: 'due_at',
    op: 'is_empty',
    value: '',
  })
  tree = setGroupOp(tree, tree.id, 'or')
  expect(treeFilter(tree, fieldFor)).toEqual({
    op: 'or',
    conditions: [
      { op: 'eq', fieldKey: 'status', value: 'next' },
      {
        op: 'or',
        conditions: [
          { op: 'contains', fieldKey: 'title', value: 'plan' },
          { op: 'is_empty', fieldKey: 'due_at' },
        ],
      },
    ],
  })
})

test('a negation wraps a node and unwraps back to it', () => {
  let tree = editTree(deep)
  const status = leaves(tree)[0]!
  tree = negate(tree, status.id)
  const out = treeFilter(tree, fieldFor) as Extract<QueryFilter, { op: 'and' }>
  expect(out.conditions[0]).toEqual({
    op: 'not',
    condition: { op: 'eq', fieldKey: 'status', value: 'next' },
  })
  const wrapped = nodes(tree).find((node) => node.kind === 'not')!
  tree = unwrapNot(tree, wrapped.id)
  expect(treeFilter(tree, fieldFor)).toEqual(deep)
})

test('adding beside a lone condition makes an and of the two; removing the last leaves every record', () => {
  let tree = editTree({ op: 'eq', fieldKey: 'status', value: 'next' })
  tree = addCondition(tree, tree.id, {
    fieldKey: 'title',
    op: 'contains',
    value: 'x',
  })
  expect(treeFilter(tree, fieldFor)).toEqual({
    op: 'and',
    conditions: [
      { op: 'eq', fieldKey: 'status', value: 'next' },
      { op: 'contains', fieldKey: 'title', value: 'x' },
    ],
  })
  for (const leaf of leaves(tree)) tree = removeNode(tree, leaf.id)
  expect(treeFilter(tree, fieldFor)).toEqual(matchAll())

  // Removing the only condition under a negation removes the negation too: a
  // not of nothing is not a filter anyone wrote.
  let lone = editTree({
    op: 'and',
    conditions: [
      { op: 'not', condition: { op: 'eq', fieldKey: 'status', value: 'x' } },
      { op: 'is_empty', fieldKey: 'due_at' },
    ],
  })
  lone = removeNode(lone, leaves(lone)[0]!.id)
  expect(treeFilter(lone, fieldFor)).toEqual({
    op: 'and',
    conditions: [{ op: 'is_empty', fieldKey: 'due_at' }],
  })
})

test('a condition with no field is a problem the editor names before saving', () => {
  let tree = editTree(matchAll())
  expect(treeProblems(tree)).toEqual([])
  tree = addCondition(tree, tree.id, { fieldKey: '', op: 'eq', value: '' })
  expect(treeProblems(tree)).toEqual(['condition 1 names no field'])
})
