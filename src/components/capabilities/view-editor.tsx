// SOURCING: the authoring dialog's parts (authoring-parts), the records' Segmented control for the
// layout and sort direction, coss ui Checkbox for display fields, the app's Button, and the filter
// tree editor beside this file. It sends the slice-2 view ops (add_view, replace_view, remove_view)
// over a copy of the view as read, so a part this editor does not show is sent back unchanged.
import { useMemo, useState } from 'react'
import { Checkbox } from '@/components/coss/checkbox'
import { Segmented } from '@/components/records/field-form'
import { Button } from '@/components/ui/button'
import { fieldControl } from '@/components/pages/resource-field'
import { matchAll } from '@/lib/capabilities/contract'
import type {
  CapabilityDefinition,
  CollectionSchema,
  OrderBy,
  SortDirection,
  ViewLayout,
  ViewSpec,
} from '@/lib/capabilities/contract'
import {
  editTree,
  treeFilter,
  treeProblems,
} from '@/lib/capabilities/filter-tree'
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

/** Add a view, or change or remove one: label, layout, sort, display fields and the whole filter. */
export function ViewEditor({
  definition,
  schemas,
  startViewKey,
  busy,
  onSubmit,
}: {
  definition: CapabilityDefinition
  schemas: CollectionSchema[]
  startViewKey: string
  busy: boolean
  onSubmit: Submit
}) {
  const [choice, setChoice] = useState(
    definition.views.some((view) => view.key === startViewKey)
      ? startViewKey
      : (definition.views[0]?.key ?? NEW),
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
        busy={busy}
        onSubmit={onSubmit}
        onAdded={() => setRound((n) => n + 1)}
        onRemoved={() =>
          setChoice(
            definition.views.find((one) => one.key !== view?.key)?.key ?? NEW,
          )
        }
      />
    </div>
  )
}

