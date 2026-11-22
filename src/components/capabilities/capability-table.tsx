// SOURCING: the records' field controls (components/records/fields) draw and edit a value, so a
// capability row reads as the CRM's do; coss ui Empty and Checkbox, the app's Button, Skeleton and
// Table; the page module boundary (lib/modules/registry) and its composer reference path. Data is
// only ever lib/capabilities/api: one view's rows, one declared action per click, no model call.
import { useEffect, useMemo, useRef, useState } from 'react'
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
import { isReloadConflict, refusalMessage } from '@/lib/capabilities/api'
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
import { codes } from '@/lib/capabilities/contract'
import type {
  ActionSpec,
  CapabilityRecordRow,
  DescribeResult,
  Grant,
  InvocationReceipt,
  ResolvedField,
  ViewSpec,
} from '@/lib/capabilities/contract'
import { capabilityContextReference } from '@/lib/capabilities/reference'
import type { ModuleViewProps } from '@/lib/modules/registry'
import { useModuleAction } from '../pages/page-runtime'
import { usePageId } from '../pages/page-route'
import { ActionCall } from './action-form'
import { AuthoringDialog } from './authoring'
import { DescribeState, Loading, PermissionState, StatusLine } from './states'
import type { Status } from './states'
import {
  EchoedCursorError,
  flattenRows,
  useCapabilityDescribe,
  useCapabilityDiscover,
  useCapabilityInvoke,
  useCapabilityReceipt,
  useCapabilityRows,
} from './queries'

const instanceIdOf = (value: unknown) =>
  typeof value === 'string' ? value.trim() : ''

