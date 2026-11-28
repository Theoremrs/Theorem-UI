// SOURCING: the records' field controls (components/records/fields) draw and edit a value, so a
// capability row reads as the CRM's do; coss ui Empty and Checkbox, the app's Button, Skeleton and
// Table; the page module boundary (lib/modules/registry) and its composer reference path. Data is
// only ever lib/capabilities/api: one view's rows, one declared action per click, no model call.
import { useEffect, useMemo, useRef, useState } from 'react'
import { isEqual } from 'lodash-es'
import { askAbout } from '@/components/chat/composer-references'
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from '@/components/coss/empty'
import { Checkbox } from '@/components/coss/checkbox'
import { Icon } from '@/components/icons'
import { FieldDisplay } from '@/components/records/fields'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { refusalMessage } from '@/lib/capabilities/api'
import {
  canInvoke,
  columnsFor,
  capabilityRecordItem,
  describeFilter,
  fieldSpecOf,
  parseCapabilityRecordItem,
  quickAction,
  registerRowOf,
  rowTitle,
  schemaFor,
  siblingViews,
  updateActions,
  viewFor,
} from '@/lib/capabilities/model'
import { INVOKE_TARGETS_MAX } from '@/lib/capabilities/contract'
import type {
  ActionSpec,
  CapabilityDefinition,
  CapabilityRecordRow,
  CollectionSchema,
  DescribeResult,
  Grant,
  InvocationReceipt,
  ResolvedField,
  ViewSpec,
} from '@/lib/capabilities/contract'
import { capabilityContextReference } from '@/lib/capabilities/reference'
import type { ModuleViewProps } from '@/lib/modules/registry'
import { useModuleAction } from '../pages/page-runtime'
import { useOwnSettings } from '../pages/page-settings'
import { usePagePath } from '../pages/page-route'
import { ActionCall } from './action-form'
import { AuthoringDialog } from './authoring'
import { NewFromTemplate } from './templates'
import { RulesDialog, offersRules } from './rules'
import {
  DescribeState,
  Loading,
  PermissionState,
  StatusLine,
  receiptStatus,
  refusedStatus,
} from './states'
import type { Status } from './states'
import {
  EchoedCursorError,
  flattenRows,
  useCapabilityDescribe,
  useCapabilityDiscover,
  useCapabilityInvoke,
  useCapabilityInvokeTargets,
  useCapabilityReceipt,
  useCapabilityRows,
} from './queries'

const instanceIdOf = (value: unknown) =>
  typeof value === 'string' ? value.trim() : ''

/** What a row's call did, so the person sees the revision it moved to. */
type Moved = Record<string, number>

/** The busy mark while one call runs over the selection rather than one row. */
const BULK = '*selection'

/**
 * The bar a selection of two or more records brings up: each update action the
 * grant reaches, run once over every selected record. The call is all or
 * nothing, so the bar says so before anything is pressed.
 */
function BulkBar({
  count,
  actions,
  busy,
  onRun,
  onClear,
}: {
  count: number
  actions: ActionSpec[]
  busy: boolean
  onRun: (action: ActionSpec) => void
  onClear: () => void
}) {
  const over = count > INVOKE_TARGETS_MAX
  return (
    <div
      role="toolbar"
      aria-label="Selected records"
      className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-separator bg-raised px-3 py-1.5"
    >
      <span className="text-xs text-ink-muted">
        {count} selected · all or nothing
      </span>
      {actions.map((action) => (
        <Button
          key={action.key}
          size="xs"
          variant="outline"
          disabled={busy || over}
          aria-label={`${action.label} the ${count} selected`}
          onClick={() => onRun(action)}
        >
          {action.label}
        </Button>
      ))}
      {over && (
        <span className="text-xs text-ink-faint">
          One call changes at most {INVOKE_TARGETS_MAX} records.
        </span>
      )}
      <Button size="xs" variant="ghost" onClick={onClear}>
        Clear selection
      </Button>
    </div>
  )
}

function RowMark({
  revision,
  moved,
}: {
  revision: number
  moved: number | undefined
}) {
  // The mark goes when the rows come back at that revision or a later one: the
  // new state is then the row's own, not a note beside it.
  if (moved === undefined || revision >= moved) return null
  return (
    <span className="shrink-0 rounded-md bg-raised px-1.5 py-0.5 text-xs text-ink-muted">
      saved · r{moved}
    </span>
  )
}