function ViewForm({
  definition,
  schemas,
  view,
  busy,
  onSubmit,
  onAdded,
  onRemoved,
}: {
  definition: CapabilityDefinition
  schemas: CollectionSchema[]
  /** The view as read; absent for a new one. */
  view: ViewSpec | undefined
  busy: boolean
  onSubmit: Submit
  onAdded: () => void
  onRemoved: () => void
}) {
  const collections = definition.collections.map((collection) => ({
    value: collection.key,
    label: collection.label,
  }))
  const [key, setKey] = useState('')
  const [label, setLabel] = useState(view?.label ?? '')
  const [collectionKey, setCollectionKey] = useState(
    view?.collectionKey ?? collections[0]?.value ?? '',
  )
  const [layout, setLayout] = useState<ViewLayout>(view?.layout ?? 'list')
  const [orderBy, setOrderBy] = useState<OrderBy | undefined>(view?.orderBy)
  const [displayFields, setDisplayFields] = useState<string[] | undefined>(
    view?.displayFields,
  )
  const [tree, setTree] = useState(() => editTree(view?.filter ?? matchAll()))
  const [removing, setRemoving] = useState(false)

  const schema = schemaFor(schemas, collectionKey)
  const fields = useMemo(() => fieldsByKey(schema), [schema])
  const fieldFor = (fieldKey: string) => fields.get(fieldKey)
  const filter = treeFilter(tree, fieldFor)

  const problems = [...treeProblems(tree)]
  if (!view) {
    if (!isValidFieldKey(key)) problems.push('a lower_snake_case view key')
    else if (definition.views.some((one) => one.key === key))
      problems.push('a key no other view has')
    if (!collectionKey) problems.push('a collection')
  }
  if (!label.trim()) problems.push('a label')

  // The view as it will be sent: the one read, with what this form edits laid
  // over it, so nothing it does not show is dropped.
  const next: ViewSpec = {
    ...(view ?? { key, collectionKey }),
    key: view?.key ?? key,
    collectionKey: view?.collectionKey ?? collectionKey,
    label: label.trim(),
    layout,
    filter,
  }
  if (orderBy) next.orderBy = orderBy
  else delete next.orderBy
  if (displayFields) next.displayFields = displayFields
  else delete next.displayFields

  const shown = displayFields
  const columnKeys = [
    ...(schema?.fields ?? []).map((field) => field.key),
    // A display field the collection no longer declares is still the view's.
    ...(shown ?? []).filter((one) => !fields.has(one)),
  ]
  const toggleColumn = (fieldKey: string, on: boolean) =>
    setDisplayFields((held) => {
      const base = held ?? []
      return on
        ? [...base.filter((one) => one !== fieldKey), fieldKey]
        : base.filter((one) => one !== fieldKey)
    })

  const save = async () => {
    const taken = await onSubmit(
      [view ? { op: 'replace_view', view: next } : { op: 'add_view', view: next }],
      view ? 'View saved' : 'View added',
    )
    if (taken && !view) onAdded()
  }
  const remove = async () => {
    if (!view) return
    const taken = await onSubmit(
      [{ op: 'remove_view', viewKey: view.key }],
      'View removed',
    )
    if (taken) onRemoved()
  }

  return (
    <div className="flex flex-col gap-2">
      {!view && (
        <>
          <Row
            label="View key"
            hint="Stable: a page names the view it opens on by this key."
          >
            <input
              aria-label="View key"
              className={fieldControl}
              value={key}
              placeholder="this_week"
              onChange={(event) => setKey(event.target.value.trim())}
            />
          </Row>
          <Row label="Collection">
            <Choice
              label="View collection"
              value={collectionKey}
              options={collections}
              onChange={(nextKey) => {
                // Another collection's fields: what named this one's is dropped.
                setCollectionKey(nextKey)
                setTree(editTree(matchAll()))
                setOrderBy(undefined)
                setDisplayFields(undefined)
              }}
            />
          </Row>
        </>
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
      <div className="flex flex-col gap-1">
        <span className="text-xs font-medium text-ink-muted">Sort</span>
        <div className="flex items-center gap-1.5">
          <Choice
            label="Sort by"
            value={orderBy?.fieldKey ?? ''}
            options={[
              { value: '', label: 'In the order they are stored' },
              ...(orderBy && !fields.has(orderBy.fieldKey)
                ? [{ value: orderBy.fieldKey, label: orderBy.fieldKey }]
                : []),
              ...[...fields.values()].map((field) => ({
                value: field.key,
                label: field.label,
              })),
            ]}
            onChange={(fieldKey) =>
              setOrderBy(
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
              onChange={(direction) => setOrderBy({ ...orderBy, direction })}
              label="Sort direction"
            />
          )}
        </div>
      </div>
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
              setDisplayFields(
                checked === true
                  ? undefined
                  : (schema?.fields ?? []).map((field) => field.key),
              )
            }
          />
          <span>Every field, in the collection's order</span>
        </div>
        {shown &&
          columnKeys.map((fieldKey) => (
            <div
              key={fieldKey}
              className="flex items-center gap-2 ps-4 text-xs text-ink"
            >
              <Checkbox
                aria-label={`Show ${fields.get(fieldKey)?.label ?? fieldKey}`}
                checked={shown.includes(fieldKey)}
                onCheckedChange={(checked) =>
                  toggleColumn(fieldKey, checked === true)
                }
              />
              <span>{fields.get(fieldKey)?.label ?? fieldKey}</span>
            </div>
          ))}
        {shown && (
          <Note>Columns show in the order they were chosen.</Note>
        )}
      </fieldset>
      <div className="flex flex-col gap-1">
        <span className="text-xs font-medium text-ink-muted">Filter</span>
        <FilterTreeEditor tree={tree} fields={fields} onChange={setTree} />
        <Note>This view will read: {describeFilter(filter)}.</Note>
        <Note>
          A filter shapes what the view shows. It is not access control: the
          instance's grants decide who may read.
        </Note>
      </div>
      {problems.length > 0 && <Note>Still to do: {problems.join(', ')}.</Note>}
      <div className="flex items-center gap-1.5">
        <Button
          size="sm"
          disabled={problems.length > 0 || busy}
          aria-busy={busy}
          onClick={() => void save()}
        >
          {view ? 'Save view' : 'Add view'}
        </Button>
        {view && !removing && (
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
      {view && removing && (
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
            <Button size="xs" variant="ghost" onClick={() => setRemoving(false)}>
              Keep it
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
