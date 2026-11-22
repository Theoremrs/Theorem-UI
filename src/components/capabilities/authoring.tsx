// SOURCING: the narrow authoring controls the plan's UI section names (add an optional field, rename
// a field's label, edit one view's filter), over the author route in lib/capabilities/api; the
// records' Segmented control, the app's Dialog, and the native field styling pages/resource-field.tsx
// uses. Each control sends one PatchOp naming the definition id it read, so two people authoring one
// definition cannot overwrite each other blind.
import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Segmented } from '@/components/records/field-form'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { fieldControl } from '@/components/pages/resource-field'
import { codes } from '@/lib/capabilities/contract'
import type {
  CapabilityDefinition,
  CapabilityFieldType,
  CollectionSchema,
  PatchOp,
  QueryFilter,
} from '@/lib/capabilities/contract'
import {
  addFieldOp,
  describeFilter,
  fieldsByKey,
  filterRows,
  isValidFieldKey,
  opsForField,
  renameFieldOp,
  rowsFilter,
  schemaFor,
  setViewFilterOp,
  valueless,
} from '@/lib/capabilities/model'
import type { FilterRow } from '@/lib/capabilities/model'
import { refusalCode, refusalMessage } from '@/lib/capabilities/api'
import { capabilityKeys, useCapabilityAuthor } from './queries'

const TABS = [
  { value: 'add', label: 'Add field' },
  { value: 'rename', label: 'Rename' },
  { value: 'filter', label: 'View filter' },
] as const

type Tab = (typeof TABS)[number]['value']

/** The capability field vocabulary, as the contract declares it. */
const TYPES: Array<{ value: CapabilityFieldType['kind']; label: string }> = [
  { value: 'text', label: 'Text' },
  { value: 'number', label: 'Number' },
  { value: 'integer', label: 'Integer' },
  { value: 'boolean', label: 'True/False' },
  { value: 'date', label: 'Date' },
  { value: 'timestamp', label: 'Date and time' },
  { value: 'enum', label: 'Select' },
  { value: 'reference', label: 'Reference' },
]

/** The chosen type, with whatever its kind needs. */
function fieldTypeOf(
  kind: CapabilityFieldType['kind'],
  variants: string,
  referenced: string,
): CapabilityFieldType {
  switch (kind) {
    case 'enum':
      return {
        kind: 'enum',
        variants: variants
          .split(',')
          .map((one) => one.trim())
          .filter(Boolean),
      }
    case 'reference':
      return { kind: 'reference', collectionKey: referenced }
    case 'text':
    case 'number':
    case 'integer':
    case 'boolean':
    case 'date':
    case 'timestamp':
      return { kind }
  }
}

function Row({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: ReactNode
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium text-ink-muted">{label}</span>
      {children}
      {hint && <span className="text-xs text-ink-faint">{hint}</span>}
    </label>
  )
}

function Choice({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: string
  options: Array<{ value: string; label: string }>
  onChange: (value: string) => void
}) {
  return (
    <select
      aria-label={label}
      className={fieldControl}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  )
}

type Status = {
  kind: 'pending' | 'saved' | 'failed'
  message: string
  /** A read that failed and can be asked again. */
  retry?: () => void
}

/** One control's line: what it is doing, and the refusal that stopped it. */
function StatusLine({ status }: { status: Status | undefined }) {
  if (!status) return null
  return (
    <div
      role={status.kind === 'failed' ? 'alert' : 'status'}
      className={
        status.kind === 'failed'
          ? 'flex items-center gap-2 rounded-md bg-error-container px-2 py-1.5 text-xs text-error-ink'
          : 'flex items-center gap-2 rounded-md bg-raised px-2 py-1.5 text-xs text-ink-muted'
      }
    >
      <span className="min-w-0 flex-1">{status.message}</span>
      {status.retry && (
        <Button size="xs" variant="outline" onClick={status.retry}>
          Read it again
        </Button>
      )}
    </div>
  )
}