/** The view switcher: every view over this collection, as the definition names them. */
function ViewBar({
  views,
  current,
  onPick,
  authoring,
  onAuthor,
  asking,
  onAsk,
  rules,
  onRules,
}: {
  views: ViewSpec[]
  current: ViewSpec
  onPick: (view: ViewSpec) => void
  authoring: boolean
  onAuthor: () => void
  asking: boolean
  onAsk: () => void
  rules: boolean
  onRules: () => void
}) {
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-separator px-3 py-1.5">
      <nav
        aria-label="Views"
        className="flex min-w-0 flex-1 items-center gap-1"
      >
        {views.map((view) => (
          <button
            key={view.key}
            type="button"
            aria-current={view.key === current.key ? 'true' : undefined}
            onClick={() => onPick(view)}
            className={
              view.key === current.key
                ? 'rounded-md bg-raised px-2 py-1 text-xs font-medium text-ink outline-none focus-visible:outline-2 focus-visible:outline-focus'
                : 'rounded-md px-2 py-1 text-xs text-ink-muted outline-none hover:bg-hover focus-visible:outline-2 focus-visible:outline-focus'
            }
          >
            {view.label}
          </button>
        ))}
      </nav>
      <span className="min-w-0 truncate text-xs text-ink-faint">
        {describeFilter(current.filter)}
      </span>
      {asking && (
        <Button size="xs" variant="outline" onClick={onAsk}>
          <Icon.Sparkle className="size-3.5" />
          Ask Theorem
        </Button>
      )}
      {authoring && (
        <Button size="xs" variant="ghost" onClick={onAuthor}>
          <Icon.Settings className="size-3.5" />
          Customize
        </Button>
      )}
      {rules && (
        <Button size="xs" variant="ghost" onClick={onRules}>
          <Icon.Route className="size-3.5" />
          Rules
        </Button>
      )}
    </div>
  )
}

/** What the rows of a view need from the module: the rows, their columns, the calls they offer. */
interface RowProps {
  rows: CapabilityRecordRow[]
  columns: ResolvedField[]
  selection: Record<string, true>
  onToggle: (row: CapabilityRecordRow, marked: boolean) => void
  onOpen: (row: CapabilityRecordRow) => void
  actions: ActionSpec[]
  grant: Grant
  moved: Moved
  /** The row a call is running on, for its busy mark. */
  busy: string | undefined
  /** Whether any call is running: one call at a time, so one click is one invocation. */
  pending: boolean
  onCall: (call: { action: ActionSpec; row: CapabilityRecordRow }) => void
}

/** One row's cell, drawn by the records' own field display. */
function Cell({
  row,
  field,
}: {
  row: CapabilityRecordRow
  field: ResolvedField
}) {
  return <FieldDisplay row={registerRowOf(row)} field={fieldSpecOf(field)} />
}

/** The rows a view answers, as a table. Cells are the records' own field display. */
function RowTable({
  rows,
  columns,
  selection,
  onToggle,
  onOpen,
  actions,
  grant,
  moved,
  busy,
  pending,
  onCall,
}: RowProps) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-8">
            <span className="sr-only">Select</span>
          </TableHead>
          {columns.length === 0 && <TableHead>Record</TableHead>}
          {columns.map((field) => (
            <TableHead key={field.key}>{field.label}</TableHead>
          ))}
          <TableHead className="w-px">
            <span className="sr-only">Actions</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow
            key={row.id}
            aria-busy={busy === row.id}
            data-selected={selection[row.id] ? '' : undefined}
            className={selection[row.id] ? 'bg-raised' : undefined}
          >
            <TableCell>
              <Checkbox
                aria-label={`Select ${rowTitle(columns, row)}`}
                checked={!!selection[row.id]}
                onCheckedChange={(checked) => onToggle(row, checked === true)}
              />
            </TableCell>
            {columns.length === 0 && (
              // A view with no columns to show still opens its records, by id
              // as the list draws one with no title column.
              <TableCell>
                <button
                  type="button"
                  onClick={() => onOpen(row)}
                  className="max-w-full rounded-md text-left font-mono text-xs outline-none focus-visible:outline-2 focus-visible:outline-focus"
                >
                  {row.id}
                </button>
              </TableCell>
            )}
            {columns.map((field, at) => (
              <TableCell key={field.key}>
                {at === 0 ? (
                  <button
                    type="button"
                    onClick={() => onOpen(row)}
                    className="max-w-full rounded-md text-left outline-none focus-visible:outline-2 focus-visible:outline-focus"
                  >
                    <Cell row={row} field={field} />
                  </button>
                ) : (
                  <Cell row={row} field={field} />
                )}
              </TableCell>
            ))}
            <TableCell>
              <span className="flex items-center justify-end gap-1">
                <RowMark revision={row.revision} moved={moved[row.id]} />
                {actions.map((action) => (
                  <Button
                    key={action.key}
                    size="xs"
                    variant="outline"
                    disabled={!canInvoke(grant, action.key) || pending}
                    title={
                      canInvoke(grant, action.key)
                        ? `At revision ${row.revision}`
                        : 'Your grant does not reach this action'
                    }
                    onClick={() => onCall({ action, row })}
                  >
                    {action.label}
                  </Button>
                ))}
              </span>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

