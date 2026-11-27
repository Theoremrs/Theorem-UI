// SOURCING: none — the pure reading of a capability contract answer: what a view means, which
// action a click runs, how a field's type maps onto the schema register's own vocabulary (so
// components/records/fields renders and edits it with the controls the CRM already uses), and how a
// flat filter editor turns into a QueryFilter tree. No fetch here, so each rule is testable on its
// own and has one source.
import type {
  FieldSpec,
  RecordRow,
  SchemaFieldType,
} from '@/components/records/contract'
import type {
  ActionSpec,
  CapabilityDefinition,
  CapabilityFieldType,
  CapabilityRecordRow,
  CollectionSchema,
  InputField,
  PatchOp,
  QueryFilter,
  ResolvedField,
  ResolvedFieldType,
  ViewSpec,
} from './contract'
import type { Item } from '@/lib/modules/contract'
import { isItem } from '@/lib/modules/values'

// ── Types the register holds ──────────────────────────────────────────────

/**
 * A resolved field, as the schema register's own mirror names it. The capability
 * contract carries the same vocabulary in camelCase; the field controls in
 * components/records are written against the register's spelling.
 */
export function registerFieldType(field: ResolvedFieldType): SchemaFieldType {
  switch (field.kind) {
    case 'relation':
      return {
        kind: 'relation',
        target_object_type_id: field.targetObjectTypeId,
        cardinality: field.cardinality,
      }
    case 'vector':
      return { kind: 'vector', dim: field.dim }
    case 'enum':
      return { kind: 'enum', variants: field.variants }
    case 'enum_many':
      return { kind: 'enum_many', variants: field.variants }
    case 'text':
    case 'long_text':
    case 'integer':
    case 'number':
    case 'boolean':
    case 'timestamp':
    case 'date':
    case 'uuid':
    case 'json':
    case 'geometry':
      return { kind: field.kind }
  }
}

/** One describe field as the register's FieldSpec, so the shared controls read it as their own. */
export function fieldSpecOf(field: ResolvedField): FieldSpec {
  return {
    key: field.key,
    label: field.label,
    field_type: registerFieldType(field.fieldType),
    required: field.required,
    // The capability contract carries no system flag: a described field is a
    // declared one the register holds, and nothing here may write to a field the
    // definition does not name.
    system: false,
    ...(field.description === undefined
      ? {}
      : { description: field.description }),
  }
}

/** A capability row as the register's row shape, for FieldDisplay and FieldEditor. */
export function registerRowOf(row: CapabilityRecordRow): RecordRow {
  return { id: row.id, values: row.fields, relations: row.links ?? {} }
}

// ── Views ───────────────────────────────────────────────────────────────────

/** The view a module shows: the one its setting names, else the definition's first. */
export function viewFor(
  definition: CapabilityDefinition,
  viewKey: string | undefined,
): ViewSpec | undefined {
  const named = viewKey
    ? definition.views.find((view) => view.key === viewKey)
    : undefined
  return named ?? definition.views[0]
}

/**
 * The views a switcher offers: every view over the same collection, so switching
 * presents the same records another way and never moves data.
 */
export function siblingViews(
  definition: CapabilityDefinition,
  view: ViewSpec,
): ViewSpec[] {
  return definition.views.filter(
    (other) => other.collectionKey === view.collectionKey,
  )
}

/** A collection's schema as describe resolved it, by its key. */
export function schemaFor(
  schemas: CollectionSchema[],
  collectionKey: string,
): CollectionSchema | undefined {
  return schemas.find((schema) => schema.collectionKey === collectionKey)
}

/** The columns a view shows: its display fields in order, else every resolved field. */
export function columnsFor(
  view: ViewSpec,
  schema: CollectionSchema | undefined,
) {
  const fields = schema?.fields ?? []
  if (!view.displayFields) return fields
  return view.displayFields
    .map((key) => fields.find((field) => field.key === key))
    .filter((field): field is ResolvedField => field !== undefined)
}

/** Every resolved field of one collection, by key. */
export const fieldsByKey = (schema: CollectionSchema | undefined) =>
  new Map((schema?.fields ?? []).map((field) => [field.key, field]))

// ── Actions ─────────────────────────────────────────────────────────────────