/**
 * The authoring controls for one instance, opened from the table module that
 * shows its rows. A patch names the definition id the rows were read under; a
 * stale one is refused and the dialog says so, having read the current
 * definition back.
 */
export function AuthoringDialog({
  instanceId,
  definition,
  schemas,
  viewKey,
  expectedDefinitionId,
  onClose,
}: {
  instanceId: string
  definition: CapabilityDefinition
  schemas: CollectionSchema[]
  /** The view the module is showing, which the filter editor starts from. */
  viewKey: string
  expectedDefinitionId: string
  onClose: () => void
}) {
  const [tab, setTab] = useState<Tab>('add')
  const [status, setStatus] = useState<Status | undefined>()
  // Reading the current definition back after a conflict: nothing is sent
  // until it has answered, so a retry is authored against what is really there.
  const [refreshing, setRefreshing] = useState(false)
  const authoring = useCapabilityAuthor(instanceId)
  const client = useQueryClient()
  const busy = authoring.isPending || refreshing

  const collections = definition.collections.map((collection) => ({
    value: collection.key,
    label: collection.label,
  }))
  const views = definition.views.map((view) => ({
    value: view.key,
    label: view.label,
  }))

  /** Read the instance again, and say so only once its definition is back. */
  const reread = async (conflict: string) => {
    setRefreshing(true)
    setStatus({
      kind: 'pending',
      message: `${conflict} Reading the current definition…`,
    })
    try {
      await client.invalidateQueries(
        { queryKey: capabilityKeys.instance(instanceId) },
        { throwOnError: true },
      )
      setStatus({
        kind: 'failed',
        message: `${conflict} The current definition has been read again: check your change against the fields now shown and submit it once more.`,
      })
    } catch (error) {
      setStatus({
        kind: 'failed',
        message: `${conflict} Reading the current definition failed too: ${refusalMessage(error, 'The definition')}`,
        retry: () => void reread(conflict),
      })
    } finally {
      setRefreshing(false)
    }
  }

  /**
   * Send one op. `base` is the definition id the change was drafted against,
   * when the control holds a draft; otherwise the one on screen now. Answers
   * whether the definition took it.
   */
  const submit = async (
    op: PatchOp,
    what: string,
    base?: string,
  ): Promise<boolean> => {
    const expected = base ?? expectedDefinitionId
    if (!expected) {
      setStatus({
        kind: 'failed',
        message:
          'Nothing is loaded to author against. Reload the view, then try again.',
      })
      return false
    }
    setStatus({ kind: 'pending', message: `${what}…` })
    try {
      const result = await authoring.mutateAsync({
        expectedDefinitionId: expected,
        ops: [op],
      })
      setStatus({
        kind: 'saved',
        message: `${what} · the definition is now ${result.definitionId}.`,
      })
      return true
    } catch (error) {
      if (refusalCode(error) === codes.DEFINITION_CONFLICT)
        await reread(refusalMessage(error, 'Authoring'))
      else
        setStatus({
          kind: 'failed',
          message: refusalMessage(error, 'Authoring'),
        })
      return false
    }
  }

  return (
    <Dialog open onOpenChange={(shown) => !shown && onClose()}>
      <DialogContent showCloseButton={false} className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Author {definition.name}</DialogTitle>
          <DialogDescription>
            A change mints a new definition version and re-pins this instance.
            Records never move.
          </DialogDescription>
        </DialogHeader>

        <Segmented
          value={tab}
          options={[...TABS]}
          onChange={setTab}
          label="What to change"
        />
        <StatusLine status={status} />

        {tab === 'add' && (
          <AddField
            collections={collections}
            schemas={schemas}
            busy={busy}
            onSubmit={(op) => submit(op, 'Field added')}
          />
        )}
        {tab === 'rename' && (
          <RenameField
            collections={collections}
            schemas={schemas}
            busy={busy}
            onSubmit={(op) => submit(op, 'Field renamed')}
          />
        )}
        {tab === 'filter' && (
          <ViewFilter
            definition={definition}
            schemas={schemas}
            views={views}
            startViewKey={viewKey}
            definitionId={expectedDefinitionId}
            busy={busy}
            onSubmit={(op, base) => submit(op, 'View filter set', base)}
          />
        )}

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function AddField({
  collections,
  schemas,
  busy,
  onSubmit,
}: {
  collections: Array<{ value: string; label: string }>
  schemas: CollectionSchema[]
  busy: boolean
  onSubmit: (op: PatchOp) => void
}) {
  const [collectionKey, setCollectionKey] = useState(
    collections[0]?.value ?? '',
  )
  const [key, setKey] = useState('')
  const [label, setLabel] = useState('')
  const [kind, setKind] = useState<CapabilityFieldType['kind']>('text')
  const [variants, setVariants] = useState('')
  const [referenced, setReferenced] = useState(collections[0]?.value ?? '')

  const fieldType = fieldTypeOf(kind, variants, referenced)
  const problems: string[] = []
  if (!collectionKey) problems.push('choose a collection')
  if (!isValidFieldKey(key)) problems.push('a lower_snake_case key')
  if (!label.trim()) problems.push('a label')
  if (fieldType.kind === 'enum' && !fieldType.variants.length)
    problems.push('at least one variant')
  if (kind === 'reference' && !referenced) problems.push('what it refers to')

  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault()
        if (problems.length || busy) return
        onSubmit(
          addFieldOp(collectionKey, { key, label: label.trim(), fieldType }),
        )
      }}
    >
      <Row label="Collection">
        <Choice
          label="Collection"
          value={collectionKey}
          options={collections}
          onChange={setCollectionKey}
        />
      </Row>
      <Row
        label="Field key"
        hint="Stable: a view and an action name a field by it."
      >
        <input
          aria-label="Field key"
          className={fieldControl}
          value={key}
          onChange={(event) => setKey(event.target.value.trim())}
          placeholder="effort_minutes"
        />
      </Row>
      <Row label="Label">
        <input
          aria-label="Field label"
          className={fieldControl}
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          placeholder="Effort (minutes)"
        />
      </Row>
      <Row label="Type">
        <Choice
          label="Field type"
          value={kind}
          options={TYPES.map((type) => ({
            value: type.value,
            label: type.label,
          }))}
          onChange={(value) => setKind(value as CapabilityFieldType['kind'])}
        />
      </Row>
      {kind === 'enum' && (
        <Row label="Variants" hint="Comma-separated.">
          <input
            aria-label="Enum variants"
            className={fieldControl}
            value={variants}
            onChange={(event) => setVariants(event.target.value)}
            placeholder="next, done"
          />
        </Row>
      )}
      {kind === 'reference' && (
        <Row label="Refers to">
          <Choice
            label="Referenced collection"
            value={referenced}
            options={collections}
            onChange={setReferenced}
          />
        </Row>
      )}
      <p className="text-xs text-ink-faint">
        {schemaFor(schemas, collectionKey)?.fields.length ?? 0} fields are
        already declared here. Slice 1 adds optional fields only: a required
        field, a removal or a type change is refused as unsupported.
      </p>
      {problems.length > 0 && (
        <p className="text-xs text-ink-faint">
          Still to do: {problems.join(', ')}.
        </p>
      )}
      <Button
        size="sm"
        type="submit"
        disabled={problems.length > 0 || busy}
        aria-busy={busy}
        aria-label="Add optional field"
      >
        Add field
      </Button>
    </form>
  )
}