/**
 * The same rows as a list: one line each, the view's first column as its title
 * and the rest beside it. A view's layout decides which of the two a module
 * draws; the rows, selection and actions are the same.
 */
function RowList({
  rows,
  columns,
  selection,
  onToggle,
  onOpen,
  actions,
  grant,
  moved,
  busy,
  pending,
  onCall,
}: RowProps) {
  const title = columns[0]
  const rest = title
    ? columns.filter((field) => field.key !== title.key)
    : columns
  return (
    <ul aria-label="Records" className="flex flex-col gap-px p-2">
      {rows.map((row) => (
        <li
          key={row.id}
          aria-busy={busy === row.id}
          className={cn(
            'flex min-w-0 items-center gap-2 rounded-md px-1.5 py-1',
            selection[row.id] && 'bg-raised',
          )}
        >
          <Checkbox
            aria-label={`Select ${rowTitle(columns, row)}`}
            checked={!!selection[row.id]}
            onCheckedChange={(checked) => onToggle(row, checked === true)}
          />
          <button
            type="button"
            onClick={() => onOpen(row)}
            className="min-w-0 shrink-0 rounded-md text-left text-sm text-ink outline-none focus-visible:outline-2 focus-visible:outline-focus"
          >
            {title ? <Cell row={row} field={title} /> : row.id}
          </button>
          <span className="flex min-w-0 flex-1 items-center gap-3 overflow-hidden text-xs text-ink-muted">
            {rest.map((field) => (
              <span key={field.key} className="flex min-w-0 items-center gap-1">
                <span className="text-ink-faint">{field.label}</span>
                <Cell row={row} field={field} />
              </span>
            ))}
          </span>
          <RowMark revision={row.revision} moved={moved[row.id]} />
          {actions.map((action) => (
            <Button
              key={action.key}
              size="xs"
              variant="outline"
              disabled={!canInvoke(grant, action.key) || pending}
              title={
                canInvoke(grant, action.key)
                  ? `At revision ${row.revision}`
                  : 'Your grant does not reach this action'
              }
              onClick={() => onCall({ action, row })}
            >
              {action.label}
            </Button>
          ))}
        </li>
      ))}
    </ul>
  )
}

/**
 * The calls a view offers: its quick-add, its row actions, and those of them
 * that run over a selection. A custom module's fallback names the actions it
 * offers; a placed table offers them all. A module-backed action runs on one
 * record at a time: the server refuses it over several targets, which commit
 * as one shared patch.
 */
function offeredActions(
  definition: CapabilityDefinition,
  collectionKey: string,
  only: unknown,
  grant: Grant,
) {
  const offered = (action: ActionSpec) =>
    !Array.isArray(only) || only.includes(action.key)
  const declaredQuick = quickAction(definition, collectionKey, grant)
  const actions = updateActions(definition, collectionKey).filter(offered)
  return {
    quick: declaredQuick && offered(declaredQuick) ? declaredQuick : undefined,
    actions,
    bulkActions: actions.filter(
      (action) => canInvoke(grant, action.key) && !action.implementation,
    ),
  }
}

/** The revisions a completed call moved its records to; nothing for any other receipt. */
const movedBy = (receipt: InvocationReceipt): Moved =>
  receipt.status === 'finished' && receipt.outcome.outcome === 'completed'
    ? Object.fromEntries(
        receipt.outcome.affected.map((one) => [one.id, one.revision]),
      )
    : {}

/**
 * The view this module shows. A picked view is written into the page, so it
 * opens there next time. Where the setting cannot be written (no page, a
 * composite, a bound View input) the pick holds for as long as the module is
 * shown.
 */
function usePickedView(
  view: ModuleViewProps,
  definition: CapabilityDefinition,
  start: ViewSpec,
) {
  const [pickedKey, setPickedKey] = useState<string>()
  const own = useOwnSettings(view)
  const pick = (next: ViewSpec) =>
    own && !('viewKey' in view.inputs)
      ? own({ viewKey: next.key })
      : setPickedKey(next.key)
  const spec =
    (pickedKey
      ? definition.views.find((one) => one.key === pickedKey)
      : undefined) ?? start
  return { spec, pick }
}

