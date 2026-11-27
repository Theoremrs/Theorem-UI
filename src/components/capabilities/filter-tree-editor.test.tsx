// SOURCING: bun:test over the filter tree editor rendered with test/workspace's render into
// happy-dom, held in state the way view-editor holds it (editTree of the read filter, treeFilter of
// the edits). What is asserted is what the person sees and the filter the edited tree means.
import { afterEach, expect, test } from 'bun:test'
import { act, useState } from 'react'
import { cleanup, render } from '../../../test/workspace'
import type { QueryFilter, ResolvedField } from '@/lib/capabilities/contract'
import { editTree, treeFilter } from '@/lib/capabilities/filter-tree'
import { fieldsByKey } from '@/lib/capabilities/model'
import { FilterTreeEditor } from './filter-tree-editor'
import { tasksSchema } from './fixture'

afterEach(() => {
  cleanup()
})

function Held({
  filter,
  fields,
}: {
  filter: QueryFilter
  fields: Map<string, ResolvedField>
}) {
  const [tree, setTree] = useState(() => editTree(filter))
  return (
    <>
      <FilterTreeEditor tree={tree} fields={fields} onChange={setTree} />
      <output aria-label="Filter">
        {JSON.stringify(treeFilter(tree, (key) => fields.get(key)))}
      </output>
    </>
  )
}

const tasks = fieldsByKey(tasksSchema)

const named = <T extends Element = HTMLElement>(label: string) =>
  document.querySelector<T>(`[aria-label="${label}"]`)

const filterNow = () => JSON.parse(named('Filter')!.textContent) as unknown

const optionsOf = (label: string) =>
  [...named<HTMLSelectElement>(label)!.options].map((one) => one.value)

async function press(label: string) {
  const target = named(label)
  expect(target).toBeTruthy()
  await act(async () => target!.click())
}

function choose(label: string, value: string) {
  const field = named<HTMLSelectElement>(label)
  expect(field).toBeTruthy()
  const setter = Object.getOwnPropertyDescriptor(
    HTMLSelectElement.prototype,
    'value',
  )!.set!
  act(() => {
    setter.call(field, value)
    field!.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

test('a condition this editor cannot change is shown and kept as it is, and can be removed', async () => {
  const kept = { op: 'matches', fieldKey: 'title', value: 'plan*' }
  const filter = {
    op: 'and',
    conditions: [{ op: 'eq', fieldKey: 'status', value: 'next' }, kept],
  } as unknown as QueryFilter
  await render(<Held filter={filter} fields={tasks} />)
  expect(document.body.textContent).toContain(
    `A condition this editor cannot change, kept as it is: ${JSON.stringify(kept)}`,
  )
  expect(filterNow()).toEqual(filter)
  await press('Remove condition 2')
  expect(document.body.textContent).not.toContain('cannot change')
  expect(filterNow()).toEqual({
    op: 'and',
    conditions: [{ op: 'eq', fieldKey: 'status', value: 'next' }],
  })
})

test('a field the collection no longer has, or an operator its field does not offer, is still offered first; a new field starts its operator over', async () => {
  const filter: QueryFilter = {
    op: 'and',
    conditions: [
      { op: 'eq', fieldKey: 'retired', value: 'x' },
      { op: 'contains', fieldKey: 'status', value: 'nex' },
    ],
  }
  await render(<Held filter={filter} fields={tasks} />)
  expect(named<HTMLSelectElement>('Field of condition 1')?.value).toBe(
    'retired',
  )
  expect(optionsOf('Field of condition 1')).toEqual([
    'retired',
    ...tasksSchema.fields.map((field) => field.key),
  ])
  expect(optionsOf('Operator of condition 1')).toEqual([
    'eq',
    'ne',
    'is_empty',
    'is_not_empty',
  ])
  expect(named<HTMLSelectElement>('Operator of condition 2')?.value).toBe(
    'contains',
  )
  expect(optionsOf('Operator of condition 2')).toEqual([
    'contains',
    'eq',
    'ne',
    'in',
    'is_empty',
    'is_not_empty',
  ])

  choose('Field of condition 1', 'status')
  expect(optionsOf('Field of condition 1')).toEqual(
    tasksSchema.fields.map((field) => field.key),
  )
  expect(named<HTMLSelectElement>('Operator of condition 1')?.value).toBe('eq')
  expect(named<HTMLInputElement>('Value of condition 1')?.value).toBe('')
  expect(
    named<HTMLInputElement>('Value of condition 1')?.getAttribute(
      'placeholder',
    ),
  ).toBeNull()
  choose('Operator of condition 1', 'in')
  expect(
    named<HTMLInputElement>('Value of condition 1')?.getAttribute(
      'placeholder',
    ),
  ).toBe('one, two')
  choose('Operator of condition 1', 'is_empty')
  expect(named('Value of condition 1')).toBeNull()
  // The edited condition is sent as it now reads; the untouched one as it was read.
  expect(filterNow()).toEqual({
    op: 'and',
    conditions: [
      { op: 'is_empty', fieldKey: 'status' },
      { op: 'contains', fieldKey: 'status', value: 'nex' },
    ],
  })
})

test('groups and negations: an empty group says so, a group is negated and removed, and undoing a not puts it back', async () => {
  const filter: QueryFilter = { op: 'and', conditions: [] }
  await render(<Held filter={filter} fields={tasks} />)
  expect(document.body.textContent).toContain(
    'No conditions: the view shows every record.',
  )
  expect(named('Negate group 1')).toBeNull()
  expect(named('Remove group 1')).toBeNull()
  await press('Add group to group 1')
  expect(named<HTMLSelectElement>('Match for group 2')?.value).toBe('or')
  expect(document.body.textContent).toContain(
    'No conditions in this group yet.',
  )
  expect(document.body.textContent).not.toContain('No conditions: the view')
  const grouped = { op: 'and', conditions: [{ op: 'or', conditions: [] }] }
  expect(filterNow()).toEqual(grouped)

  await press('Negate group 2')
  expect(named('Remove negation 1')?.textContent).toBe('Undo not')
  expect(filterNow()).toEqual({
    op: 'and',
    conditions: [{ op: 'not', condition: { op: 'or', conditions: [] } }],
  })
  await press('Remove negation 1')
  expect(named('Remove negation 1')).toBeNull()
  expect(filterNow()).toEqual(grouped)

  await press('Remove group 2')
  expect(named('Match for group 2')).toBeNull()
  expect(filterNow()).toEqual(filter)
})

test('a lone condition at the top is joined by what is added beside it, and with no fields no condition can be added', async () => {
  const kept = { op: 'matches', fieldKey: 'title', value: 'plan*' }
  await render(
    <Held filter={kept as unknown as QueryFilter} fields={new Map()} />,
  )
  expect(named('Match for group 1')).toBeNull()
  expect(named<HTMLButtonElement>('Add condition')?.disabled).toBe(true)
  await press('Add group')
  expect(named<HTMLSelectElement>('Match for group 1')?.value).toBe('and')
  expect(named('Add condition')).toBeNull()
  expect(named<HTMLButtonElement>('Add condition to group 1')?.disabled).toBe(
    true,
  )
  expect(filterNow()).toEqual({
    op: 'and',
    conditions: [kept, { op: 'or', conditions: [] }],
  })
})