function RenameField({
  collections,
  schemas,
  busy,
  onSubmit,
}: {
  collections: Array<{ value: string; label: string }>
  schemas: CollectionSchema[]
  busy: boolean
  onSubmit: (op: PatchOp) => void
}) {
  const [collectionKey, setCollectionKey] = useState(
    collections[0]?.value ?? '',
  )
  const fields = schemaFor(schemas, collectionKey)?.fields ?? []
  const [fieldKey, setFieldKey] = useState('')
  const chosen = fields.find((field) => field.key === fieldKey) ?? fields[0]
  const [label, setLabel] = useState('')

  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault()
        if (!chosen || !label.trim() || busy) return
        onSubmit(renameFieldOp(collectionKey, chosen.key, label.trim()))
      }}
    >
      <Row label="Collection">
        <Choice
          label="Collection"
          value={collectionKey}
          options={collections}
          onChange={(next) => {
            setCollectionKey(next)
            setFieldKey('')
          }}
        />
      </Row>
      <Row label="Field">
        <Choice
          label="Field"
          value={chosen?.key ?? ''}
          options={fields.map((field) => ({
            value: field.key,
            label: field.label,
          }))}
          onChange={setFieldKey}
        />
      </Row>
      <Row
        label="New label"
        hint="The field keeps its key, so views and actions still name it."
      >
        <input
          aria-label="New label"
          className={fieldControl}
          value={label}
          placeholder={chosen?.label ?? 'Current label'}
          onChange={(event) => setLabel(event.target.value)}
        />
      </Row>
      <Button
        size="sm"
        type="submit"
        disabled={!chosen || !label.trim() || busy}
        aria-busy={busy}
      >
        Rename field
      </Button>
    </form>
  )
}

