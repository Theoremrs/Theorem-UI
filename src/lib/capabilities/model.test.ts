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
  fieldsByKey,
  filterRows,
  inputsFor,
  listText,
  listValues,
  opsForField,
  parseCapabilityRecordItem,
  parseValue,
  quickAction,
  referencedCollections,
  registerFieldType,
  registerRowOf,
  rowTitle,
  rowsFilter,
  saveAction,
  schemaFor,
  siblingViews,
  typedValue,
  updateActions,
  valueText,
  valueless,
  viewFor,
} from './model'
import { matchAll } from './contract'
import type {
  ActionSpec,
  CapabilityDefinition,
  QueryFilter,
  ResolvedField,
} from './contract'

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

  test('quick-add takes the first create action the grant reaches, else still names the declared one', () => {
    const add = trackerDefinition.actions.find((one) => one.key === 'add')!
    const twoCreates: CapabilityDefinition = {
      ...trackerDefinition,
      actions: [{ ...add, key: 'import', label: 'Import task' }, add],
    }
    expect(quickAction(twoCreates, 'tasks', { invoke: ['add'] })?.key).toBe(
      'add',
    )
    // None granted: the first stays, so the module shows it shut and says why.
    expect(quickAction(twoCreates, 'tasks', { invoke: [] })?.key).toBe('import')
  })

  test('a save prefers the action whose effects are exactly what was edited', () => {
    // Title and effort plus status: `update` writes all three, so it is the change.
    expect(
      saveAction(trackerDefinition, 'tasks', {
        title: 'A',
        status: 'next',
        effort_minutes: 20,
      })?.action.key,
    ).toBe('update')
    // Status alone: `complete` also writes completed_at, which nobody edited, so
    // the generic update takes it instead.
    expect(
      saveAction(trackerDefinition, 'tasks', { status: 'done' })?.action.key,
    ).toBe('update')
  })

  test('an exact action that would write something other than was entered is named with what it writes', () => {
    // Status and its completion time together are `complete`'s own meaning, but
    // it writes `done` and the time it runs: the module asks before running it.
    expect(
      saveAction(trackerDefinition, 'tasks', {
        status: 'done',
        completed_at: '2026-11-20T10:30:00.000Z',
      }),
    ).toEqual({
      action: trackerDefinition.actions.find((one) => one.key === 'complete')!,
      overrides: [{ fieldKey: 'completed_at', writes: 'now' }],
    })
    const plan = saveAction(trackerDefinition, 'tasks', {
      status: 'next',
      completed_at: '2026-11-20T10:30:00.000Z',
    })
    expect(plan?.action.key).toBe('complete')
    expect(plan?.overrides).toEqual([
      { fieldKey: 'status', writes: 'literal', value: 'done' },
      { fieldKey: 'completed_at', writes: 'now' },
    ])
  })

  test('an exact action whose literal is what was entered runs as it is', () => {
    const close: ActionSpec = {
      key: 'close',
      label: 'Close',
      collectionKey: 'tasks',
      creates: false,
      input: [],
      preconditions: [],
      effects: [{ fieldKey: 'status', source: 'literal', value: 'done' }],
    }
    const withClose = {
      ...trackerDefinition,
      actions: [close, ...trackerDefinition.actions],
    }
    expect(saveAction(withClose, 'tasks', { status: 'done' })).toEqual({
      action: close,
      overrides: [],
    })
    // Another value is not what `close` writes, so the generic update writes it.
    expect(saveAction(withClose, 'tasks', { status: 'next' })?.action.key).toBe(
      'update',
    )
  })

  test('an action that also writes a literal is not a generic update for the fields it takes as input', () => {
    const retitleAndClose: ActionSpec = {
      key: 'retitle_close',
      label: 'Retitle and close',
      collectionKey: 'tasks',
      creates: false,
      input: [
        { key: 'new_title', fieldType: { kind: 'text' }, required: true },
      ],
      preconditions: [],
      effects: [
        { fieldKey: 'title', source: 'input', key: 'new_title' },
        { fieldKey: 'status', source: 'literal', value: 'done' },
      ],
    }
    // Editing the title alone must not close the task unasked.
    expect(
      saveAction(
        { ...trackerDefinition, actions: [retitleAndClose] },
        'tasks',
        {
          title: 'Ship it',
        },
      ),
    ).toBeUndefined()
  })

  test('a save only picks an action the grant reaches', () => {
    expect(
      saveAction(trackerDefinition, 'tasks', { title: 'A' }, (action) =>
        canInvoke({ invoke: ['complete'] }, action.key),
      ),
    ).toBeUndefined()
    expect(
      saveAction(trackerDefinition, 'tasks', { title: 'A' }, (action) =>
        canInvoke({ invoke: ['update'] }, action.key),
      )?.action.key,
    ).toBe('update')
  })

  test('a field no declared action writes saves through nothing', () => {
    expect(
      saveAction(trackerDefinition, 'tasks', { completed_at: null }),
    ).toBeUndefined()
    expect(saveAction(trackerDefinition, 'tasks', {})).toBeUndefined()
    expect(
      saveAction(trackerDefinition, 'people', { name: 'A' }),
    ).toBeUndefined()
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

  test('an input that writes a field under another name carries that field’s value', () => {
    const retitle: ActionSpec = {
      key: 'retitle',
      label: 'Retitle',
      collectionKey: 'tasks',
      creates: false,
      input: [
        { key: 'new_title', fieldType: { kind: 'text' }, required: true },
      ],
      preconditions: [],
      effects: [{ fieldKey: 'title', source: 'input', key: 'new_title' }],
    }
    const withRetitle = { ...trackerDefinition, actions: [retitle] }
    // An inline title edit selects it by the field it writes…
    expect(
      saveAction(withRetitle, 'tasks', { title: 'Ship it' })?.action.key,
    ).toBe('retitle')
    // …and sends the edited title under the input's own key.
    expect(inputsFor(retitle, { title: 'Ship it', status: 'next' })).toEqual({
      new_title: 'Ship it',
    })
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
    // Past 2^53 a whole number is not held exactly, so it is refused, not rounded.
    expect(parseValue({ kind: 'integer' }, '9007199254740993')).toEqual({
      ok: false,
      message: 'too large to hold exactly',
    })
    expect(parseValue({ kind: 'integer' }, '20')).toEqual({
      ok: true,
      value: 20,
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

  test('a blank optional field is left out of the inputs, a blank required one is refused by the form', () => {
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
    // Absent applies no effect; the executor refuses a null input outright.
    const parsed = actionValues(action, { title: 'Plan', due_at: '' })
    expect(parsed).toEqual({ ok: true, values: { title: 'Plan' } })
    expect(parsed.ok && Object.hasOwn(parsed.values, 'due_at')).toBe(false)
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
    const typed = rows.map(({ fieldKey, op, value }) => ({
      fieldKey,
      op,
      value,
    }))
    expect(typed).toEqual([
      { fieldKey: 'status', op: 'eq', value: 'next' },
      { fieldKey: 'completed_at', op: 'is_empty', value: '' },
      { fieldKey: 'effort_minutes', op: 'lte', value: '20' },
    ])
    // The editor writes the same tree back: unedited rows as they were read,
    // and edited ones from their text, with the number typed as a number.
    expect(rowsFilter(rows, fieldFor)).toEqual(filter)
    expect(rowsFilter(typed, fieldFor)).toEqual(filter)
  })

  test('a single leaf reads as one row, and an empty and reads as none', () => {
    expect(filterRows({ op: 'eq', fieldKey: 'status', value: 'next' })).toEqual(
      {
        rows: [
          {
            fieldKey: 'status',
            op: 'eq',
            value: 'next',
            original: { op: 'eq', fieldKey: 'status', value: 'next' },
          },
        ],
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
      rows: [
        {
          fieldKey: 'status',
          op: 'eq',
          value: 'next',
          original: { op: 'eq', fieldKey: 'status', value: 'next' },
        },
      ],
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
        .rows[0]?.value,
    ).toBe('next, done')
  })

  test('an `in` value holding a comma survives an unchanged row and an edited one', () => {
    const stored: QueryFilter = {
      op: 'and',
      conditions: [
        { op: 'in', fieldKey: 'title', values: ['Acme, Inc.', 'Globex'] },
        { op: 'eq', fieldKey: 'status', value: 'next' },
      ],
    }
    const { rows } = filterRows(stored)
    // The list shows the comma-holding value quoted, so it reads as one.
    expect(rows[0]!.value).toBe('"Acme, Inc.", Globex')
    // Saving after changing another row keeps it one value.
    const changed = rows.map((one, at) =>
      at === 1 ? { fieldKey: 'status', op: 'eq' as const, value: 'done' } : one,
    )
    expect(rowsFilter(changed, fieldFor)).toEqual({
      op: 'and',
      conditions: [
        { op: 'in', fieldKey: 'title', values: ['Acme, Inc.', 'Globex'] },
        { op: 'eq', fieldKey: 'status', value: 'done' },
      ],
    })
    // Edited as text, the quoted list still reads as the same two values.
    const retyped = [
      { fieldKey: 'title', op: 'in' as const, value: rows[0]!.value },
    ]
    expect(rowsFilter(retyped, fieldFor)).toEqual({
      op: 'and',
      conditions: [
        { op: 'in', fieldKey: 'title', values: ['Acme, Inc.', 'Globex'] },
      ],
    })
  })

  test('a list line splits at commas outside quotes, and quotes inside quotes double', () => {
    expect(listValues('next, done')).toEqual(['next', 'done'])
    expect(listValues('next,"Smith, Jane"')).toEqual(['next', 'Smith, Jane'])
    expect(listValues('next, "Smith, Jane" , x')).toEqual([
      'next',
      'Smith, Jane',
      'x',
    ])
    expect(listValues('"say ""hi"""')).toEqual(['say "hi"'])
    expect(listValues('a,, b,')).toEqual(['a', 'b'])
    expect(listValues('')).toEqual([])
    const values = ['plain', 'Acme, Inc.', 'say "hi"']
    expect(listValues(listText(values))).toEqual(values)
    expect(listValues(listText(['', ' spaced ']))).toEqual(['', ' spaced '])
  })

  test('a stored comparison the text cannot hold is written back as it was', () => {
    const stored: QueryFilter = {
      op: 'and',
      conditions: [
        { op: 'eq', fieldKey: 'title', value: null },
        { op: 'eq', fieldKey: 'title', value: { lang: 'en' } },
        { op: 'in', fieldKey: 'title', values: [['a', 'b'], null, 3] },
        { op: 'eq', fieldKey: 'status', value: 20 },
      ],
    }
    const { rows } = filterRows(stored)
    expect(rowsFilter(rows, fieldFor)).toEqual(stored)
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

describe('the edges a value or a column turns on', () => {
  test('a described field keeps its description in the register', () => {
    const title = fieldFor('title')!
    expect(fieldSpecOf({ ...title, description: 'What the task is' })).toEqual(
      expect.objectContaining({ description: 'What the task is' }),
    )
    expect('description' in fieldSpecOf(title)).toBe(false)
  })

  test('a collection whose fields are not resolved has no columns', () => {
    expect(columnsFor(viewFor(trackerDefinition, 'all')!, undefined)).toEqual(
      [],
    )
    expect(fieldsByKey(undefined).size).toBe(0)
  })

  test('nothing is held as empty text, and true and a reference parse as themselves', () => {
    expect(valueText(null)).toBe('')
    expect(valueText(undefined)).toBe('')
    expect(parseValue({ kind: 'boolean' }, 'true')).toEqual({
      ok: true,
      value: true,
    })
    expect(
      parseValue({ kind: 'reference', collectionKey: 'people' }, ' rec-1 '),
    ).toEqual({ ok: true, value: 'rec-1' })
    const done = { ...fieldFor('title')!, fieldType: { kind: 'boolean' } }
    expect(typedValue(done as ResolvedField, 'true')).toBe(true)
    expect(typedValue(done as ResolvedField, 'false')).toBe(false)
    expect(typedValue(done as ResolvedField, 'maybe')).toBe('maybe')
  })

  test('a form loads only the collections its reference inputs name', () => {
    const assign = trackerDefinition.actions.find(
      (action) => action.key === 'assign',
    )!
    const add = trackerDefinition.actions.find(
      (action) => action.key === 'add',
    )!
    expect(referencedCollections(assign)).toEqual(['people'])
    expect(referencedCollections(add)).toEqual([])
  })

  test('only an emptiness check needs no value', () => {
    expect(valueless('is_empty')).toBe(true)
    expect(valueless('is_not_empty')).toBe(true)
    expect(valueless('eq')).toBe(false)
  })
})
