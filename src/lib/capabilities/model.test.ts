// SOURCING: bun:test over the rules lib/capabilities/model states — which action a click runs, how a
// described field maps onto the register's own vocabulary, and how the filter editor's rows become a
// QueryFilter tree. These are the decisions the modules make, tested without a browser or a server.
import { describe, expect, test } from 'bun:test'
import {
  trackerDefinition,
  tasksSchema,
  taskRows,
  row,
} from '@/components/capabilities/fixture'
import {
  actionValues,
  addFieldOp,
  canInvoke,
  capabilityRecordItem,
  columnsFor,
  describeFilter,
  fieldSpecOf,
  filterRows,
  inputsFor,
  opsForField,
  parseCapabilityRecordItem,
  parseValue,
  quickAction,
  registerFieldType,
  registerRowOf,
  rowTitle,
  rowsFilter,
  saveAction,
  schemaFor,
  siblingViews,
  typedValue,
  updateActions,
  viewFor,
} from './model'
import { matchAll } from './contract'
import type { QueryFilter, ResolvedField } from './contract'

const fields = tasksSchema.fields
const fieldFor = (key: string) => fields.find((one) => one.key === key)

describe('views', () => {
  test('a setting names the view, and an unknown one falls back to the first', () => {
    expect(viewFor(trackerDefinition, 'all')?.key).toBe('all')
    expect(viewFor(trackerDefinition, 'nope')?.key).toBe('next')
    expect(viewFor(trackerDefinition, undefined)?.key).toBe('next')
  })

  test('a switcher offers only the views over the same collection', () => {
    const start = viewFor(trackerDefinition, 'next')!
    expect(
      siblingViews(trackerDefinition, start).map((one) => one.key),
    ).toEqual(['next', 'all'])
  })

  test('a view shows its display fields in order, or every declared field', () => {
    const schema = schemaFor([tasksSchema], 'tasks')
    expect(
      columnsFor(viewFor(trackerDefinition, 'next')!, schema).map((f) => f.key),
    ).toEqual(fields.map((one) => one.key))
    const withPicks = {
      ...viewFor(trackerDefinition, 'next')!,
      displayFields: ['status', 'title', 'gone'],
    }
    expect(columnsFor(withPicks, schema).map((f) => f.key)).toEqual([
      'status',
      'title',
    ])
  })
})

describe('actions', () => {
  test('quick-add is the first create action over the collection, and none means none', () => {
    expect(quickAction(trackerDefinition, 'tasks')?.key).toBe('add')
    expect(quickAction(trackerDefinition, 'people')).toBeUndefined()
  })

  test('a save prefers the action whose effects are exactly what was edited', () => {
    // Title and effort plus status: `update` writes all three, so it is the change.
    expect(
      saveAction(trackerDefinition, 'tasks', [
        'title',
        'status',
        'effort_minutes',
      ])?.key,
    ).toBe('update')
    // Status alone: `complete` also writes completed_at, which nobody edited, so
    // the generic update takes it instead.
    expect(saveAction(trackerDefinition, 'tasks', ['status'])?.key).toBe(
      'update',
    )
    // Status and its completion time together are `complete`'s own meaning.
    expect(
      saveAction(trackerDefinition, 'tasks', ['status', 'completed_at'])?.key,
    ).toBe('complete')
  })

  test('a field no declared action writes saves through nothing', () => {
    expect(
      saveAction(trackerDefinition, 'tasks', ['completed_at']),
    ).toBeUndefined()
    expect(saveAction(trackerDefinition, 'tasks', [])).toBeUndefined()
    expect(saveAction(trackerDefinition, 'people', ['name'])).toBeUndefined()
  })

  test('a call carries only the inputs the action declares', () => {
    const action = trackerDefinition.actions.find(
      (one) => one.key === 'update',
    )!
    expect(
      inputsFor(action, {
        title: 'A',
        status: 'next',
        effort_minutes: 20,
        due_at: 'x',
      }),
    ).toEqual({ title: 'A', status: 'next', effort_minutes: 20 })
  })

  test('a grant of every action reaches any action, and a named one reaches only that one', () => {
    expect(canInvoke({ invoke: ['*'] }, 'complete')).toBe(true)
    expect(canInvoke({ invoke: ['complete'] }, 'complete')).toBe(true)
    expect(canInvoke({ invoke: ['complete'] }, 'add')).toBe(false)
    expect(canInvoke({ invoke: [] }, 'complete')).toBe(false)
  })

  test('the actions over a collection are the update ones only', () => {
    expect(
      updateActions(trackerDefinition, 'tasks').map((one) => one.key),
    ).toEqual(['complete', 'update', 'assign'])
  })
})