/** The view's quick-add: its action's button, or the action's form while adding. */
function QuickAdd({
  instanceId,
  action,
  adding,
  grant,
  schemas,
  busy,
  onAdding,
  onSubmit,
}: {
  instanceId: string
  action: ActionSpec
  adding: boolean
  grant: Grant
  schemas: CollectionSchema[]
  busy: boolean
  onAdding: (adding: boolean) => void
  onSubmit: (values: Record<string, unknown>) => void
}) {
  return (
    <div className="flex shrink-0 flex-col gap-2 border-b border-separator px-3 py-2">
      {adding ? (
        <ActionCall
          instanceId={instanceId}
          action={action}
          schemas={schemas}
          submitLabel={action.label}
          busy={busy}
          onSubmit={onSubmit}
          onCancel={() => onAdding(false)}
        />
      ) : (
        <Button
          size="xs"
          variant="outline"
          className="self-start"
          disabled={busy || !canInvoke(grant, action.key)}
          title={
            canInvoke(grant, action.key)
              ? undefined
              : 'Your grant does not reach this action'
          }
          onClick={() => onAdding(true)}
        >
          <Icon.Add className="size-3.5" />
          {action.label}
        </Button>
      )}
    </div>
  )
}

/** Why a view has no rows: its filter matched none, or the collection holds none it shows. */
function EmptyView({
  filtered,
  spec,
  schema,
}: {
  filtered: boolean
  spec: ViewSpec
  schema: CollectionSchema | undefined
}) {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyTitle>
          {filtered ? 'Nothing matches' : 'Nothing here yet'}
        </EmptyTitle>
        <EmptyDescription>
          {filtered
            ? `No record fits this view: ${describeFilter(spec.filter)}.`
            : `${schema?.label ?? 'This collection'} has no records the view shows.`}
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  )
}

type RowsQuery = ReturnType<typeof useCapabilityRows>

/**
 * The rows a view answers, or what stands in their place: placeholders while
 * the read runs, the refusal with a way to read again, or why there are none.
 * A view's layout decides whether the rows are a table or a list.
 */
function ViewRows({
  query,
  filtered,
  spec,
  schema,
  rowProps,
  onReload,
}: {
  query: RowsQuery
  filtered: boolean
  spec: ViewSpec
  schema: CollectionSchema | undefined
  rowProps: RowProps
  onReload: () => void
}) {
  if (query.isPending) return <Loading rows={5} />
  if (query.isError && !query.data)
    return (
      <div role="alert" className="flex flex-col items-start gap-2 p-4 text-sm">
        <span className="text-error-ink">
          {refusalMessage(query.error, 'This view')}
        </span>
        <Button size="sm" variant="outline" onClick={onReload}>
          Try again
        </Button>
      </div>
    )
  if (!rowProps.rows.length)
    return <EmptyView filtered={filtered} spec={spec} schema={schema} />
  return spec.layout === 'table' ? (
    <RowTable {...rowProps} />
  ) : (
    <RowList {...rowProps} />
  )
}

/** The way to a view's next page, and a note when the page cut the answer short. */
function MoreRows({
  query,
  shown,
  total,
  truncated,
}: {
  query: RowsQuery
  shown: number
  total: number
  truncated: boolean
}) {
  const next = query.data?.pages.at(-1)?.nextCursor
  const repeated = next !== undefined && query.data?.pageParams.includes(next)
  return (
    <>
      {repeated && (
        <p role="alert" className="p-2 text-xs text-error-ink">
          The view returned a page cursor it already used. The next page cannot
          be read.
        </p>
      )}
      {query.isFetchNextPageError && (
        <p role="alert" className="p-2 text-xs text-error-ink">
          {query.error instanceof EchoedCursorError
            ? query.error.message
            : refusalMessage(query.error, 'The next page')}
        </p>
      )}
      {query.hasNextPage &&
        !(
          query.isFetchNextPageError && query.error instanceof EchoedCursorError
        ) && (
          <div className="flex justify-center p-2">
            <Button
              size="xs"
              variant="outline"
              disabled={query.isFetchingNextPage}
              onClick={() => void query.fetchNextPage()}
            >
              {query.isFetchingNextPage
                ? 'Loading…'
                : `Load more (${total} in all)`}
            </Button>
          </div>
        )}
      {truncated && (
        <p className="p-2 text-xs text-ink-faint">
          The page cut the answer short: {shown} of {total} rows are shown.
        </p>
      )}
    </>
  )
}