/**
 * The action a quick-add form runs: the first create action over this
 * collection that this caller's grant reaches, else the first one at all, so a
 * caller who may not add still sees the declared way to and why it is shut.
 * None means the definition declares no way to add a record here, so the
 * module offers no quick-add rather than inventing a write.
 */
export function quickAction(
  definition: CapabilityDefinition,
  collectionKey: string,
  grant?: { invoke: string[] },
): ActionSpec | undefined {
  const creates = definition.actions.filter(
    (action) => action.creates && action.collectionKey === collectionKey,
  )
  return (
    (grant && creates.find((action) => canInvoke(grant, action.key))) ??
    creates[0]
  )
}

/** The actions that update a record of this collection. */
export function updateActions(
  definition: CapabilityDefinition,
  collectionKey: string,
): ActionSpec[] {
  return definition.actions.filter(
    (action) => !action.creates && action.collectionKey === collectionKey,
  )
}

/** The field keys a declared action writes, in the order it writes them. */
export function effectKeys(action: ActionSpec): string[] {
  return [...new Set(action.effects.map((effect) => effect.fieldKey))]
}

/** Whether every edited field comes out of this action's effects. */
const covers = (action: ActionSpec, edited: string[]) =>
  edited.every((key) =>
    action.effects.some((effect) => effect.fieldKey === key),
  )

/** The input an action reads one field's new value from, when an effect writes it from one. */
const inputKeyOf = (action: ActionSpec, fieldKey: string) => {
  for (const effect of action.effects)
    if (effect.fieldKey === fieldKey && effect.source === 'input')
      return effect.key
  return undefined
}

/** Two wire values as equal as their JSON says: what an effect writes is JSON. */
const sameValue = (a: unknown, b: unknown) =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

/**
 * A field the action writes with something other than what the person entered:
 * a literal that differs from the edit, or the moment the action runs.
 */
export type SaveOverride =
  | { fieldKey: string; writes: 'literal'; value: unknown }
  | { fieldKey: string; writes: 'now' }

function overridesOf(
  action: ActionSpec,
  edited: Record<string, unknown>,
): SaveOverride[] {
  const overrides: SaveOverride[] = []
  for (const effect of action.effects) {
    if (!Object.hasOwn(edited, effect.fieldKey)) continue
    if (effect.source === 'now')
      overrides.push({ fieldKey: effect.fieldKey, writes: 'now' })
    else if (
      effect.source === 'literal' &&
      !sameValue(effect.value, edited[effect.fieldKey])
    )
      overrides.push({
        fieldKey: effect.fieldKey,
        writes: 'literal',
        value: effect.value,
      })
  }
  return overrides
}

/**
 * The action a save runs, for the fields a person edited and the values they
 * edited them to:
 *
 * 1. a declared action whose effects are exactly the edited fields and write
 *    the values entered — the deliberate change ("Complete" writing status and
 *    completed_at) is what the definition means by it, and running it keeps its
 *    preconditions and lifecycle;
 * 2. otherwise a generic update action: one that writes every edited field from
 *    an input and writes nothing but inputs, so what the person entered is what
 *    is written and nothing else changes;
 * 3. otherwise the exact action whose literal or `now` effects would write
 *    something else, with those fields named in `overrides`, so the module
 *    shows what it will write and asks before running it;
 * 4. otherwise nothing. The module then says no declared action covers the
 *    change rather than writing through a second path the executor does not know.
 *
 * `allowed` narrows the candidates to the actions this caller may run, so a
 * save never picks one the grant refuses while another would have done.
 */
export function saveAction(
  definition: CapabilityDefinition,
  collectionKey: string,
  edited: Record<string, unknown>,
  allowed: (action: ActionSpec) => boolean = () => true,
): { action: ActionSpec; overrides: SaveOverride[] } | undefined {
  const editedKeys = Object.keys(edited)
  if (!editedKeys.length) return undefined
  const candidates = updateActions(definition, collectionKey).filter(allowed)
  const exact = candidates.filter(
    (action) =>
      covers(action, editedKeys) &&
      effectKeys(action).length === editedKeys.length,
  )
  const faithful = exact.find((action) => !overridesOf(action, edited).length)
  if (faithful) return { action: faithful, overrides: [] }
  // A generic update writes only what it is given: an action that also writes
  // a literal or the time it runs would change a field nobody edited unasked.
  const generic = candidates.find(
    (action) =>
      action.effects.every((effect) => effect.source === 'input') &&
      editedKeys.every((key) => inputKeyOf(action, key) !== undefined),
  )
  if (generic) return { action: generic, overrides: [] }
  const declared = exact[0]
  return declared
    ? { action: declared, overrides: overridesOf(declared, edited) }
    : undefined
}