describe('the register vocabulary', () => {
  test('a resolved relation spells its target the way the register does', () => {
    const assignee = fieldFor('assignee')!
    expect(registerFieldType(assignee.fieldType)).toEqual({
      kind: 'relation',
      target_object_type_id: 'ot:people',
      cardinality: 'one',
    })
    expect(fieldSpecOf(assignee)).toEqual({
      key: 'assignee',
      label: 'Assignee',
      field_type: {
        kind: 'relation',
        target_object_type_id: 'ot:people',
        cardinality: 'one',
      },
      required: false,
      system: false,
    })
  })

  test('a row reads as the register’s own row: values by key, links as relations', () => {
    expect(registerRowOf(taskRows[0]!)).toEqual({
      id: 'rec-1',
      values: {
        title: 'Write the plan',
        status: 'next',
        due_at: '2026-11-22',
        effort_minutes: 20,
      },
      relations: {},
    })
    expect(
      registerRowOf(row('rec-3', { title: 'x' }, 1, { assignee: ['person-1'] }))
        .relations,
    ).toEqual({ assignee: ['person-1'] })
  })

  test('a title is the row’s first readable value, and the id when there is none', () => {
    expect(rowTitle(fields, taskRows[0]!)).toBe('Write the plan')
    expect(rowTitle(fields, row('rec-9', {}, 1))).toBe('rec-9')
    // A relation is not a title; the next field is.
    expect(
      rowTitle(fields, row('rec-8', { assignee: 'p1', title: 'Real' }, 1)),
    ).toBe('Real')
  })

  test('a field with no editor here still describes itself', () => {
    const vector: ResolvedField = {
      key: 'embedding',
      label: 'Embedding',
      fieldType: { kind: 'vector', dim: 8 },
      required: false,
    }
    expect(registerFieldType(vector.fieldType)).toEqual({
      kind: 'vector',
      dim: 8,
    })
  })
})