/** A row action's form, in a dialog that names the record and the revision it was read at. */
function CallDialog({
  instanceId,
  call,
  columns,
  schemas,
  busy,
  onSubmit,
  onClose,
}: {
  instanceId: string
  call: { action: ActionSpec; row: CapabilityRecordRow }
  columns: ResolvedField[]
  schemas: CollectionSchema[]
  busy: boolean
  onSubmit: (values: Record<string, unknown>) => void
  onClose: () => void
}) {
  return (
    <Dialog open onOpenChange={(shown) => !shown && onClose()}>
      <DialogContent showCloseButton={false} className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{call.action.label}</DialogTitle>
          <DialogDescription>
            {rowTitle(columns, call.row)} · at revision {call.row.revision}
          </DialogDescription>
        </DialogHeader>
        <ActionCall
          instanceId={instanceId}
          action={call.action}
          row={call.row}
          schemas={schemas}
          submitLabel={call.action.label}
          busy={busy}
          onSubmit={onSubmit}
          onCancel={onClose}
        />
      </DialogContent>
    </Dialog>
  )
}

/** A bar action's form over the selection: the same values go to every selected record. */
function BulkDialog({
  instanceId,
  action,
  count,
  schemas,
  busy,
  onSubmit,
  onClose,
}: {
  instanceId: string
  action: ActionSpec
  count: number
  schemas: CollectionSchema[]
  busy: boolean
  onSubmit: (values: Record<string, unknown>) => void
  onClose: () => void
}) {
  return (
    <Dialog open onOpenChange={(shown) => !shown && onClose()}>
      <DialogContent showCloseButton={false} className="max-w-sm">
        <DialogHeader>
          <DialogTitle>
            {action.label} · {count} records
          </DialogTitle>
          <DialogDescription>
            The same values go to every selected record, each at the revision
            shown; a field left blank is left as it is on every record. If any
            record refuses, none is changed.
          </DialogDescription>
        </DialogHeader>
        <ActionCall
          instanceId={instanceId}
          action={action}
          schemas={schemas}
          submitLabel={`${action.label} ${count} records`}
          busy={busy}
          onSubmit={onSubmit}
          onCancel={onClose}
        />
      </DialogContent>
    </Dialog>
  )
}

/**
 * What a selection brings up: the bar over two or more records, and the form
 * of a bar action that asks for inputs. The form stays open while the
 * selection under it changes, and closes when its call is saved or cancelled.
 */
function SelectionCalls({
  instanceId,
  selected,
  actions,
  schemas,
  busy,
  onRun,
  onClear,
}: {
  instanceId: string
  selected: CapabilityRecordRow[]
  actions: ActionSpec[]
  schemas: CollectionSchema[]
  busy: boolean
  onRun: (
    action: ActionSpec,
    values: Record<string, unknown>,
    done: () => void,
  ) => void
  onClear: () => void
}) {
  const [bulking, setBulking] = useState<ActionSpec>()
  const close = () => setBulking(undefined)
  return (
    <>
      {selected.length > 1 && actions.length > 0 && (
        <BulkBar
          count={selected.length}
          actions={actions}
          busy={busy}
          onRun={(action) =>
            action.input.length ? setBulking(action) : onRun(action, {}, close)
          }
          onClear={onClear}
        />
      )}
      {bulking && (
        <BulkDialog
          instanceId={instanceId}
          action={bulking}
          count={selected.length}
          schemas={schemas}
          busy={busy}
          onSubmit={(values) => onRun(bulking, values, close)}
          onClose={close}
        />
      )}
    </>
  )
}

/**
 * One view's rows, its quick-add, its selection and its actions. Everything
 * here is read through the instance's own contract: the view's rows, the
 * definition's actions, this caller's grant. No call here reaches a model.
 */