/** What a row's call did, so the person sees the revision it moved to. */
type Moved = Record<string, number>

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
}: {
  views: ViewSpec[]
  current: ViewSpec
  onPick: (view: ViewSpec) => void
  authoring: boolean
  onAuthor: () => void
  asking: boolean
  onAsk: () => void
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
          Fields
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
 * One view's rows, its quick-add, its selection and its actions. Everything
 * here is read through the instance's own contract: the view's rows, the
 * definition's actions, this caller's grant. No call here reaches a model.
 */
function CapabilityTableBody({
  view,
  described,
  describedAt,
  start,
}: {
  view: ModuleViewProps
  described: DescribeResult
  /** When the describe answer was last read, so an authoring base can be paired with it. */
  describedAt: number
  start: ViewSpec
}) {
  const { output, emit } = view
  const pageId = usePageId()
  const instanceId = instanceIdOf(view.settings.instanceId)
  const definition = described.definition
  const grant = described.callerGrant
  const [pickedKey, setPickedKey] = useState<string>()
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
  const { rows, total, filtered, truncated, definitionId } = flattenRows(
    rowsQuery.data,
  )
  const invoking = useCapabilityInvoke()
  // The authoring dialog edits describe's definition, but describe names no
  // definition id: the rows do. Their id as it stood when describe last
  // answered is the version that definition can be no older than, so a patch
  // names it. Rows that moved on later leave it older, and the server refuses
  // the patch as stale and the dialog reads both again, rather than a newer id
  // carrying conditions read from an older definition.
  const [authoringBase, setAuthoringBase] = useState({
    at: describedAt,
    definitionId,
  })
  if (
    authoringBase.at !== describedAt ||
    (!authoringBase.definitionId && definitionId)
  )
    setAuthoringBase({ at: describedAt, definitionId })

  const [selection, setSelection] = useState<Record<string, true>>({})
  const [lastMarked, setLastMarked] = useState<string>()
  const [status, setStatus] = useState<Status>()
  const [moved, setMoved] = useState<Moved>({})
  // Each open form has its own number, so the answer to a call made from one
  // closes that form and never a newer one opened since.
  const forms = useRef(0)
  const [adding, setAdding] = useState<number>()
  const [calling, setCalling] = useState<{
    action: ActionSpec
    row: CapabilityRecordRow
    form: number
  }>()
  const [authoring, setAuthoring] = useState(false)
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
  const quick = quickAction(definition, spec.collectionKey, grant)
  const actions = updateActions(definition, spec.collectionKey)

  /** The envelope the composer carries: what is on screen, and no record bodies. */
  const context = useMemo(
    () =>
      selected.length
        ? capabilityContextReference({
            instanceId,
            collectionKey: spec.collectionKey,
            pageId,
            viewKey: spec.key,
            purpose: definition.purpose,
            label: `${definition.name} · ${spec.label} · ${selected.length} selected`,
            selected: selected.map((row) => ({
              id: row.id,
              revision: row.revision,
            })),
            filtered,
            truncated,
          })
        : undefined,
    [
      selected,
      instanceId,
      spec,
      definition.name,
      definition.purpose,
      pageId,
      filtered,
      truncated,
    ],
  )

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

  /** What a receipt means, as the one line the person reads. */
  const report = (receipt: InvocationReceipt, form?: number): boolean => {
    if (receipt.status === 'dispatched') {
      setStatus({
        kind: 'pending',
        message: `${receipt.actionKey} is journaled and has not finished, so whether it took effect is not yet known.`,
        receipt: {
          instanceId: receipt.instanceId,
          recordId: receipt.recordId,
          form,
        },
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
      setStatus({
        kind: 'saved',
        message: `${receipt.actionKey} saved${at ? ` · ${at}` : ''}.`,
      })
      return true
    }
    setStatus({
      kind: 'failed',
      message: `${outcome.code}: ${outcome.message}`,
      reload: outcome.code === codes.REVISION_CONFLICT,
    })
    return false
  }

  /** Close the form a finished call came from, if it is still the one open. */
  const closeForm = (form: number | undefined) => {
    if (form === undefined) return
    setAdding((open) => (open === form ? undefined : open))
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
      if (report(receipt, form)) closeForm(form)
    } catch (error) {
      setStatus({
        kind: 'failed',
        message: refusalMessage(error, call.action.label),
        reload: isReloadConflict(error),
      })
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
      if (report(receipt, at.form)) closeForm(at.form)
    } catch (error) {
      if (!current()) return
      setStatus({
        kind: 'failed',
        message: refusalMessage(error, 'The receipt'),
        reload: isReloadConflict(error),
        // Still the same call: its receipt can be read again.
        receipt: at,
      })
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
        onPick={(next) => setPickedKey(next.key)}
        authoring={grant.author}
        onAuthor={() => setAuthoring(true)}
        asking={!!context}
        onAsk={() => context && askAbout(context)}
      />
      <StatusLine
        status={status}
        onClear={() => setStatus(undefined)}
        onReload={reload}
        onCheck={() => void check()}
      />
      {spec.layout === 'board' && (
        <p className="px-3 pt-1.5 text-xs text-ink-faint">
          This view is a board; its grouping is not shown here yet, so these are
          its rows in the view's own order.
        </p>
      )}
      {quick && (
        <div className="flex shrink-0 flex-col gap-2 border-b border-separator px-3 py-2">
          {adding !== undefined ? (
            <ActionCall
              instanceId={instanceId}
              action={quick}
              schemas={described.collectionSchemas}
              submitLabel={quick.label}
              busy={pending}
              onSubmit={(values) => void run({ action: quick }, values, adding)}
              onCancel={() => setAdding(undefined)}
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
              onClick={() => setAdding(++forms.current)}
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
        {rowsQuery.isFetchNextPageError && (
          <p role="alert" className="p-2 text-xs text-error-ink">
            {rowsQuery.error instanceof EchoedCursorError
              ? rowsQuery.error.message
              : refusalMessage(rowsQuery.error, 'The next page')}
          </p>
        )}
        {/* A server that echoed its cursor cannot move on from it; any other
            failed page can be asked for again. */}
        {rowsQuery.hasNextPage &&
          !(
            rowsQuery.isFetchNextPageError &&
            rowsQuery.error instanceof EchoedCursorError
          ) && (
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
              busy={pending}
              onSubmit={(values) => void run(calling, values, calling.form)}
              onCancel={() => setCalling(undefined)}
            />
          </DialogContent>
        </Dialog>
      )}
      {authoring && (
        <AuthoringDialog
          instanceId={instanceId}
          definition={definition}
          schemas={described.collectionSchemas}
          viewKey={spec.key}
          expectedDefinitionId={authoringBase.definitionId}
          onClose={() => setAuthoring(false)}
        />
      )}
    </div>
  )
}

/** A module that names no instance: what this caller may see, so the setting is fillable. */
function NoInstance({ arranging }: { arranging: boolean }) {
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
  if (!instanceId) return <NoInstance arranging={view.arranging} />
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
      describedAt={described.dataUpdatedAt}
      start={start}
    />
  )
}