/**
 * One view's filter, as rows of field / op / value. The rows are a flat `and`:
 * an or or not group is what this editor cannot show yet, and the dialog says so
 * rather than dropping one quietly. Editing another view's rows does not keep
 * these.
 *
 * Saving replaces the whole filter, so edited rows keep the definition id they
 * were drafted against. When another author moves the definition on meanwhile,
 * the editor shows the filter now stored and asks the person to keep their rows
 * or take the stored ones before anything is sent; nothing rebases quietly.
 */
function ViewFilter({
  definition,
  schemas,
  views,
  startViewKey,
  definitionId,
  busy,
  onSubmit,
}: {
  definition: CapabilityDefinition
  schemas: CollectionSchema[]
  views: Array<{ value: string; label: string }>
  startViewKey: string
  /** The definition id on screen now. */
  definitionId: string
  busy: boolean
  onSubmit: (op: PatchOp, base: string) => Promise<boolean>
}) {
  const [viewKey, setViewKey] = useState(startViewKey)
  const view =
    definition.views.find((one) => one.key === viewKey) ?? definition.views[0]
  const declared = useMemo(
    () => (view ? filterRows(view.filter) : { rows: [], groups: 0 }),
    [view],
  )
  const [editing, setEditing] = useState<{
    viewKey: string
    rows: FilterRow[]
    /** The definition id the rows were drafted against. */
    definitionId: string
  }>()
  const fields = useMemo(
    () => fieldsByKey(schemaFor(schemas, view?.collectionKey ?? '')),
    [schemas, view],
  )
  if (!view)
    return (
      <p className="text-xs text-ink-muted">
        This definition declares no view yet.
      </p>
    )
  const drafting = editing?.viewKey === view.key ? editing : undefined
  const held = drafting ? drafting.rows : declared.rows
  const base = drafting?.definitionId ?? definitionId
  const stale = !!drafting && drafting.definitionId !== definitionId
  const setRows = (updater: (rows: FilterRow[]) => FilterRow[]) =>
    setEditing({ viewKey: view.key, rows: updater(held), definitionId: base })
  /** A row the person changed: it is written from its text, not as it was read. */
  const edited = (row: FilterRow, change: Partial<FilterRow>): FilterRow => {
    const next = { ...row, ...change }
    delete next.original
    return next
  }

  const fieldFor = (key: string) => fields.get(key)
  const producing: QueryFilter = rowsFilter(held, fieldFor)
  const fieldOptions = [...fields.values()].map((field) => ({
    value: field.key,
    label: field.label,
  }))

  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault()
        if (busy || stale || held.some((row) => !row.fieldKey)) return
        // Once saved, the stored filter is these rows: the draft is done,
        // unless it was changed again while the save was running.
        const submitted = held
        void onSubmit(setViewFilterOp(view.key, producing), base).then(
          (taken) =>
            taken &&
            setEditing((current) =>
              current?.rows === submitted ? undefined : current,
            ),
        )
      }}
    >
      <Row label="View">
        <Choice
          label="View"
          value={view.key}
          options={views}
          onChange={setViewKey}
        />
      </Row>
      <p className="text-xs text-ink-muted">
        Over {view.collectionKey}. Conditions combine with AND; an or or not
        group is a follow-up, so this editor shows none and saving replaces the
        whole filter with the rows below.
      </p>
      {stale && (
        <div
          role="alert"
          className="flex flex-col gap-1.5 rounded-md bg-error-container px-2 py-1.5 text-xs text-error-ink"
        >
          <span>
            The definition changed while you were editing this filter. It now
            reads: {describeFilter(view.filter)}.
          </span>
          <span className="flex gap-1.5">
            <Button
              size="xs"
              variant="outline"
              onClick={() =>
                setEditing({ ...drafting, definitionId: definitionId })
              }
            >
              Keep my conditions
            </Button>
            <Button
              size="xs"
              variant="ghost"
              onClick={() => setEditing(undefined)}
            >
              Use the current filter
            </Button>
          </span>
        </div>
      )}
      {declared.groups > 0 && (
        <p
          role="alert"
          className="rounded-md bg-error-container px-2 py-1.5 text-xs text-error-ink"
        >
          This view's filter holds {declared.groups} group
          {declared.groups === 1 ? '' : 's'} this editor cannot show. Saving
          replaces them with the rows below.
        </p>
      )}
      {held.map((row, at) => {
        const ops = opsForField(fieldFor(row.fieldKey))
        return (
          <div key={at} className="flex items-center gap-1.5">
            <Choice
              label="Filter field"
              value={row.fieldKey}
              options={
                fieldFor(row.fieldKey)
                  ? fieldOptions
                  : [
                      { value: row.fieldKey, label: row.fieldKey },
                      ...fieldOptions,
                    ]
              }
              onChange={(next) =>
                setRows((rows) =>
                  rows.map((one, i) =>
                    i === at
                      ? edited(one, {
                          fieldKey: next,
                          op: opsForField(fieldFor(next))[0] ?? 'eq',
                          value: '',
                        })
                      : one,
                  ),
                )
              }
            />
            <Choice
              label="Filter operator"
              value={row.op}
              options={ops.map((one) => ({ value: one, label: one }))}
              onChange={(next) =>
                setRows((rows) =>
                  rows.map((one, i) =>
                    i === at
                      ? edited(one, { op: next as FilterRow['op'] })
                      : one,
                  ),
                )
              }
            />
            {!valueless(row.op) && (
              <input
                aria-label="Filter value"
                className={fieldControl}
                value={row.value}
                onChange={(event) =>
                  setRows((rows) =>
                    rows.map((one, i) =>
                      i === at
                        ? edited(one, { value: event.target.value })
                        : one,
                    ),
                  )
                }
              />
            )}
            <Button
              type="button"
              size="xs"
              variant="ghost"
              aria-label={`Remove condition ${at + 1}`}
              onClick={() => setRows((rows) => rows.filter((_, i) => i !== at))}
            >
              ×
            </Button>
          </div>
        )
      })}
      <Button
        type="button"
        size="xs"
        variant="outline"
        className="self-start"
        disabled={fields.size === 0}
        onClick={() =>
          setRows((rows) => {
            const fieldKey =
              rows.at(-1)?.fieldKey ?? fieldOptions[0]?.value ?? ''
            return [
              ...rows,
              {
                fieldKey,
                op: opsForField(fieldFor(fieldKey))[0] ?? 'eq',
                value: '',
              },
            ]
          })
        }
      >
        Add condition
      </Button>
      <p className="text-xs text-ink-faint">
        This view will read: {describeFilter(producing)}.
      </p>
      <Button
        size="sm"
        type="submit"
        disabled={busy || stale || held.some((row) => !row.fieldKey)}
        aria-busy={busy}
      >
        Save filter
      </Button>
    </form>
  )
}