function CapabilityTableBody({
  view,
  described,
  start,
  onOpenInstance,
}: {
  view: ModuleViewProps
  described: DescribeResult
  start: ViewSpec
  /** Switch this module to another instance; absent where its setting cannot be written. */
  onOpenInstance?: (instanceId: string) => void
}) {
  const { output, emit } = view
  const pageId = usePagePath()
  // The page component that shows this: a composite's own id, when inside one.
  const selectedComponentId = view.path.split('/')[0]
  const instanceId = instanceIdOf(view.settings.instanceId)
  const definition = described.definition
  const grant = described.callerGrant
  const { spec, pick } = usePickedView(view, definition, start)
  const views = useMemo(
    () => siblingViews(definition, spec),
    [definition, spec],
  )
  const schema = schemaFor(described.collectionSchemas, spec.collectionKey)
  const columns = useMemo(() => columnsFor(spec, schema), [spec, schema])
  const rowsQuery = useCapabilityRows(instanceId, spec.key)
  const { rows, total, filtered, truncated } = flattenRows(rowsQuery.data)
  const invoking = useCapabilityInvoke()
  const invokingTargets = useCapabilityInvokeTargets()

  const [selection, setSelection] = useState<Record<string, true>>({})
  const [lastMarked, setLastMarked] = useState<string>()
  const [status, setStatus] = useState<Status>()
  const [moved, setMoved] = useState<Moved>({})
  // Each open form has its own number, so the answer to a call made from one
  // closes that form and never a newer one opened since.
  const forms = useRef(0)
  const [adding, setAdding] = useState<{ action: ActionSpec; form: number }>()
  const [calling, setCalling] = useState<{
    action: ActionSpec
    row: CapabilityRecordRow
    form: number
  }>()
  const [authoring, setAuthoring] = useState(false)
  const [ruling, setRuling] = useState(false)
  const [busy, setBusy] = useState<string>()
  // Whether a call is running, held apart from the row it runs on: a create
  // has no row, and its form must not send a second invocation meanwhile. The
  // ref answers a second click before React has drawn the first one's state.
  const [pending, setPending] = useState(false)
  const running = useRef(false)
  const receipts = useCapabilityReceipt()
  // The status on screen when a receipt read answers, which may have moved on.
  const shownStatus = useRef(status)
  useEffect(() => {
    shownStatus.current = status
  }, [status])

  // A selection only holds rows still on screen: a refreshed page that dropped
  // one drops it from the envelope and the outputs too.
  const selected = useMemo(
    () => rows.filter((row) => selection[row.id]),
    [rows, selection],
  )
  const { quick, actions, bulkActions } = offeredActions(
    definition,
    spec.collectionKey,
    view.settings.actions,
    grant,
  )
  const offered = view.settings.actions
  const currentCreate =
    adding &&
    definition.actions.find((action) => action.key === adding.action.key)
  const activeAdd =
    adding &&
    currentCreate?.collectionKey === spec.collectionKey &&
    canInvoke(grant, adding.action.key) &&
    (!Array.isArray(offered) || offered.includes(adding.action.key)) &&
    isEqual(adding.action, currentCreate)
      ? adding
      : undefined
  if (adding && !activeAdd) setAdding(undefined)
  const createAction = activeAdd?.action ?? quick

  /**
   * The envelope the composer carries: what is on screen, and no record bodies.
   * With nothing selected it names the view alone, which is what "use in this
   * conversation" hands on; a selection is what the module outputs and emits.
   */
  const shown = useMemo(
    () =>
      capabilityContextReference({
        instanceId,
        collectionKey: spec.collectionKey,
        pageId,
        selectedComponentId,
        viewKey: spec.key,
        purpose: definition.purpose,
        label: selected.length
          ? `${definition.name} · ${spec.label} · ${selected.length} selected`
          : `${definition.name} · ${spec.label}`,
        selected: selected.map((row) => ({
          id: row.id,
          revision: row.revision,
        })),
        filtered,
        truncated,
      }),
    [
      selected,
      instanceId,
      spec,
      definition.name,
      definition.purpose,
      pageId,
      selectedComponentId,
      filtered,
      truncated,
    ],
  )
  const context = selected.length ? shown : undefined

  useEffect(() => output('context', context), [output, context])
  useEffect(() => {
    if (context) emit('context', context)
  }, [emit, context])
  useEffect(() => {
    const open = lastMarked
      ? selected.find((row) => row.id === lastMarked)
      : undefined
    output(
      'selected',
      open
        ? capabilityRecordItem(
            instanceId,
            spec.collectionKey,
            open.id,
            rowTitle(columns, open),
          )
        : undefined,
    )
    output(
      'selection',
      selected.length
        ? selected.map((row) => ({ id: row.id, revision: row.revision }))
        : undefined,
    )
  }, [output, selected, lastMarked, instanceId, spec.collectionKey, columns])

  const toggle = (row: CapabilityRecordRow, marked: boolean) => {
    setSelection((held) => {
      const next = { ...held }
      if (marked) next[row.id] = true
      else delete next[row.id]
      return next
    })
    setLastMarked(marked ? row.id : undefined)
  }

  useModuleAction('select', (payload) => {
    const named = parseCapabilityRecordItem(payload)
    if (!named) return
    // An item scoped to another instance or collection is not one of these
    // rows, whatever its id; a bare id is read as one of them.
    const scoped = named.instanceId !== '' || named.collectionKey !== ''
    if (
      scoped &&
      (named.instanceId !== instanceId ||
        named.collectionKey !== spec.collectionKey)
    )
      return
    setSelection((held) => ({ ...held, [named.recordId]: true }))
    setLastMarked(named.recordId)
  })
  useModuleAction('deselect', () => {
    setSelection({})
    setLastMarked(undefined)
  })

  /** Report the receipt and leave the owning form attached while it is pending. */
  const report = (
    receipt: InvocationReceipt,
    { form, count }: { form?: number; count?: number } = {},
  ): boolean => {
    const next = receiptStatus(receipt, count)
    if (next.receipt) next.receipt = { ...next.receipt, form, count }
    setMoved((held) => ({ ...held, ...movedBy(receipt) }))
    setStatus(next)
    return next.kind === 'saved'
  }

  /** Close the form a finished call came from, if it is still the one open. */
  const closeForm = (form: number | undefined) => {
    if (form === undefined) return
    setAdding((open) => (open?.form === form ? undefined : open))
    setCalling((open) => (open?.form === form ? undefined : open))
  }

  const run = async (
    call: { action: ActionSpec; row?: CapabilityRecordRow },
    values: Record<string, unknown>,
    form?: number,
  ) => {
    if (running.current) return
    running.current = true
    setPending(true)
    setBusy(call.row?.id)
    setStatus({ kind: 'pending', message: `${call.action.label}…` })
    try {
      const receipt = await invoking.mutateAsync({
        instanceId,
        actionKey: call.action.key,
        inputs: values,
        ...(call.row
          ? { recordId: call.row.id, expectedRevision: call.row.revision }
          : {}),
      })
      if (report(receipt, { form })) closeForm(form)
    } catch (error) {
      setStatus(refusedStatus(error, call.action.label))
    } finally {
      running.current = false
      setPending(false)
      setBusy(undefined)
    }
  }

  /** One update action over every selected record, at the revisions on screen. */
  const runSelected = async (
    action: ActionSpec,
    values: Record<string, unknown>,
    done: () => void,
  ) => {
    if (running.current) return
    running.current = true
    setPending(true)
    const rows = selected
    setBusy(BULK)
    setStatus({
      kind: 'pending',
      message: `${action.label} on ${rows.length} records…`,
    })
    try {
      const receipt = await invokingTargets.mutateAsync({
        instanceId,
        actionKey: action.key,
        inputs: values,
        rows,
      })
      if (report(receipt, { count: rows.length })) done()
    } catch (error) {
      setStatus(refusedStatus(error, action.label))
    } finally {
      running.current = false
      setPending(false)
      setBusy(undefined)
    }
  }

  /**
   * Read a journaled call's receipt back. A finished one takes the same path as
   * a call that finished at once: the rows are read again and its form closes.
   * An answer that comes after the status moved on to another call is dropped.
   */
  const check = async () => {
    const at = status?.receipt
    if (!at) return
    const current = () => {
      const shown = shownStatus.current?.receipt
      return (
        shown?.instanceId === at.instanceId && shown.recordId === at.recordId
      )
    }
    try {
      const receipt = await receipts.mutateAsync(at)
      if (!current()) return
      if (report(receipt, at)) closeForm(at.form)
    } catch (error) {
      if (!current()) return
      setStatus(refusedStatus(error, 'The receipt'))
    }
  }

  /**
   * Read the rows again. An open action form was filled against the row as it
   * was, so it closes: the person reopens it over the row as it now is.
   */
  const reload = () => {
    setStatus(undefined)
    setCalling(undefined)
    void rowsQuery.refetch()
  }

  const open = (row: CapabilityRecordRow) => {
    const item = capabilityRecordItem(
      instanceId,
      spec.collectionKey,
      row.id,
      rowTitle(columns, row),
    )
    output('selected', item)
    emit('opened', item)
  }

  /**
   * What a row's action button does: an action that asks for nothing runs at
   * once, on the record and revision the row shows; one that asks for inputs
   * opens its form first.
   */
  const call = (target: { action: ActionSpec; row: CapabilityRecordRow }) => {
    if (target.action.input.length)
      return setCalling({ ...target, form: ++forms.current })
    void run(target, {})
  }

  const rowProps: RowProps = {
    rows,
    columns,
    selection,
    onToggle: toggle,
    onOpen: open,
    actions,
    grant,
    moved,
    busy,
    pending,
    onCall: call,
  }

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-background">
      <ViewBar
        views={views}
        current={spec}
        onPick={pick}
        authoring={grant.author}
        onAuthor={() => setAuthoring(true)}
        asking={!!context}
        onAsk={() => context && askAbout(context)}
        rules={offersRules(described)}
        onRules={() => setRuling(true)}
      />
      <StatusLine
        status={status}
        onClear={() => setStatus(undefined)}
        onReload={reload}
        onCheck={() => void check()}
      />
      <SelectionCalls
        instanceId={instanceId}
        selected={selected}
        actions={bulkActions}
        schemas={described.collectionSchemas}
        busy={pending}
        onRun={(action, values, done) => void runSelected(action, values, done)}
        onClear={() => {
          setSelection({})
          setLastMarked(undefined)
        }}
      />
      {spec.layout === 'board' && (
        <p className="px-3 pt-1.5 text-xs text-ink-faint">
          This view is a board; its grouping is not shown here yet, so these are
          its rows in the view's own order.
        </p>
      )}
      {createAction && (
        <QuickAdd
          instanceId={instanceId}
          action={createAction}
          adding={activeAdd !== undefined}
          grant={grant}
          schemas={described.collectionSchemas}
          busy={pending}
          onAdding={(opened) =>
            setAdding(
              opened
                ? { action: createAction, form: ++forms.current }
                : undefined,
            )
          }
          onSubmit={(values) => {
            if (activeAdd) void run(activeAdd, values, activeAdd.form)
          }}
        />
      )}
      <div className="min-h-0 flex-1 overflow-auto">
        <ViewRows
          query={rowsQuery}
          filtered={filtered}
          spec={spec}
          schema={schema}
          rowProps={rowProps}
          onReload={reload}
        />
        <MoreRows
          query={rowsQuery}
          shown={rows.length}
          total={total}
          truncated={truncated}
        />
      </div>
      {calling && (
        <CallDialog
          instanceId={instanceId}
          call={calling}
          columns={columns}
          schemas={described.collectionSchemas}
          busy={pending}
          onSubmit={(values) => void run(calling, values, calling.form)}
          onClose={() => setCalling(undefined)}
        />
      )}
      {authoring && (
        <AuthoringDialog
          instanceId={instanceId}
          described={described}
          viewKey={spec.key}
          onClose={() => setAuthoring(false)}
          onAsk={() => {
            setAuthoring(false)
            askAbout(shown)
          }}
          onOpenInstance={onOpenInstance}
        />
      )}
      {ruling && (
        <RulesDialog
          instanceId={instanceId}
          described={described}
          expectedDefinitionId={described.definitionId}
          onClose={() => setRuling(false)}
        />
      )}
    </div>
  )
}

