// SOURCING: the records' field controls (components/records/fields) draw and edit a value, so a
// capability row reads as the CRM's do; coss ui Empty and Checkbox, the app's Button, Skeleton and
// Table; the page module boundary (lib/modules/registry) and its composer reference path. Data is
// only ever lib/capabilities/api: one view's rows, one declared action per click, no model call.
import { useEffect, useMemo, useState } from 'react'
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
import {
  isReloadConflict,
  readReceipt,
  refusalMessage,
} from '@/lib/capabilities/api'
import {
  canInvoke,
  columnsFor,
  capabilityRecordItem,
  describeFilter,
  fieldSpecOf,
  parseCapabilityRecordItem,
  quickAction,
  registerRowOf,
  referencedCollections,
  rowTitle,
  schemaFor,
  siblingViews,
  updateActions,
  viewFor,
} from '@/lib/capabilities/model'
import { codes, INVOKE_TARGETS_MAX } from '@/lib/capabilities/contract'
import type {
  ActionSpec,
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
import { ActionForm } from './action-form'
import type { PickerOptions } from './action-form'
import { AuthoringDialog } from './authoring'
import { NewFromTemplate } from './templates'
import { RulesDialog, offersRules } from './rules'
import { DescribeState, Loading, PermissionState, StatusLine } from './states'
import type { Status } from './states'
import {
  flattenRows,
  useCapabilityDescribe,
  useCapabilityDiscover,
  useCapabilityInvoke,
  useCapabilityInvokeTargets,
  useCapabilityPickers,
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
  // The mark goes when the rows come back at that revision: the new state is
  // then the row's own, not a note beside it.
  if (moved === undefined || moved === revision) return null
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
  busy: string | undefined
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
  onCall,
}: RowProps) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-8">
            <span className="sr-only">Select</span>
          </TableHead>
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
                    disabled={
                      !canInvoke(grant, action.key) || busy !== undefined
                    }
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
              disabled={!canInvoke(grant, action.key) || busy !== undefined}
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
 * One action's form, with a picker over each collection its inputs reference.
 * A picker is one page of that collection, labelled the way a row is labelled
 * everywhere else.
 */