describe('values', () => {
  test('a number that is not a whole number is refused, not rounded', () => {
    expect(parseValue({ kind: 'integer' }, '20')).toEqual({
      ok: true,
      value: 20,
    })
    expect(parseValue({ kind: 'integer' }, '2.5')).toEqual({
      ok: false,
      message: 'not a whole number',
    })
    expect(parseValue({ kind: 'number' }, '2.5')).toEqual({
      ok: true,
      value: 2.5,
    })
    expect(parseValue({ kind: 'number' }, 'x')).toEqual({
      ok: false,
      message: 'not a number',
    })
  })

  test('a blank optional field is null, a blank required one is refused by the form', () => {
    expect(parseValue({ kind: 'text' }, '  ')).toEqual({
      ok: true,
      value: null,
    })
    expect(parseValue({ kind: 'boolean' }, 'false')).toEqual({
      ok: true,
      value: false,
    })
    expect(parseValue({ kind: 'boolean' }, 'maybe').ok).toBe(false)
    const action = quickAction(trackerDefinition, 'tasks')!
    expect(actionValues(action, { title: ' ', due_at: '' })).toEqual({
      ok: false,
      errors: { title: 'needed' },
    })
    expect(actionValues(action, { title: 'Plan', due_at: '' })).toEqual({
      ok: true,
      values: { title: 'Plan', due_at: null },
    })
  })

  test('a timestamp is normalised to RFC 3339 and a bad one refused', () => {
    expect(parseValue({ kind: 'timestamp' }, '2026-11-20T10:30')).toEqual({
      ok: true,
      value: new Date('2026-11-20T10:30').toISOString(),
    })
    expect(parseValue({ kind: 'timestamp' }, 'soon').ok).toBe(false)
    expect(parseValue({ kind: 'date' }, '2026-11-20')).toEqual({
      ok: true,
      value: '2026-11-20',
    })
    expect(parseValue({ kind: 'date' }, '20th of November').ok).toBe(false)
  })

  test('an enum only takes its own variants', () => {
    const type = { kind: 'enum' as const, variants: ['next', 'done'] }
    expect(parseValue(type, 'done')).toEqual({ ok: true, value: 'done' })
    expect(parseValue(type, 'later').ok).toBe(false)
  })

  test('a filter value is typed by the field it compares against', () => {
    expect(typedValue(fieldFor('effort_minutes')!, '20')).toBe(20)
    expect(typedValue(fieldFor('effort_minutes')!, 'twenty')).toBe('twenty')
    expect(typedValue(fieldFor('status')!, 'done')).toBe('done')
    expect(typedValue(fieldFor('title')!, ' plan ')).toBe('plan')
  })
})

describe('filter editing', () => {
  test('a flat and of leaves reads as rows and writes back to the same tree', () => {
    const filter: QueryFilter = {
      op: 'and',
      conditions: [
        { op: 'eq', fieldKey: 'status', value: 'next' },
        { op: 'is_empty', fieldKey: 'completed_at' },
        { op: 'lte', fieldKey: 'effort_minutes', value: 20 },
      ],
    }
    const { rows, groups } = filterRows(filter)
    expect(groups).toBe(0)
    expect(rows).toEqual([
      { fieldKey: 'status', op: 'eq', value: 'next' },
      { fieldKey: 'completed_at', op: 'is_empty', value: '' },
      { fieldKey: 'effort_minutes', op: 'lte', value: '20' },
    ])
    // The editor writes the same tree back, with the number typed as a number.
    expect(rowsFilter(rows, fieldFor)).toEqual(filter)
  })

  test('a single leaf reads as one row, and an empty and reads as none', () => {
    expect(filterRows({ op: 'eq', fieldKey: 'status', value: 'next' })).toEqual(
      {
        rows: [{ fieldKey: 'status', op: 'eq', value: 'next' }],
        groups: 0,
      },
    )
    expect(filterRows(matchAll())).toEqual({ rows: [], groups: 0 })
    expect(rowsFilter([], fieldFor)).toEqual(matchAll())
  })

  test('a group the editor cannot show is counted, not dropped quietly', () => {
    const filter: QueryFilter = {
      op: 'and',
      conditions: [
        { op: 'eq', fieldKey: 'status', value: 'next' },
        {
          op: 'or',
          conditions: [
            { op: 'contains', fieldKey: 'title', value: 'quick' },
            { op: 'lte', fieldKey: 'effort_minutes', value: 20 },
          ],
        },
      ],
    }
    expect(filterRows(filter)).toEqual({
      rows: [{ fieldKey: 'status', op: 'eq', value: 'next' }],
      groups: 1,
    })
  })

  test('`in` holds a list, and each value is typed by the field', () => {
    const rows = [
      { fieldKey: 'status', op: 'in' as const, value: 'next, done' },
    ]
    expect(rowsFilter(rows, fieldFor)).toEqual({
      op: 'and',
      conditions: [{ op: 'in', fieldKey: 'status', values: ['next', 'done'] }],
    })
    const effort = [
      { fieldKey: 'effort_minutes', op: 'in' as const, value: '10, 20' },
    ]
    expect(rowsFilter(effort, fieldFor)).toEqual({
      op: 'and',
      conditions: [{ op: 'in', fieldKey: 'effort_minutes', values: [10, 20] }],
    })
    // The row a stored `in` reads back as, is the same text a person would type.
    expect(
      filterRows({ op: 'in', fieldKey: 'status', values: ['next', 'done'] })
        .rows,
    ).toEqual(rows)
  })

  test('the ops offered are the ones the field’s type can answer', () => {
    expect(opsForField(fieldFor('effort_minutes'))).toEqual([
      'eq',
      'ne',
      'lt',
      'lte',
      'gt',
      'gte',
      'is_empty',
      'is_not_empty',
    ])
    expect(opsForField(fieldFor('title'))).toContain('contains')
    expect(opsForField(fieldFor('status'))).toContain('in')
    expect(opsForField(fieldFor('assignee'))).toEqual([
      'eq',
      'ne',
      'is_empty',
      'is_not_empty',
    ])
    // A field a stored filter names that the collection no longer declares.
    expect(opsForField(undefined)).toEqual([
      'eq',
      'ne',
      'is_empty',
      'is_not_empty',
    ])
  })

  test('one line says what a view reads', () => {
    expect(describeFilter(matchAll())).toBe('every record')
    expect(
      describeFilter({ op: 'eq', fieldKey: 'status', value: 'next' }),
    ).toBe('status is next')
    expect(
      describeFilter({
        op: 'and',
        conditions: [
          { op: 'eq', fieldKey: 'status', value: 'next' },
          { op: 'is_empty', fieldKey: 'completed_at' },
        ],
      }),
    ).toBe('status is next and completed_at is empty')
    expect(
      describeFilter({
        op: 'or',
        conditions: [
          { op: 'lt', fieldKey: 'due_at', value: '2026-11-20' },
          { op: 'contains', fieldKey: 'title', value: 'quick' },
        ],
      }),
    ).toBe('(due_at is before 2026-11-20 or title contains quick)')
  })
})