/**
 * A module that names no instance: what this caller may see, so the setting is
 * fillable, and a new instance from one of the caller's templates.
 */
function NoInstance({
  arranging,
  onOpenInstance,
}: {
  arranging: boolean
  onOpenInstance?: (instanceId: string) => void
}) {
  const found = useCapabilityDiscover()
  return (
    <div className="flex flex-col gap-2 p-3 text-sm">
      <p className="text-ink">
        Name the capability instance in this module's settings
        {arranging ? ', in its Instance field.' : '.'}
      </p>
      {found.isPending && (
        <p className="text-ink-muted">Looking for capabilities…</p>
      )}
      {found.data && found.data.instances.length === 0 && (
        <p className="text-ink-muted">
          No capability instance is granted to you yet. One is bound through the
          agent's capability_author path, or a page that creates it.
        </p>
      )}
      {(found.data?.instances ?? []).map((entry) => (
        <p key={entry.instanceId} className="text-ink-muted">
          <code className="font-mono text-xs">{entry.instanceId}</code> —{' '}
          {entry.name}
        </p>
      ))}
      <NewFromTemplate onOpen={onOpenInstance} />
    </div>
  )
}

/**
 * How this module switches to another instance, by writing its own Instance
 * setting, or undefined where it cannot. A new instance opens at its first
 * view; a bound Instance input is not ours to change.
 */