/**
 * The inputs one action call carries for a record's field values: each input
 * an effect writes a field from takes that field's value, under the input's own
 * key (`{ fieldKey: 'title', source: 'input', key: 'new_title' }` sends the
 * title as `new_title`). An input no effect reads falls back to the field of
 * its own name. A literal or `now` effect takes no input, and an input the
 * action does not declare is not sent (a strict server refuses it).
 */
export function inputsFor(
  action: ActionSpec,
  fields: Record<string, unknown>,
): Record<string, unknown> {
  const inputs: Record<string, unknown> = {}
  for (const input of action.input) {
    const effect = action.effects.find(
      (one) => one.source === 'input' && one.key === input.key,
    )
    const fieldKey = effect?.fieldKey ?? input.key
    if (Object.hasOwn(fields, fieldKey)) inputs[input.key] = fields[fieldKey]
  }
  return inputs
}

/** Whether this caller's grant reaches an action: an invoke list of `["*"]` is every action. */
export function canInvoke(
  grant: { invoke: string[] },
  actionKey: string,
): boolean {
  return grant.invoke.includes('*') || grant.invoke.includes(actionKey)
}

// ── Values ──────────────────────────────────────────────────────────────────

/** The text an input holds for a value: the wire form the contract expects back. */
export function valueText(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

/** What an input's text parsed into: a typed value, or why it is not one. */
export type Parsed =
  { ok: true; value: unknown } | { ok: false; message: string }

const absent: Parsed = { ok: true, value: null }

/**
 * An input's text as the typed value the action's input declares. Numbers and
 * integers are refused rather than rounded when they do not parse. A blank
 * text parses to null, which only marks it blank: the caller refuses a blank
 * required field and leaves a blank optional one out of the call.
 */
export function parseValue(type: CapabilityFieldType, text: string): Parsed {
  const trimmed = text.trim()
  switch (type.kind) {
    case 'text':
      return trimmed ? { ok: true, value: trimmed } : absent
    case 'number':
    case 'integer': {
      if (!trimmed) return absent
      const n = Number(trimmed)
      if (!Number.isFinite(n)) return { ok: false, message: 'not a number' }
      if (type.kind !== 'integer') return { ok: true, value: n }
      if (!Number.isInteger(n))
        return { ok: false, message: 'not a whole number' }
      // Past 2^53 a number no longer holds every whole value: 9007199254740993
      // would be stored as ...992, so it is refused rather than rounded.
      return Number.isSafeInteger(n)
        ? { ok: true, value: n }
        : { ok: false, message: 'too large to hold exactly' }
    }
    case 'boolean':
      if (trimmed === '') return absent
      if (trimmed === 'true') return { ok: true, value: true }
      if (trimmed === 'false') return { ok: true, value: false }
      return { ok: false, message: 'not true or false' }
    case 'date':
      // A calendar date, as the register holds it: YYYY-MM-DD.
      return /^\d{4}-\d{2}-\d{2}$/.test(trimmed)
        ? { ok: true, value: trimmed }
        : trimmed
          ? { ok: false, message: 'not a date (YYYY-MM-DD)' }
          : absent
    case 'timestamp': {
      if (!trimmed) return absent
      const at = new Date(trimmed)
      return Number.isNaN(at.getTime())
        ? { ok: false, message: 'not a timestamp (RFC 3339)' }
        : { ok: true, value: at.toISOString() }
    }
    case 'enum':
      if (!trimmed) return absent
      return type.variants.includes(trimmed)
        ? { ok: true, value: trimmed }
        : { ok: false, message: `not one of ${type.variants.join(', ')}` }
    case 'reference':
      return trimmed ? { ok: true, value: trimmed } : absent
  }
}

/** Whether an input field needs a value, as the caller reads the parse. */
export function isRequiredBlank(field: InputField, parsed: Parsed): boolean {
  return field.required && parsed.ok && parsed.value === null
}

/**
 * An action form's texts as the inputs the call carries. A blank optional field
 * is left out: an absent input applies no effect (the field is untouched on an
 * update and unwritten on a create), while the executor refuses a null input
 * rather than storing it. A blank required field is refused here so the form
 * says which one. An input the action does not declare is never sent: the
 * executor refuses unknown inputs.
 */
export function actionValues(
  action: ActionSpec,
  texts: Record<string, string>,
):
  | { ok: true; values: Record<string, unknown> }
  | { ok: false; errors: Record<string, string> } {
  const values: Record<string, unknown> = {}
  const errors: Record<string, string> = {}
  for (const field of action.input) {
    const parsed = parseValue(field.fieldType, texts[field.key] ?? '')
    if (!parsed.ok) {
      errors[field.key] = parsed.message
      continue
    }
    if (isRequiredBlank(field, parsed)) {
      errors[field.key] = 'needed'
      continue
    }
    if (parsed.value === null) continue
    values[field.key] = parsed.value
  }
  return Object.keys(errors).length
    ? { ok: false, errors }
    : { ok: true, values }
}

/** The collection keys an action's inputs reference, so a form loads what it needs. */
export function referencedCollections(action: ActionSpec): string[] {
  return [
    ...new Set(
      action.input.flatMap((field) =>
        field.fieldType.kind === 'reference'
          ? [field.fieldType.collectionKey]
          : [],
      ),
    ),
  ]
}

/** The one line a cell or a chip shows for a row: its first readable value. */
export function rowTitle(
  fields: ResolvedField[],
  row: CapabilityRecordRow,
): string {
  for (const field of fields) {
    if (field.fieldType.kind === 'relation') continue
    const value = row.fields[field.key]
    if (value === null || value === undefined || value === '') continue
    return typeof value === 'object' ? JSON.stringify(value) : String(value)
  }
  return row.id
}

// ── Filter editing ──────────────────────────────────────────────────────────

/** A comparison over one field, as the row editor offers it. */
export type LeafOp =
  | 'eq'
  | 'ne'
  | 'in'
  | 'lt'
  | 'lte'
  | 'gt'
  | 'gte'
  | 'contains'
  | 'is_empty'
  | 'is_not_empty'

/** A filter's leaf members: everything but the and/or/not groups. */
export type LeafFilter = Extract<QueryFilter, { op: LeafOp }>

/**
 * The leaf comparisons the filter editor offers for a field, in reading order.
 * A field the collection does not declare (one a stored filter still names) is
 * read as text: equality and presence, which every value can answer.
 */
export function opsForField(field: ResolvedField | undefined): LeafOp[] {
  const comparable: LeafOp[] = ['lt', 'lte', 'gt', 'gte']
  const equality: LeafOp[] = ['eq', 'ne']
  const presence: LeafOp[] = ['is_empty', 'is_not_empty']
  if (!field) return [...equality, ...presence]
  switch (field.fieldType.kind) {
    case 'integer':
    case 'number':
    case 'date':
    case 'timestamp':
      return [...equality, ...comparable, ...presence]
    case 'enum':
    case 'enum_many':
      return [...equality, 'in', ...presence]
    case 'text':
    case 'long_text':
      return [...equality, 'contains', 'in', ...presence]
    case 'boolean':
    case 'relation':
    case 'uuid':
    case 'json':
    case 'vector':
    case 'geometry':
      return [...equality, ...presence]
  }
}

/**
 * One editable row: a comparison over one field. `in` holds its values as a
 * comma-separated list, where a value holding a comma or a quote is written in
 * double quotes (`next, "Smith, Jane"`). `original` is the stored comparison a
 * row was read from: while the row is unedited it is written back as it was,
 * so a value the text cannot hold (an object, a null, a typed number in a text
 * field) survives a save that changed another row.
 */
export type FilterRow = {
  fieldKey: string
  op: LeafOp
  value: string
  original?: LeafFilter
}

/** Whether a leaf row needs no value. */
export const valueless = (op: LeafOp) =>
  op === 'is_empty' || op === 'is_not_empty'

export const isLeaf = (filter: QueryFilter): filter is LeafFilter =>
  filter.op !== 'and' && filter.op !== 'or' && filter.op !== 'not'

/**
 * The rows a view's filter reads as: a top-level `and` of leaves, or one leaf.
 * `groups` names what the row editor cannot show, so the dialog says what
 * saving would replace rather than quietly dropping it.
 */
export function filterRows(filter: QueryFilter): {
  rows: FilterRow[]
  groups: number
} {
  const conditions = filter.op === 'and' ? filter.conditions : [filter]
  const rows: FilterRow[] = []
  let groups = 0
  for (const condition of conditions) {
    if (isLeaf(condition)) rows.push(rowOfFilter(condition))
    else groups += 1
  }
  return { rows, groups }
}

/**
 * A row's text as the value the field's own type means, so a comparison over an
 * integer field reaches the executor as a number. A text that does not parse
 * goes as written rather than as NaN: the executor refuses what it cannot read,
 * and the person hears why.
 */
export function typedValue(field: ResolvedField, text: string): unknown {
  const trimmed = text.trim()
  switch (field.fieldType.kind) {
    case 'integer':
    case 'number': {
      const n = Number(trimmed)
      return trimmed && Number.isFinite(n) ? n : trimmed
    }
    case 'boolean':
      return trimmed === 'true' ? true : trimmed === 'false' ? false : trimmed
    default:
      return trimmed
  }
}

/**
 * The flat rows as the filter tree the author route takes: one `and` of leaves.
 * An empty `and` is what the contract calls match-all, so clearing the rows
 * says "every record" rather than nothing.
 */
export const rowsFilter = (
  rows: FilterRow[],
  fieldFor: (fieldKey: string) => ResolvedField | undefined,
): QueryFilter => ({
  op: 'and',
  conditions: rows.map((row) => filterOfRow(row, fieldFor)),
})

// SOURCING: a one-line list tokenizer rather than papaparse, which the app
// depends on: papaparse reads `next, "Smith, Jane"` as three fields, because a
// quote after the space a person types following a comma is not a quoted field
// to it, and that is exactly how a person types a list.
/** A list of values as the one line an `in` row shows: quoted where a value needs it. */
export function listText(values: unknown[]): string {
  return values
    .map((value) => {
      const text = valueText(value)
      return !text || text !== text.trim() || /[",]/.test(text)
        ? `"${text.replaceAll('"', '""')}"`
        : text
    })
    .join(', ')
}

/** The values an `in` row's line holds: split at commas outside double quotes. */
export function listValues(text: string): string[] {
  const values: string[] = []
  let current = ''
  let quoted = false
  let wasQuoted = false
  const finish = () => {
    const value = wasQuoted ? current : current.trim()
    if (value || wasQuoted) values.push(value)
    current = ''
    wasQuoted = false
  }
  for (let at = 0; at < text.length; at++) {
    const char = text[at]!
    if (quoted) {
      if (char === '"' && text[at + 1] === '"') {
        current += '"'
        at++
      } else if (char === '"') quoted = false
      else current += char
    } else if (char === '"' && !current.trim()) {
      current = ''
      quoted = true
      wasQuoted = true
    } else if (char === ',') finish()
    else if (!(wasQuoted && /\s/.test(char))) current += char
  }
  finish()
  return values
}

/** One leaf as the row the editor shows: field, op, and its value as text. */
export const rowOfFilter = (filter: LeafFilter): FilterRow => {
  switch (filter.op) {
    case 'in':
      return {
        fieldKey: filter.fieldKey,
        op: 'in',
        value: listText(filter.values),
        original: filter,
      }
    case 'is_empty':
      return {
        fieldKey: filter.fieldKey,
        op: 'is_empty',
        value: '',
        original: filter,
      }
    case 'is_not_empty':
      return {
        fieldKey: filter.fieldKey,
        op: 'is_not_empty',
        value: '',
        original: filter,
      }
    default:
      return {
        fieldKey: filter.fieldKey,
        op: filter.op,
        value: valueText(filter.value),
        original: filter,
      }
  }
}

/** One edited row as the leaf it means, its value typed by the field. */
export const filterOfRow = (
  row: FilterRow,
  fieldFor: (fieldKey: string) => ResolvedField | undefined,
): QueryFilter => {
  // An unedited row is the comparison it was read from, value for value.
  if (row.original) return row.original
  const field = fieldFor(row.fieldKey)
  const single = field ? typedValue(field, row.value) : row.value
  switch (row.op) {
    case 'in': {
      const parts = listValues(row.value)
      return {
        op: 'in',
        fieldKey: row.fieldKey,
        values: field ? parts.map((part) => typedValue(field, part)) : parts,
      }
    }
    case 'is_empty':
      return { op: 'is_empty', fieldKey: row.fieldKey }
    case 'is_not_empty':
      return { op: 'is_not_empty', fieldKey: row.fieldKey }
    case 'contains':
      return { op: 'contains', fieldKey: row.fieldKey, value: row.value }
    default:
      return { op: row.op, fieldKey: row.fieldKey, value: single }
  }
}

/** One line naming a filter, for the view bar and the empty state. */
export function describeFilter(filter: QueryFilter): string {
  const OP_LABEL: Record<QueryFilter['op'], string> = {
    and: 'and',
    or: 'or',
    not: 'not',
    eq: 'is',
    ne: 'is not',
    in: 'is one of',
    lt: 'is before',
    lte: 'is on or before',
    gt: 'is after',
    gte: 'is on or after',
    contains: 'contains',
    is_empty: 'is empty',
    is_not_empty: 'is not empty',
  }
  switch (filter.op) {
    case 'and':
      return filter.conditions.length
        ? filter.conditions.map(describeFilter).join(' and ')
        : 'every record'
    case 'or':
      return filter.conditions.length
        ? `(${filter.conditions.map(describeFilter).join(' or ')})`
        : 'every record'
    case 'not':
      return `not (${describeFilter(filter.condition)})`
    case 'in':
      return `${filter.fieldKey} ${OP_LABEL.in} ${listText(filter.values)}`
    case 'is_empty':
    case 'is_not_empty':
      return `${filter.fieldKey} ${OP_LABEL[filter.op]}`
    default:
      return `${filter.fieldKey} ${OP_LABEL[filter.op]} ${valueText(filter.value)}`
  }
}

// ── Page values ─────────────────────────────────────────────────────────────

/**
 * A capability record as a page value. Its id is the record's own, and the
 * instance and collection it was opened in ride in `scope`, the way an Index
 * item names where it was opened: an instance id can itself hold a slash
 * (`tracker/main`), so no flat string of joined parts reads back unambiguously.
 */
export const capabilityRecordItem = (
  instanceId: string,
  collectionKey: string,
  recordId: string,
  label?: string,
): Item => ({
  id: recordId,
  kind: 'capability-record',
  scope: { kind: 'capability', instanceId, collectionKey },
  ...(label ? { label } : {}),
})

/** The instance, collection and record a page value names, when it names one. */
export function parseCapabilityRecordItem(value: unknown):
  | {
      instanceId: string
      collectionKey: string
      recordId: string
    }
  | undefined {
  const item =
    typeof value === 'string'
      ? { id: value }
      : isItem(value)
        ? value
        : undefined
  if (!item?.id) return undefined
  const scope = item.scope
  if (
    scope?.kind === 'capability' &&
    typeof scope.instanceId === 'string' &&
    typeof scope.collectionKey === 'string'
  )
    return {
      instanceId: scope.instanceId,
      collectionKey: scope.collectionKey,
      recordId: item.id,
    }
  // A bare record id, as a setting names it, belongs to no collection until the
  // definition says which.
  return { instanceId: '', collectionKey: '', recordId: item.id }
}

// ── Authoring ───────────────────────────────────────────────────────────────

/** A field key the register will take: a lower slug, as the authoring path adds one. */
export const isValidFieldKey = (key: string) =>
  /^[a-z][a-z0-9_]{0,62}$/.test(key)

/** The op that adds an optional field, as slice 1 allows it. */
export const addFieldOp = (
  collectionKey: string,
  field: { key: string; label: string; fieldType: CapabilityFieldType },
): PatchOp => ({
  op: 'add_field',
  collectionKey,
  field: { ...field, required: false },
})

/** The op that renames one field's label. */
export const renameFieldOp = (
  collectionKey: string,
  fieldKey: string,
  label: string,
): PatchOp => ({ op: 'rename_field', collectionKey, fieldKey, label })

/** The op that replaces one view's filter. */
export const setViewFilterOp = (
  viewKey: string,
  filter: QueryFilter,
): PatchOp => ({
  op: 'set_view_filter',
  viewKey,
  filter,
})