describe('page values', () => {
  test('a record item names its record, and carries where it was opened in scope', () => {
    const item = capabilityRecordItem(
      'tracker/main',
      'tasks',
      'rec-1',
      'Write the plan',
    )
    // An instance id can itself hold a slash, so the parts are not joined into
    // one string: the record's own id is the item, and its scope names where it
    // came from, the way an Index item does.
    expect(item.id).toBe('rec-1')
    expect(item.kind).toBe('capability-record')
    expect(item.label).toBe('Write the plan')
    expect(item.scope).toEqual({
      kind: 'capability',
      instanceId: 'tracker/main',
      collectionKey: 'tasks',
    })
    expect(parseCapabilityRecordItem(item)).toEqual({
      instanceId: 'tracker/main',
      collectionKey: 'tasks',
      recordId: 'rec-1',
    })
    // A bare id, as a setting names it, belongs to no collection until the definition says.
    expect(parseCapabilityRecordItem('rec-1')).toEqual({
      instanceId: '',
      collectionKey: '',
      recordId: 'rec-1',
    })
    expect(parseCapabilityRecordItem(undefined)).toBeUndefined()
    expect(parseCapabilityRecordItem({ id: 'document-1' })).toEqual({
      instanceId: '',
      collectionKey: '',
      recordId: 'document-1',
    })
  })
})

describe('authoring', () => {
  test('an added field is optional, whatever the form holds', () => {
    expect(
      addFieldOp('tasks', {
        key: 'notes',
        label: 'Notes',
        fieldType: { kind: 'text' },
      }),
    ).toEqual({
      op: 'add_field',
      collectionKey: 'tasks',
      field: {
        key: 'notes',
        label: 'Notes',
        fieldType: { kind: 'text' },
        required: false,
      },
    })
  })
})