function useOpenInstance(view: ModuleViewProps) {
  const own = useOwnSettings(view)
  return own && !('instanceId' in view.inputs)
    ? (next: string) => own({ instanceId: next, viewKey: '' })
    : undefined
}

/**
 * `theorem.capability.table`: one view's rows, with the definition's quick-add
 * and action buttons over them.
 */
export function CapabilityTableModule(view: ModuleViewProps) {
  const instanceId = instanceIdOf(view.settings.instanceId)
  const described = useCapabilityDescribe(instanceId || undefined)
  const openInstance = useOpenInstance(view)
  if (!instanceId)
    return (
      <NoInstance arranging={view.arranging} onOpenInstance={openInstance} />
    )
  if (described.isPending) return <Loading />
  // Beyond pending, a result either refused or answered: the caller's grant, the
  // definition and the resolved schemas come together or not at all.
  if (described.isError)
    return (
      <DescribeState
        error={described.error}
        onRetry={() => void described.refetch()}
      />
    )
  const { definition, callerGrant } = described.data
  if (!callerGrant.read) return <PermissionState name={definition.name} />
  const start = viewFor(
    definition,
    instanceIdOf(view.settings.viewKey) || undefined,
  )
  if (!start)
    return (
      <div className="p-3 text-sm text-ink-muted">
        {definition.name} declares no view yet, so there is nothing to show.
      </div>
    )
  // A new instance or a new view setting starts the body over: its selection,
  // its switched view and its notices belong to the rows it was reading.
  return (
    <CapabilityTableBody
      key={`${instanceId}:${start.key}`}
      view={view}
      described={described.data}
      start={start}
      onOpenInstance={openInstance}
    />
  )
}
