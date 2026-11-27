// SOURCING: the authoring dialog's parts (authoring-parts), the records' Segmented control for the
// layout and sort direction, coss ui Checkbox for display fields, the app's Button, and the filter
// tree editor beside this file. It sends the slice-2 view ops (add_view, replace_view, remove_view)
// over a copy of the view as read, so a part this editor does not show is sent back unchanged.
import { useMemo, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import { Checkbox } from '@/components/coss/checkbox'
import { Segmented } from '@/components/records/field-form'
import { Button } from '@/components/ui/button'
import { fieldControl } from '@/components/pages/resource-field'
import { matchAll } from '@/lib/capabilities/contract'
import type {
  CapabilityDefinition,
  CollectionSchema,
  OrderBy,
  ResolvedField,
  SortDirection,
  ViewLayout,
  ViewSpec,
} from '@/lib/capabilities/contract'
import {
  editTree,
  treeFilter,
  treeProblems,
} from '@/lib/capabilities/filter-tree'
import type { EditNode } from '@/lib/capabilities/filter-tree'
import {
  describeFilter,
  fieldsByKey,
  isValidFieldKey,
  schemaFor,
} from '@/lib/capabilities/model'
import { Choice, Note, Row } from './authoring-parts'
import type { Submit } from './authoring-parts'
import { FilterTreeEditor } from './filter-tree-editor'

const LAYOUTS: Array<{ value: ViewLayout; label: string }> = [
  { value: 'list', label: 'List' },
  { value: 'table', label: 'Table' },
  { value: 'board', label: 'Board' },
]

const DIRECTIONS: Array<{ value: SortDirection; label: string }> = [
  { value: 'asc', label: 'Ascending' },
  { value: 'desc', label: 'Descending' },
]

/** The choice that opens a new view rather than an existing one. */
const NEW = ''

/** The first of these views, or a new one when there is none. */
const firstViewKey = (views: ReadonlyArray<ViewSpec>) => views[0]?.key ?? NEW

/** Add a view, or change or remove one: label, layout, sort, display fields and the whole filter. */
export function ViewEditor({
  definition,
  schemas,
  startViewKey,
  definitionId,
  busy,
  onSubmit,
}: {
  definition: CapabilityDefinition
  schemas: CollectionSchema[]
  startViewKey: string
  definitionId: string
  busy: boolean
  onSubmit: Submit
}) {
  const [choice, setChoice] = useState(
    definition.views.some((view) => view.key === startViewKey)
      ? startViewKey
      : firstViewKey(definition.views),
  )
  // A fresh form after each add, so the next view starts blank.
  const [round, setRound] = useState(0)
  const view = definition.views.find((one) => one.key === choice)
  const options = [
    ...definition.views.map((one) => ({ value: one.key, label: one.label })),
    { value: NEW, label: 'New view…' },
  ]
  return (
    <div className="flex flex-col gap-2">
      <Row label="View">
        <Choice
          label="View to edit"
          value={view ? choice : NEW}
          options={options}
          onChange={setChoice}
        />
      </Row>
      <ViewForm
        key={`${view?.key ?? NEW}:${round}`}
        definition={definition}
        schemas={schemas}
        view={view}
        definitionId={definitionId}
        busy={busy}
        onSubmit={onSubmit}
        onReset={() => setRound((n) => n + 1)}
        onRemoved={() =>
          setChoice(
            firstViewKey(
              definition.views.filter((one) => one.key !== view?.key),
            ),
          )
        }
      />
    </div>
  )
}

/** What a new view's form starts from: a blank view over the first collection. */
const blankView = (definition: CapabilityDefinition): ViewSpec => ({
  key: '',
  label: '',
  collectionKey: definition.collections[0]?.key ?? '',
  layout: 'list',
  filter: matchAll(),
})

/** A new view's key and collection: what a saved one keeps and never shows. */
function newViewProblems(
  key: string,
  collectionKey: string,
  views: ReadonlyArray<ViewSpec>,
): string[] {
  const problems: string[] = []
  if (!isValidFieldKey(key)) problems.push('a lower_snake_case view key')
  else if (views.some((one) => one.key === key))
    problems.push('a key no other view has')
  if (!collectionKey) problems.push('a collection')
  return problems
}

/** What the form still needs before it can send, in the order it is asked for. */
function viewProblems({
  tree,
  view,
  key,
  collectionKey,
  label,
  displayFields,
  views,
}: {
  tree: EditNode
  view: ViewSpec | undefined
  key: string
  collectionKey: string
  label: string
  displayFields: string[] | undefined
  views: ReadonlyArray<ViewSpec>
}): string[] {
  const problems = [
    ...treeProblems(tree),
    ...(view ? [] : newViewProblems(key, collectionKey, views)),
  ]
  if (!label.trim()) problems.push('a label')
  // The server refuses a view that displays no field; every field is the
  // column list left out, which the "Show every field" box says.
  if (displayFields?.length === 0) problems.push('a column to show')
  return problems
}

/**
 * The view as it will be sent: the one read, with what this form edits laid
 * over it, so nothing it does not show is dropped. A sort the form cleared, or
 * a column list set back to every field, is left out; a list with every column
 * unticked is held back by `viewProblems`, never sent empty.
 */
function viewToSend(
  base: ViewSpec | Pick<ViewSpec, 'key' | 'collectionKey'>,
  edits: Pick<
    ViewSpec,
    'label' | 'layout' | 'filter' | 'orderBy' | 'displayFields'
  >,
): ViewSpec {
  const next: ViewSpec = {
    ...base,
    label: edits.label.trim(),
    layout: edits.layout,
    filter: edits.filter,
  }
  if (edits.orderBy) next.orderBy = edits.orderBy
  else delete next.orderBy
  if (edits.displayFields) next.displayFields = edits.displayFields
  else delete next.displayFields
  return next
}

function ViewForm({
  definition,
  schemas,
  view,
  definitionId,
  busy,
  onSubmit,
  onReset,
  onRemoved,
}: {
  definition: CapabilityDefinition
  schemas: CollectionSchema[]
  /** The view as read; absent for a new one. */
  view: ViewSpec | undefined
  definitionId: string
  busy: boolean
  onSubmit: Submit
  onReset: () => void
  onRemoved: () => void
}) {
  const collections = definition.collections.map((collection) => ({
    value: collection.key,
    label: collection.label,
  }))
  const start = view ?? blankView(definition)
  const [key, setKey] = useState('')
  const [label, setLabel] = useState(start.label)
  const [collectionKey, setCollectionKey] = useState(start.collectionKey)
  // A read view always names its layout, but nothing checks the answer: a
  // missing one is a list, as the table module draws it.
  const [layout, setLayout] = useState<ViewLayout>(view?.layout ?? 'list')
  const [orderBy, setOrderBy] = useState<OrderBy | undefined>(start.orderBy)
  const [displayFields, setDisplayFields] = useState<string[] | undefined>(
    start.displayFields,
  )
  const [tree, setTree] = useState(() => editTree(start.filter))
  const [base, setBase] = useState(definitionId)
  const stale = base !== definitionId
  const submit: Submit = async (ops, what) => {
    const saved = await onSubmit(ops, what, base)
    if (saved) setBase(saved)
    return saved
  }

  const schema = schemaFor(schemas, collectionKey)
  const fields = useMemo(() => fieldsByKey(schema), [schema])
  const fieldFor = (fieldKey: string) => fields.get(fieldKey)
  const filter = treeFilter(tree, fieldFor)

  const problems = viewProblems({
    tree,
    view,
    key,
    collectionKey,
    label,
    displayFields,
    views: definition.views,
  })

  const next = viewToSend(view ?? { key, collectionKey }, {
    label,
    layout,
    filter,
    orderBy,
    displayFields,
  })
  const blocked = problems.length > 0

  return (
    <div className="flex flex-col gap-2">
      {!view && (
        <NewViewFields
          viewKey={key}
          onViewKey={setKey}
          collectionKey={collectionKey}
          collections={collections}
          onCollection={(nextKey) => {
            // Another collection's fields: what named this one's is dropped.
            setCollectionKey(nextKey)
            setTree(editTree(matchAll()))
            setOrderBy(undefined)
            setDisplayFields(undefined)
          }}
        />
      )}
      <Row label="Label">
        <input
          aria-label="View label"
          className={fieldControl}
          value={label}
          onChange={(event) => setLabel(event.target.value)}
        />
      </Row>
      <div className="flex flex-col gap-1">
        <span className="text-xs font-medium text-ink-muted">Layout</span>
        <Segmented
          value={layout}
          options={LAYOUTS}
          onChange={setLayout}
          label="Layout"
        />
      </div>
      <SortPicker orderBy={orderBy} fields={fields} onChange={setOrderBy} />
      <DisplayFields
        shown={displayFields}
        schema={schema}
        fields={fields}
        onChange={setDisplayFields}
      />
      <div className="flex flex-col gap-1">
        <span className="text-xs font-medium text-ink-muted">Filter</span>
        <FilterTreeEditor tree={tree} fields={fields} onChange={setTree} />
        <Note>This view will read: {describeFilter(filter)}.</Note>
        <Note>
          A filter shapes what the view shows. It is not access control: the
          instance's grants decide who may read.
        </Note>
      </div>
      {stale && (
        <div
          role="alert"
          className="flex flex-col gap-2 rounded-md bg-raised p-2"
        >
          <Note>
            The definition changed while you were editing. Review the current
            view before replacing it.
          </Note>
          {view && (
            <Note>
              {view.label} · {view.layout} · {describeFilter(view.filter)}
            </Note>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              size="xs"
              variant="outline"
              disabled={busy}
              onClick={onReset}
            >
              Load current view
            </Button>
            <Button
              size="xs"
              variant="outline"
              disabled={busy}
              onClick={() => setBase(definitionId)}
            >
              Keep my draft
            </Button>
          </div>
        </div>
      )}
      {blocked && <Note>Still to do: {problems.join(', ')}.</Note>}
      {view ? (
        <SavedViewActions
          view={view}
          next={next}
          blocked={blocked}
          busy={busy || stale}
          onSubmit={submit}
          onRemoved={onRemoved}
        />
      ) : (
        <AddView
          next={next}
          blocked={blocked}
          busy={busy || stale}
          onSubmit={submit}
          onAdded={onReset}
        />
      )}
    </div>
  )
}

/** The key and collection a new view is created under; a saved view keeps both. */
function NewViewFields({
  viewKey,
  onViewKey,
  collectionKey,
  collections,
  onCollection,
}: {
  viewKey: string
  onViewKey: (key: string) => void
  collectionKey: string
  collections: Array<{ value: string; label: string }>
  onCollection: (collectionKey: string) => void
}) {
  return (
    <>
      <Row
        label="View key"
        hint="Stable: a page names the view it opens on by this key."
      >
        <input
          aria-label="View key"
          className={fieldControl}
          value={viewKey}
          placeholder="this_week"
          onChange={(event) => onViewKey(event.target.value.trim())}
        />
      </Row>
      <Row label="Collection">
        <Choice
          label="View collection"
          value={collectionKey}
          options={collections}
          onChange={onCollection}
        />
      </Row>
    </>
  )
}

/** The sort choices: none, a field the collection no longer declares, then its own fields. */
const sortOptions = (
  orderBy: OrderBy | undefined,
  fields: ReadonlyMap<string, ResolvedField>,
) => [
  { value: '', label: 'In the order they are stored' },
  ...(orderBy && !fields.has(orderBy.fieldKey)
    ? [{ value: orderBy.fieldKey, label: orderBy.fieldKey }]
    : []),
  ...[...fields.values()].map((field) => ({
    value: field.key,
    label: field.label,
  })),
]

/** Which field the view sorts by, and once there is one, which way. */
function SortPicker({
  orderBy,
  fields,
  onChange,
}: {
  orderBy: OrderBy | undefined
  fields: ReadonlyMap<string, ResolvedField>
  onChange: (orderBy: OrderBy | undefined) => void
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium text-ink-muted">Sort</span>
      <div className="flex items-center gap-1.5">
        <Choice
          label="Sort by"
          value={orderBy?.fieldKey ?? ''}
          options={sortOptions(orderBy, fields)}
          onChange={(fieldKey) =>
            onChange(
              fieldKey
                ? { fieldKey, direction: orderBy?.direction ?? 'asc' }
                : undefined,
            )
          }
        />
        {orderBy && (
          <Segmented
            value={orderBy.direction}
            options={DIRECTIONS}
            onChange={(direction) => onChange({ ...orderBy, direction })}
            label="Sort direction"
          />
        )}
      </div>
    </div>
  )
}

type DisplayFieldsChange = Dispatch<SetStateAction<string[] | undefined>>

/** Every field in the collection's order, or the columns chosen, in the order chosen. */
function DisplayFields({
  shown,
  schema,
  fields,
  onChange,
}: {
  shown: string[] | undefined
  schema: CollectionSchema | undefined
  fields: ReadonlyMap<string, ResolvedField>
  onChange: DisplayFieldsChange
}) {
  return (
    <fieldset className="flex flex-col gap-1">
      <legend className="text-xs font-medium text-ink-muted">
        Display fields
      </legend>
      {/* Named by aria-label, as the table's row checkboxes are: a wrapping
          label would activate the control twice. */}
      <div className="flex items-center gap-2 text-xs text-ink">
        <Checkbox
          aria-label="Show every field"
          checked={!shown}
          onCheckedChange={(checked) =>
            onChange(
              checked === true
                ? undefined
                : (schema?.fields ?? []).map((field) => field.key),
            )
          }
        />
        <span>Every field, in the collection's order</span>
      </div>
      {shown && (
        <ColumnTicks
          shown={shown}
          schema={schema}
          fields={fields}
          onChange={onChange}
        />
      )}
    </fieldset>
  )
}

/** One box per column the view may show, kept in the order they were ticked. */
function ColumnTicks({
  shown,
  schema,
  fields,
  onChange,
}: {
  shown: string[]
  schema: CollectionSchema | undefined
  fields: ReadonlyMap<string, ResolvedField>
  onChange: DisplayFieldsChange
}) {
  const columnKeys = [
    ...(schema?.fields ?? []).map((field) => field.key),
    // A display field the collection no longer declares is still the view's.
    ...shown.filter((one) => !fields.has(one)),
  ]
  const toggleColumn = (fieldKey: string, on: boolean) =>
    onChange((held) => {
      const base = held ?? []
      return on
        ? [...base.filter((one) => one !== fieldKey), fieldKey]
        : base.filter((one) => one !== fieldKey)
    })
  return (
    <>
      {columnKeys.map((fieldKey) => {
        const label = fields.get(fieldKey)?.label ?? fieldKey
        return (
          <div
            key={fieldKey}
            className="flex items-center gap-2 ps-4 text-xs text-ink"
          >
            <Checkbox
              aria-label={`Show ${label}`}
              checked={shown.includes(fieldKey)}
              onCheckedChange={(checked) =>
                toggleColumn(fieldKey, checked === true)
              }
            />
            <span>{label}</span>
          </div>
        )
      })}
      <Note>Columns show in the order they were chosen.</Note>
    </>
  )
}

/** Send what the form holds, once nothing is still to do. */
function SendButton({
  blocked,
  busy,
  onClick,
  children,
}: {
  blocked: boolean
  busy: boolean
  onClick: () => void
  children: string
}) {
  return (
    <Button
      size="sm"
      disabled={blocked || busy}
      aria-busy={busy}
      onClick={onClick}
    >
      {children}
    </Button>
  )
}

/** A new view's one action: add it, then start a blank form for the next. */
function AddView({
  next,
  blocked,
  busy,
  onSubmit,
  onAdded,
}: {
  next: ViewSpec
  blocked: boolean
  busy: boolean
  onSubmit: Submit
  onAdded: () => void
}) {
  const add = async () => {
    if (await onSubmit([{ op: 'add_view', view: next }], 'View added'))
      onAdded()
  }
  return (
    <div className="flex items-center gap-1.5">
      <SendButton blocked={blocked} busy={busy} onClick={() => void add()}>
        Add view
      </SendButton>
    </div>
  )
}

/** A saved view's actions: save it over what was read, or remove it after asking. */
function SavedViewActions({
  view,
  next,
  blocked,
  busy,
  onSubmit,
  onRemoved,
}: {
  view: ViewSpec
  next: ViewSpec
  blocked: boolean
  busy: boolean
  onSubmit: Submit
  onRemoved: () => void
}) {
  const [removing, setRemoving] = useState(false)
  const remove = async () => {
    if (
      await onSubmit([{ op: 'remove_view', viewKey: view.key }], 'View removed')
    )
      onRemoved()
  }
  return (
    <>
      <div className="flex items-center gap-1.5">
        <SendButton
          blocked={blocked}
          busy={busy}
          onClick={() =>
            void onSubmit([{ op: 'replace_view', view: next }], 'View saved')
          }
        >
          Save view
        </SendButton>
        {!removing && (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => setRemoving(true)}
          >
            Remove view
          </Button>
        )}
      </div>
      {removing && (
        <div className="flex flex-col gap-1.5 rounded-md bg-raised p-2">
          <p className="text-xs text-ink">
            Remove {view.label} from the definition? Records are not changed,
            and an earlier definition that still has it can be re-pinned from
            History.
          </p>
          <div className="flex gap-1.5">
            <Button
              size="xs"
              variant="destructive"
              disabled={busy}
              aria-label="Confirm remove view"
              onClick={() => void remove()}
            >
              Remove
            </Button>
            <Button
              size="xs"
              variant="ghost"
              onClick={() => setRemoving(false)}
            >
              Keep it
            </Button>
          </div>
        </div>
      )}
    </>
  )
}