function ActionCall({
  instanceId,
  action,
  row,
  schemas,
  submitLabel,
  busy,
  onSubmit,
  onCancel,
}: {
  instanceId: string
  action: ActionSpec
  row?: CapabilityRecordRow
  schemas: CollectionSchema[]
  submitLabel: string
  busy: boolean
  onSubmit: (values: Record<string, unknown>) => void
  onCancel?: () => void
}) {
  const keys = useMemo(() => referencedCollections(action), [action])
  const pickers = useCapabilityPickers(instanceId, keys)
  const options: PickerOptions = (collectionKey) =>
    (pickers.data?.[collectionKey] ?? []).map((target) => ({
      id: target.id,
      label: rowTitle(schemaFor(schemas, collectionKey)?.fields ?? [], target),
    }))
  return (
    <ActionForm
      action={action}
      defaults={row?.fields}
      options={options}
      submitLabel={submitLabel}
      busy={busy}
      onSubmit={onSubmit}
      onCancel={onCancel}
    />
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
  const [pickedKey, setPickedKey] = useState<string>()
  // A picked view is written into the page, so it opens there next time. Where
  // the setting cannot be written (no page, a composite, a bound View input)
  // the pick holds for as long as the module is shown.
  const own = useOwnSettings(view)
  const pick = (next: ViewSpec) =>
    own && !('viewKey' in view.inputs)
      ? own({ viewKey: next.key })
      : setPickedKey(next.key)
  const spec =
    (pickedKey
      ? definition.views.find((one) => one.key === pickedKey)
      : undefined) ?? start
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
  const [adding, setAdding] = useState(false)
  const [calling, setCalling] = useState<{
    action: ActionSpec
    row: CapabilityRecordRow
  }>()
  const [bulking, setBulking] = useState<ActionSpec>()
  const [authoring, setAuthoring] = useState(false)
  const [ruling, setRuling] = useState(false)
  const [busy, setBusy] = useState<string>()

  // A selection only holds rows still on screen: a refreshed page that dropped
  // one drops it from the envelope and the outputs too.
  const selected = useMemo(
    () => rows.filter((row) => selection[row.id]),
    [rows, selection],
  )
  // A custom module's fallback names the actions it offers; a placed table offers them all.
  const only = view.settings.actions
  const offered = (action: ActionSpec) =>
    !Array.isArray(only) || only.includes(action.key)
  const declaredQuick = quickAction(definition, spec.collectionKey)
  const quick =
    declaredQuick && offered(declaredQuick) ? declaredQuick : undefined
  const actions = updateActions(definition, spec.collectionKey).filter(offered)
  const bulkActions = actions.filter((action) => canInvoke(grant, action.key))

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
    setSelection((held) => ({ ...held, [named.recordId]: true }))
    setLastMarked(named.recordId)
  })
  useModuleAction('deselect', () => {
    setSelection({})
    setLastMarked(undefined)
  })

  /**
   * What a receipt means, as the one line the person reads. `count` is how
   * many records one call ran over, when it ran over a selection.
   */
  const report = (receipt: InvocationReceipt, count?: number): boolean => {
    if (receipt.status === 'dispatched') {
      setStatus({
        kind: 'pending',
        message: `${receipt.actionKey} is journaled and has not finished, so whether it took effect is not yet known.`,
        receipt: { instanceId: receipt.instanceId, recordId: receipt.recordId },
      })
      return false
    }
    const { outcome } = receipt
    if (outcome.outcome === 'completed') {
      setMoved((held) => {
        const next = { ...held }
        for (const affected of outcome.affected)
          next[affected.id] = affected.revision
        return next
      })
      const at = outcome.affected
        .map((affected) => `r${affected.revision}`)
        .join(', ')
      const over = count === undefined ? '' : ` on ${count} records`
      setStatus({
        kind: 'saved',
        message: `${receipt.actionKey} saved${over}${at ? ` · ${at}` : ''}.`,
      })
      return true
    }
    // A call over several records fails whole: its message names the first
    // record that refused, and no record was written.
    setStatus({
      kind: 'failed',
      message: `${count === undefined ? '' : 'No record was changed. '}${outcome.code}: ${outcome.message}`,
      reload: outcome.code === codes.REVISION_CONFLICT,
    })
    return false
  }

  const run = async (
    call: { action: ActionSpec; row?: CapabilityRecordRow },
    values: Record<string, unknown>,
  ) => {
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
      if (report(receipt)) {
        setCalling(undefined)
        setAdding(false)
      }
    } catch (error) {
      setStatus({
        kind: 'failed',
        message: refusalMessage(error, call.action.label),
        reload: isReloadConflict(error),
      })
    } finally {
      setBusy(undefined)
    }
  }

  /** One update action over every selected record, at the revisions on screen. */
  const runSelected = async (
    action: ActionSpec,
    values: Record<string, unknown>,
  ) => {
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
      if (report(receipt, rows.length)) setBulking(undefined)
    } catch (error) {
      setStatus({
        kind: 'failed',
        message: refusalMessage(error, action.label),
        reload: isReloadConflict(error),
      })
    } finally {
      setBusy(undefined)
    }
  }

  const check = async () => {
    const at = status?.receipt
    if (!at) return
    try {
      report(await readReceipt(at.instanceId, at.recordId))
    } catch (error) {
      setStatus({
        kind: 'failed',
        message: refusalMessage(error, 'The receipt'),
        reload: isReloadConflict(error),
      })
    }
  }

  const reload = () => {
    setStatus(undefined)
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
    if (target.action.input.length) return setCalling(target)
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
      {selected.length > 1 && bulkActions.length > 0 && (
        <BulkBar
          count={selected.length}
          actions={bulkActions}
          busy={busy !== undefined}
          onRun={(action) =>
            action.input.length
              ? setBulking(action)
              : void runSelected(action, {})
          }
          onClear={() => {
            setSelection({})
            setLastMarked(undefined)
          }}
        />
      )}
      {spec.layout === 'board' && (
        <p className="px-3 pt-1.5 text-xs text-ink-faint">
          This view is a board; its grouping is not shown here yet, so these are
          its rows in the view's own order.
        </p>
      )}
      {quick && (
        <div className="flex shrink-0 flex-col gap-2 border-b border-separator px-3 py-2">
          {adding ? (
            <ActionCall
              instanceId={instanceId}
              action={quick}
              schemas={described.collectionSchemas}
              submitLabel={quick.label}
              busy={busy !== undefined}
              onSubmit={(values) => void run({ action: quick }, values)}
              onCancel={() => setAdding(false)}
            />
          ) : (
            <Button
              size="xs"
              variant="outline"
              className="self-start"
              disabled={!canInvoke(grant, quick.key)}
              title={
                canInvoke(grant, quick.key)
                  ? undefined
                  : 'Your grant does not reach this action'
              }
              onClick={() => setAdding(true)}
            >
              <Icon.Add className="size-3.5" />
              {quick.label}
            </Button>
          )}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto">
        {rowsQuery.isPending ? (
          <Loading rows={5} />
        ) : rowsQuery.isError && !rowsQuery.data ? (
          <div
            role="alert"
            className="flex flex-col items-start gap-2 p-4 text-sm"
          >
            <span className="text-error-ink">
              {refusalMessage(rowsQuery.error, 'This view')}
            </span>
            <Button size="sm" variant="outline" onClick={reload}>
              Try again
            </Button>
          </div>
        ) : !rows.length ? (
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
        ) : spec.layout === 'table' ? (
          <RowTable {...rowProps} />
        ) : (
          <RowList {...rowProps} />
        )}
        {rowsQuery.hasNextPage && (
          <div className="flex justify-center p-2">
            <Button
              size="xs"
              variant="outline"
              disabled={rowsQuery.isFetchingNextPage}
              onClick={() => void rowsQuery.fetchNextPage()}
            >
              {rowsQuery.isFetchingNextPage
                ? 'Loading…'
                : `Load more (${total} in all)`}
            </Button>
          </div>
        )}
        {truncated && (
          <p className="p-2 text-xs text-ink-faint">
            The page cut the answer short: {rows.length} of {total} rows are
            shown.
          </p>
        )}
      </div>
      {calling && (
        <Dialog open onOpenChange={(shown) => !shown && setCalling(undefined)}>
          <DialogContent showCloseButton={false} className="max-w-sm">
            <DialogHeader>
              <DialogTitle>{calling.action.label}</DialogTitle>
              <DialogDescription>
                {rowTitle(columns, calling.row)} · at revision{' '}
                {calling.row.revision}
              </DialogDescription>
            </DialogHeader>
            <ActionCall
              instanceId={instanceId}
              action={calling.action}
              row={calling.row}
              schemas={described.collectionSchemas}
              submitLabel={calling.action.label}
              busy={busy !== undefined}
              onSubmit={(values) => void run(calling, values)}
              onCancel={() => setCalling(undefined)}
            />
          </DialogContent>
        </Dialog>
      )}
      {bulking && (
        <Dialog open onOpenChange={(shown) => !shown && setBulking(undefined)}>
          <DialogContent showCloseButton={false} className="max-w-sm">
            <DialogHeader>
              <DialogTitle>
                {bulking.label} · {selected.length} records
              </DialogTitle>
              <DialogDescription>
                The same values go to every selected record, each at the
                revision shown; a field left blank is left as it is on every
                record. If any record refuses, none is changed.
              </DialogDescription>
            </DialogHeader>
            <ActionCall
              instanceId={instanceId}
              action={bulking}
              schemas={described.collectionSchemas}
              submitLabel={`${bulking.label} ${selected.length} records`}
              busy={busy !== undefined}
              onSubmit={(values) => void runSelected(bulking, values)}
              onCancel={() => setBulking(undefined)}
            />
          </DialogContent>
        </Dialog>
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
 * `theorem.capability.table`: one view's rows, with the definition's quick-add
 * and action buttons over them.
 */
export function CapabilityTableModule(view: ModuleViewProps) {
  const instanceId = instanceIdOf(view.settings.instanceId)
  const described = useCapabilityDescribe(instanceId || undefined)
  const own = useOwnSettings(view)
  // A new instance opens at its first view; a bound Instance input is not ours to change.
  const openInstance =
    own && !('instanceId' in view.inputs)
      ? (next: string) => own({ instanceId: next, viewKey: '' })
      : undefined
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
