// SOURCING: Twenty's record table for the anatomy and the measurements Theorem's spec fixes (a 44 px page header, a 40 px view bar, a sticky 32 px header row with field-type icons, 36 px rows, a 32 px checkbox column, a 220 px pinned identifier column, an "Add new" row, a count footer, a 420 px record preview); the ported Twenty primitives (./twenty); coss ui Menu; the schema register's inline editors (components/records/fields); the WAI-ARIA grid pattern for the roles and the roving cell focus. TanStack Table v9 through the app's kit hook (components/data-table/table-hook, vendored from TanStack's kitchen-sink-shadcn-base example, with its ResizeHandle) owns the columns, their order, widths and pinning, sorting by several rules, the global filter that searches every shown field, hidden columns and the marked rows; @dnd-kit (./header-drag, after the example's sortable) drags a column header to a new place and the drop is the table's setColumnOrder;  the rows it returns are drawn here to Twenty's measurements. Behaviour restored from the generic record table it replaced (git a416d0b, components/records/record-table): the column menu and the "+" column (./column-menu), the Calculate row (./calculate-footer), CSV export by d3-dsv (./export-csv), shift-click range marking, column resizing, Tab and Backspace in the grid, and each view's arrangement kept in localStorage (components/records/view-state)
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Download,
  Plus,
  RotateCcw,
  Search,
  Settings2,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import {
  createAppColumnHelper,
  useAppTable,
} from '@/components/data-table/table-hook'
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from '@/components/coss/menu'
import type { AggregateOp } from '@/components/records/aggregate'
import type { FieldSpec, ObjectType } from '@/components/records/contract'
import {
  FieldEditor,
  FieldTypeIcon,
  KIND,
  sortValue,
} from '@/components/records/fields'
import type { Move } from '@/components/records/fields'
import {
  displayHint,
  identifierField,
  isEmptyValue,
  recordTitle,
} from '@/components/records/model'
import { useDeclareObjectType } from '@/components/records/queries'
import { toInput } from '@/components/records/schema-edit'
import { useRecordViewState } from '@/components/records/view-state'
import type { RecordViewState } from '@/components/records/view-state'
import { useMaybeIndexPlace } from '@/components/index/navigation'
import {
  Popover,
  PopoverPopup,
  PopoverTrigger,
} from '@/components/coss/popover'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { RecordAccessError } from './api'
import type { CrmRecord } from './api'
import { CalculationRow } from './calculate-footer'
import { useCalculationsShown } from './calculations-setting'
import { AddFieldMenu, HeaderMenu } from './column-menu'
import {
  HeaderDragContext,
  SortableHeader,
  reorderColumns,
} from './header-drag'
import {
  CrmEditorPopover,
  CrmFieldValue,
  EditMark,
  RecordChip,
  changesInPlace,
  editStyle,
  optionLabel,
} from './cells'
import { useCrmScope } from './context'
import { downloadCsv, recordsCsv } from './export-csv'
import {
  CONTEXT_EXTENSION,
  accessFor,
  contextPolicy,
  shownFields,
} from './model'
import { useCrmNavigate, useCrmTableSearch } from './navigation'
import {
  editKey,
  editorRead,
  useCreateCrmRecord,
  useCrmEdits,
  useCrmRecords,
  useCrmWrites,
} from './queries'
import type { EditorRead } from './queries'
import { ReadOnlyNote, UnsavedEdits, crmErrorText } from './record-fields'
import { BulkUpdatePanel } from './bulk-update'
import {
  sortsFromAddress,
  sortsFromText,
  sortsToAddress,
  sortsToText,
} from './table-sorts'
import type { Sort } from './table-sorts'
import { Checkbox } from './twenty/checkbox'
import { TypeIcon } from './type-icons'

const ROW = 36
const HEADER = 32
const CHECK = 32
const IDENTIFIER = 220
/** The "+" column that brings a hidden field back. */
const PLUS = 40
/** No column is dragged narrower than this. */
const MIN_WIDTH = 104
/** Rows drawn at first, and added by "Show more". */
const STEP = 200
/** The checkbox column's id; no field is named this. */
const SELECT = '__select'
/** Every row at once: the table pages by "Show more", not by TanStack's pager. */
const ALL_ROWS = { pageIndex: 0, pageSize: Number.MAX_SAFE_INTEGER }
const columnHelper = createAppColumnHelper<CrmRecord>()
const SORT_SELECT =
  'h-7 min-w-0 flex-1 rounded-md border border-control bg-background px-1.5 text-[13px] text-ink focus-visible:outline-2 focus-visible:outline-focus'

type Editing = {
  rowId: string
  col: string
  typed?: string
  anchor: Element | null
  /** What the record was when the editor opened. */
  read: EditorRead
}

const NUMBER = new Intl.NumberFormat('en-US')

/** What a value shows as, for the search to read; a switch has no text to find. */
const shownText = (value: unknown): string =>
  value === null || value === undefined || typeof value === 'boolean'
    ? ''
    : Array.isArray(value)
      ? value.map(shownText).join(', ')
      : typeof value === 'object'
        ? JSON.stringify(value)
        : String(value)

/**
 * A value set here and mirrored to the address. The control shows what was
 * set at once and never waits on the router. The address can also change
 * without this table (the navigator opens the type afresh, Back is pressed);
 * such a change is taken up, while the address catching up with what was set
 * here is not mistaken for one.
 */
function useMirrored(address: string, write: (value: string) => void) {
  const [value, setValue] = useState(address)
  const sent = useRef<string[]>([])
  useEffect(() => {
    const echo = sent.current.indexOf(address)
    if (echo >= 0) {
      sent.current = sent.current.slice(echo + 1)
      return
    }
    sent.current = []
    setValue(address)
  }, [address])
  const set = useCallback(
    (next: string) => {
      sent.current.push(next)
      setValue(next)
      write(next)
    },
    [write],
  )
  return [value, set] as const
}

function compare(a: unknown, b: unknown) {
  const empty = (v: unknown) =>
    v === null ||
    v === undefined ||
    v === '' ||
    (Array.isArray(v) && v.length === 0)
  // A record with nothing to sort by goes last, whichever way the sort runs.
  if (empty(a) || empty(b)) return empty(a) === empty(b) ? 0 : empty(a) ? 1 : -1
  if (typeof a === 'number' && typeof b === 'number') return a - b
  const text = (v: unknown) => (Array.isArray(v) ? v.join(', ') : String(v))
  return text(a).localeCompare(text(b), undefined, {
    numeric: true,
    sensitivity: 'base',
  })
}

/**
 * One type's records as a table. A record previewed from it is the Index's
 * open item, shown in the working pane beside the view.
 */
export function CrmTable({
  type,
  fieldKeys,
  viewKey,
}: {
  type: ObjectType
  /**
   * The columns to show, in order, when a view picks them; else every shown
   * field. A saved arrangement of the view's columns replaces this order.
   */
  fieldKeys?: string[]
  /**
   * What keeps this table's arrangement apart from the same type's table
   * elsewhere. By default the Index view it is drawn in; a table that is not
   * in an Index view (a page's module) names its own.
   */
  viewKey?: string
}) {
  const scope = useCrmScope()
  const { life, titleOf } = scope
  const access = accessFor(life, type)
  const page = useCrmRecords(type, { enabled: access.read })
  const writes = useCrmWrites(type)
  const create = useCreateCrmRecord(type)
  const declare = useDeclareObjectType()
  const { openRecord, openDataModel } = useCrmNavigate()
  const place = useMaybeIndexPlace()
  const calculationsShown = useCalculationsShown()
  const view = useCrmTableSearch(type)
  const previewId = view.record
  const changeView = view.change
  const setPreview = useCallback(
    (recordId: string | undefined) => void changeView({ record: recordId }),
    [changeView],
  )
  const edits = useCrmEdits((s) => s.edits)

  const identifier = identifierField(type)
  // Search and sort are typed here and mirrored to the address, so the
  // controls never wait on the router.
  const [filter, setFilter] = useMirrored(
    view.q ?? '',
    useCallback(
      (text: string) => void changeView({ q: text || undefined }),
      [changeView],
    ),
  )
  const [filtering, setFiltering] = useState(false)
  const [sortText, setSortText] = useMirrored(
    sortsToText(
      sortsFromAddress({ sort: view.sort, desc: view.desc, then: view.then }),
    ),
    useCallback(
      (text: string) => void changeView(sortsToAddress(sortsFromText(text))),
      [changeView],
    ),
  )
  const sorts = useMemo(() => sortsFromText(sortText), [sortText])
  const setSorts = useCallback(
    (next: Sort[]) => setSortText(sortsToText(next)),
    [setSortText],
  )
  const [limit, setLimit] = useState(STEP)
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  // The row last marked, and whether Shift was held for the click being handled.
  const markedLast = useRef<string | null>(null)
  const shiftHeld = useRef(false)
  const [focus, setFocus] = useState<{ row: number; col: number }>({
    row: 0,
    col: 0,
  })
  const [editing, setEditing] = useState<Editing | null>(null)
  const [draft, setDraft] = useState<string | null>(null)
  const draftLeft = useRef(false)
  const [createError, setCreateError] = useState<unknown>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [bulk, setBulk] = useState(false)
  const [deleteReport, setDeleteReport] = useState<string | null>(null)
  const grid = useRef<HTMLDivElement>(null)

  // TanStack Table holds the columns and the row model. The checkbox column
  // and the identifier are pinned at the start; a record with nothing to
  // sort by goes last whichever way the sort runs.
  const picked = fieldKeys?.join('\u0000')
  const fields = useMemo(() => {
    const keys = picked?.split('\u0000')
    const shown = keys
      ? keys.flatMap((key) => shownFields(type).filter((f) => f.key === key))
      : shownFields(type)
    const rest = shown.filter((field) => field.key !== identifier?.key)
    return identifier ? [identifier, ...rest] : rest
  }, [type, identifier, picked])
  const tableColumns = useMemo(
    () =>
      columnHelper.columns([
        columnHelper.display({
          id: SELECT,
          size: CHECK,
          minSize: CHECK,
          enableResizing: false,
          enableHiding: false,
          enableSorting: false,
        }),
        ...fields.map((field) =>
          columnHelper.accessor(
            (record) => {
              const value = sortValue(record, field, titleOf)
              const empty =
                value === null ||
                value === undefined ||
                value === '' ||
                (Array.isArray(value) && value.length === 0)
              return empty ? undefined : value
            },
            {
              id: field.key,
              header: field.label,
              size: Math.max(
                MIN_WIDTH,
                field.key === identifier?.key
                  ? IDENTIFIER
                  : KIND[field.field_type.kind].width,
              ),
              minSize: MIN_WIDTH,
              enableHiding: field.key !== identifier?.key,
              sortUndefined: 'last',
              sortFn: (a, b, columnId) =>
                compare(a.getValue(columnId), b.getValue(columnId)),
            },
          ),
        ),
      ]),
    [fields, identifier?.key, titleOf],
  )

  // How this view is arranged (column order, widths, what is hidden and what
  // is calculated) is kept in this browser per view; the filter, the sort and
  // the previewed record are the address's. The view is the Index view the
  // table is drawn in, and the type, so a custom view of People and the
  // People table keep separate arrangements.
  const fieldIds = useMemo(
    () => [SELECT, ...fields.map((field) => field.key)],
    [fields],
  )
  const [arrangement, setArrangement, resetArrangement] = useRecordViewState(
    `${viewKey ?? place?.search.view ?? 'table'}:${type.name_singular}`,
    () => ({
      columnOrder: fieldIds,
      columnSizing: {},
      columnVisibility: {},
      aggregates: {},
    }),
  )
  const arrange =
    <TKey extends 'columnOrder' | 'columnSizing' | 'columnVisibility'>(
      key: TKey,
    ) =>
    (
      updater:
        | RecordViewState[TKey]
        | ((old: RecordViewState[TKey]) => RecordViewState[TKey]),
    ) =>
      setArrangement((old) => ({
        ...old,
        [key]: typeof updater === 'function' ? updater(old[key]) : updater,
      }))
  // A field added since the arrangement was saved joins at the end.
  const columnOrder = useMemo(() => {
    const kept = arrangement.columnOrder.filter((id) => fieldIds.includes(id))
    return [...kept, ...fieldIds.filter((id) => !kept.includes(id))]
  }, [arrangement.columnOrder, fieldIds])
  const hiddenKeys = fields
    .filter(
      (field) =>
        field.key !== identifier?.key &&
        arrangement.columnVisibility[field.key] === false,
    )
    .map((field) => field.key)

  const records = page.data?.records
  const loaded = records?.length ?? 0
  const total = page.data?.count ?? 0
  const data = useMemo(() => records ?? [], [records])
  const needle = filter.trim().toLowerCase()
  const table = useAppTable({
    // The search reads every shown column, as its cells show: a record is
    // found by its name, its email or the title of a record it points to.
    globalFilterFn: (row, columnId, text) => {
      if (hiddenKeys.includes(columnId)) return false
      const kind = fields.find((f) => f.key === columnId)?.field_type.kind
      const value = row.getValue(columnId)
      // A choice is found by the text its tag shows ("Set aside"), as well as
      // by the stored value.
      const choices =
        kind === 'enum' || kind === 'enum_many'
          ? [value].flat().map((v) => optionLabel(String(v ?? '')))
          : []
      return [shownText(value), ...choices].some((found) =>
        found.toLowerCase().includes(String(text)),
      )
    },
    columns: tableColumns,
    data,
    getRowId: (record) => record.id,
    state: {
      sorting: sorts.map((rule) => ({ id: rule.key, desc: rule.descending })),
      globalFilter: needle,
      columnOrder,
      columnSizing: arrangement.columnSizing,
      columnVisibility: Object.fromEntries(
        hiddenKeys.map((key) => [key, false]),
      ),
      columnPinning: {
        start: identifier ? [SELECT, identifier.key] : [SELECT],
        end: [],
      },
      rowSelection: Object.fromEntries(
        [...selected].map((id) => [id, true as const]),
      ),
      pagination: ALL_ROWS,
    },
    onSortingChange: (updater) => {
      const held = sorts.map((rule) => ({
        id: rule.key,
        desc: rule.descending,
      }))
      const next = typeof updater === 'function' ? updater(held) : updater
      setSorts(next.map((rule) => ({ key: rule.id, descending: rule.desc })))
    },
    onColumnVisibilityChange: arrange('columnVisibility'),
    onColumnOrderChange: arrange('columnOrder'),
    onColumnSizingChange: arrange('columnSizing'),
    onRowSelectionChange: (updater) =>
      setSelected((held) => {
        const before = Object.fromEntries(
          [...held].map((id) => [id, true as const]),
        )
        const after = typeof updater === 'function' ? updater(before) : updater
        return new Set(Object.keys(after).filter((id) => after[id]))
      }),
    enableRowSelection: true,
    enableMultiSort: true,
    autoResetPageIndex: false,
  })
  const fieldOf = useMemo(
    () => new Map(type.fields.map((field) => [field.key, field])),
    [type.fields],
  )
  const leaf = [
    ...table.getStartVisibleLeafColumns(),
    ...table.getCenterVisibleLeafColumns(),
    ...table.getEndVisibleLeafColumns(),
  ]
  const columns = leaf.flatMap((column) => fieldOf.get(column.id) ?? [])
  const widthOf = (field: FieldSpec) =>
    table.getColumn(field.key)?.getSize() ?? KIND[field.field_type.kind].width
  const totalWidth = table.getTotalSize()
  const gridWidth = totalWidth + PLUS
  const rows = table.getRowModel().rows.map((row) => row.original)
  const shown = rows.slice(0, limit)
  const headerOf = new Map(
    table.getFlatHeaders().map((header) => [header.column.id, header]),
  )
  // Only the columns this view has: a view's `fields` leave the rest out.
  const sortable = fields
  const labelOfKey = (key: string) =>
    type.fields.find((field) => field.key === key)?.label ?? key
  // The field the next rule would sort by: the first not yet used.
  const unsorted = sortable.find(
    (field) => !sorts.some((rule) => rule.key === field.key),
  )
  const hiddenFields = fields.filter((field) => hiddenKeys.includes(field.key))
  // The columns that can move: every shown one but the pinned identifier.
  const movable = columns.filter((field) => field.key !== identifier?.key)

  /** Swaps a column with its neighbour among the columns that are shown. */
  const moveColumn = (key: string, delta: -1 | 1) => {
    const neighbour = movable[movable.findIndex((f) => f.key === key) + delta]
    if (!neighbour) return
    const order = [...columnOrder]
    const [a, b] = [order.indexOf(key), order.indexOf(neighbour.key)]
    ;[order[a], order[b]] = [order[b]!, order[a]!]
    table.setColumnOrder(order)
  }
  /** A column dropped on another takes its place among the columns. */
  const dropColumn = (activeId: string, overId: string) =>
    table.setColumnOrder(
      reorderColumns(
        columnOrder,
        activeId,
        overId,
        identifier ? [SELECT, identifier.key] : [SELECT],
      ),
    )
  const setAggregate = (key: string, op: AggregateOp | undefined) =>
    setArrangement((old) => {
      const aggregates = { ...old.aggregates }
      if (op) aggregates[key] = op
      else delete aggregates[key]
      return { ...old, aggregates }
    })

  // Cell focus

  const cellAt = (row: number, col: number) =>
    grid.current?.querySelector<HTMLElement>(
      `[data-r="${row}"][data-c="${col}"]`,
    )
  const focusCell = (row: number, col: number) => {
    const r = Math.max(0, Math.min(shown.length - 1, row))
    const c = Math.max(0, Math.min(columns.length - 1, col))
    setFocus({ row: r, col: c })
    requestAnimationFrame(() => cellAt(r, c)?.focus())
  }
  const step = (row: number, col: number, move?: Move) =>
    move === 'down'
      ? focusCell(row + 1, col)
      : move === 'up'
        ? focusCell(row - 1, col)
        : move === 'right'
          ? focusCell(row, col + 1)
          : move === 'left'
            ? focusCell(row, col - 1)
            : focusCell(row, col)

  /**
   * Puts the cursor in a record's name once its row is drawn: a record just
   * created is where the person goes on typing. The row arrives a render
   * later, so this looks again for a few frames and then gives up.
   */
  const focusRecord = (id: string, tries = 20) => {
    const cell = [
      ...(grid.current?.querySelectorAll<HTMLElement>('[data-record]') ?? []),
    ].find((candidate) => candidate.dataset.record === id)
    if (cell) {
      cell.scrollIntoView({ block: 'nearest' })
      cell.focus()
    } else if (tries > 0)
      requestAnimationFrame(() => focusRecord(id, tries - 1))
  }

  // Editing

  const editable = (field: FieldSpec) =>
    access.write && editStyle(field) !== 'none'
  const startEdit = (row: number, col: number, typed?: string) => {
    const record = shown[row]
    const field = columns[col]
    if (!record || !field || !editable(field)) return
    if (edits[editKey(record.id, field.key)]?.status === 'saving') return
    const style = editStyle(field)
    if (style === 'toggle') {
      void writes.save(record, field, !(record.values[field.key] === true))
      return
    }
    if (typed !== undefined && style !== 'inline') return
    setFocus({ row, col })
    setEditing({
      rowId: record.id,
      col: field.key,
      typed,
      anchor: cellAt(row, col) ?? null,
      read: editorRead(record, field, edits[editKey(record.id, field.key)]),
    })
  }
  /** Save what the open editor ends with, against what it opened on. */
  const saveEdited = (record: CrmRecord, field: FieldSpec, value: unknown) =>
    writes.saveFrom(
      record,
      field,
      value,
      editing?.rowId === record.id && editing.col === field.key
        ? editing.read
        : editorRead(record, field, edits[editKey(record.id, field.key)]),
    )
  const commit = (
    record: CrmRecord,
    field: FieldSpec,
    value: unknown,
    move?: Move,
  ) => {
    setEditing(null)
    void saveEdited(record, field, value)
    step(
      shown.findIndex((r) => r.id === record.id),
      columns.findIndex((f) => f.key === field.key),
      move,
    )
  }
  /**
   * Backspace or Delete on a cell empties it, by the same write the editor
   * makes on closing: it names the revision that was on screen, so a record
   * changed elsewhere is refused and the refusal is shown as any other.
   * The identifier and a required field are never emptied, nor is a switch.
   */
  const clearable = (field: FieldSpec) =>
    editable(field) &&
    editStyle(field) !== 'toggle' &&
    field.key !== identifier?.key &&
    !field.required
  const clearCell = (record: CrmRecord, field: FieldSpec) => {
    const spec = field.field_type
    const many =
      spec.kind === 'enum_many' ||
      (spec.kind === 'relation' && spec.cardinality === 'many')
    const waiting = editorRead(
      record,
      field,
      edits[editKey(record.id, field.key)],
    )
    // Nothing to empty, or a save still on its way: nothing is sent.
    if (isEmptyValue(waiting.shown)) return
    if (edits[editKey(record.id, field.key)]?.status === 'saving') return
    void writes.saveFrom(record, field, many ? [] : null, waiting)
  }
  /** Escape: the value stays as it was and the cell keeps the cursor. */
  const discard = () => {
    setEditing(null)
    step(focus.row, focus.col)
  }

  const onCellKey = (
    event: KeyboardEvent<HTMLElement>,
    row: number,
    col: number,
  ) => {
    if (event.target !== event.currentTarget || editing) return
    const record = shown[row]
    const arrows: Record<string, Move> = {
      ArrowDown: 'down',
      ArrowUp: 'up',
      ArrowRight: 'right',
      ArrowLeft: 'left',
    }
    if (arrows[event.key]) {
      event.preventDefault()
      step(row, col, arrows[event.key])
    } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      if (record) void openRecord(type, record.id)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      startEdit(row, col)
    } else if (event.key === ' ') {
      event.preventDefault()
      if (record) setPreview(record.id)
    } else if (event.key === 'Escape') {
      if (previewId) {
        event.preventDefault()
        setPreview(undefined)
      }
    } else if (event.key === 'Tab') {
      // Across the row; past its ends Tab leaves the grid, which is no trap.
      const to = col + (event.shiftKey ? -1 : 1)
      if (to >= 0 && to < columns.length) {
        event.preventDefault()
        focusCell(row, to)
      }
    } else if (event.key === 'Backspace' || event.key === 'Delete') {
      const field = columns[col]
      if (record && field && clearable(field)) {
        event.preventDefault()
        clearCell(record, field)
      }
    } else if (
      event.key.length === 1 &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey
    ) {
      const field = columns[col]
      if (field && editable(field) && editStyle(field) === 'inline') {
        event.preventDefault()
        startEdit(row, col, event.key)
      }
    }
  }

  // Adding

  const addRecord = (name: string) => {
    const text = name.trim()
    setDraft(null)
    if (!text || !identifier) return
    setCreateError(null)
    create.mutate(
      { [identifier.key]: text },
      {
        onSuccess: (record) => {
          // The new record must be on screen to take the cursor.
          if (
            filter &&
            !text.toLowerCase().includes(filter.trim().toLowerCase())
          )
            setFilter('')
          setLimit(Number.MAX_SAFE_INTEGER)
          focusRecord(record.id)
        },
        onError: setCreateError,
      },
    )
  }
  const openDraft = () => {
    setDraft('')
    requestAnimationFrame(() =>
      grid.current
        ?.querySelector<HTMLElement>('[data-add-row]')
        ?.scrollIntoView({ block: 'nearest' }),
    )
  }

  // Selection

  const toggleSelected = (id: string) => table.getRow(id).toggleSelected()
  /** A click on a row's box; with Shift, every row from the last one marked to this one. */
  const markRow = (id: string, range: boolean) => {
    const at = shown.findIndex((record) => record.id === id)
    const from = shown.findIndex((record) => record.id === markedLast.current)
    if (range && from >= 0 && at >= 0) {
      const on = !selected.has(id)
      const between = shown.slice(Math.min(from, at), Math.max(from, at) + 1)
      setSelected((held) => {
        const next = new Set(held)
        for (const record of between)
          if (on) next.add(record.id)
          else next.delete(record.id)
        return next
      })
    } else toggleSelected(id)
    markedLast.current = id
  }
  const allSelected =
    shown.length > 0 && shown.every((record) => selected.has(record.id))
  const someSelected = shown.some((record) => selected.has(record.id))
  // The marked records as they are read now; a mark on a record that has
  // gone is not among them.
  const chosen = useMemo(
    () => (records ?? []).filter((record) => selected.has(record.id)),
    [records, selected],
  )
  /** The marked records, else every record the filter leaves, as a CSV file of the columns shown. */
  const exportRows = () => {
    const inView = new Set(rows.map((record) => record.id))
    const marked = [
      ...rows.filter((record) => selected.has(record.id)),
      ...chosen.filter((record) => !inView.has(record.id)),
    ]
    downloadCsv(
      type.name_plural,
      recordsCsv(columns, selected.size ? marked : rows, titleOf),
    )
  }
  const deleteSelected = async () => {
    setConfirmDelete(false)
    let deleted = 0
    const refused: string[] = []
    for (const record of chosen)
      try {
        await writes.remove(record)
        deleted += 1
      } catch (error) {
        refused.push(
          `${recordTitle(type, record)}: ${crmErrorText(error, type)}`,
        )
      }
    setSelected(new Set())
    setDeleteReport(
      refused.length
        ? `${deleted} deleted, ${refused.length} not deleted. ${refused.join(' ')}`
        : null,
    )
  }

  // Assistant use, for the whole type

  // Read by the server's rules: a type with no setting is not used, and a
  // setting this version cannot read is left as it is, never overwritten.
  const context = contextPolicy(type)
  const setAssistance = (available: boolean) => {
    if (context.state === 'unreadable') return
    declare.mutate({
      input: {
        ...toInput(type),
        extensions: {
          ...type.extensions,
          [CONTEXT_EXTENSION]: {
            ...(context.policy ?? { version: 1 }),
            assistance: available ? 'available' : 'excluded',
          },
        },
      },
      anchor: type.content_anchor,
    })
  }

  // Assistant use, field by field: a field kept from Theorem is never sent,
  // and a record is never found by what that field holds.
  const keptFromTheorem = new Set(context.policy?.excluded_fields ?? [])
  const setFieldRead = (key: string, read: boolean) => {
    if (context.state === 'unreadable' || !context.policy) return
    const kept = new Set(keptFromTheorem)
    if (read) kept.delete(key)
    else kept.add(key)
    declare.mutate({
      input: {
        ...toInput(type),
        extensions: {
          ...type.extensions,
          [CONTEXT_EXTENSION]: {
            ...context.policy,
            excluded_fields: type.fields
              .map((field) => field.key)
              .filter((field) => kept.has(field)),
          },
        },
      },
      anchor: type.content_anchor,
    })
  }

  const plural = type.label_plural
  const noun = type.label_singular.toLowerCase()
  const denied = !access.read || page.error instanceof RecordAccessError
  const editingRow = editing
    ? shown.find((r) => r.id === editing.rowId)
    : undefined
  const editingField = editing
    ? columns.find((f) => f.key === editing.col)
    : undefined

  const count = () => {
    if (!page.data) return ''
    const some = (n: number) =>
      `${NUMBER.format(n)} ${n === 1 ? noun : plural.toLowerCase()}`
    if (total > loaded)
      return `Showing the first ${NUMBER.format(loaded)} of ${some(total)}. Search and sort work on these ${NUMBER.format(loaded)}.`
    if (filter.trim())
      return `${NUMBER.format(rows.length)} of ${some(loaded)} match “${filter.trim()}”`
    return some(loaded)
  }

  return (
    <div className="flex h-full min-w-0">
      <section
        aria-label={plural}
        className="flex h-full min-w-0 flex-1 flex-col bg-background"
      >
        {/* Page header: 44 px */}
        <header
          data-crm-region="page-header"
          className="flex h-11 shrink-0 items-center gap-2 border-b border-separator px-3"
        >
          <TypeIcon type={type} className="text-ink-muted" />
          <h1 className="min-w-0 flex-1 truncate text-sm font-medium text-ink">
            {plural}
          </h1>
          {access.write && !denied && identifier && (
            <Button size="sm" variant="outline" onClick={openDraft}>
              <Plus aria-hidden />
              New record
            </Button>
          )}
        </header>

        {denied ? (
          <Unavailable type={type} />
        ) : (
          <>
            {/* View bar: 40 px */}
            <div
              data-crm-region="view-bar"
              className="flex h-10 shrink-0 items-center gap-1 border-b border-separator px-3 text-[13px]"
            >
              <span className="font-medium text-ink">All {plural}</span>
              {page.data && (
                <span className="text-ink-muted tabular-nums">
                  · {NUMBER.format(total)}
                </span>
              )}
              {context.state !== 'available' && (
                <span className="ms-2 truncate text-xs text-ink-muted">
                  {context.state === 'unreadable'
                    ? `Theorem does not use ${plural.toLowerCase()} when it answers: this type’s setting could not be read.`
                    : `Theorem does not use ${plural.toLowerCase()} when it answers.`}
                </span>
              )}
              <span className="flex-1" />
              {selected.size > 0 && (
                <>
                  <span className="text-xs text-ink-muted tabular-nums">
                    {selected.size} selected
                  </span>
                  <Button size="xs" variant="ghost" onClick={exportRows}>
                    <Download aria-hidden />
                    Export
                  </Button>
                  {access.write && (
                    <>
                      <Button
                        size="xs"
                        variant="ghost"
                        aria-pressed={bulk}
                        onClick={() => setBulk(true)}
                      >
                        Update
                      </Button>
                      <Button
                        size="xs"
                        variant="ghost"
                        className="text-error-ink hover:text-error-ink"
                        onClick={() => setConfirmDelete(true)}
                      >
                        Delete
                      </Button>
                    </>
                  )}
                  <span aria-hidden className="mx-1 h-4 w-px bg-separator" />
                </>
              )}
              {filtering || filter ? (
                <span className="flex h-7 items-center gap-1 rounded-md border border-control bg-background ps-2 pe-1 focus-within:outline-2 focus-within:outline-focus">
                  <Search aria-hidden className="size-3.5 text-ink-muted" />
                  <input
                    autoFocus={filtering}
                    value={filter}
                    aria-label={`Search ${plural.toLowerCase()}`}
                    placeholder={`Search ${plural.toLowerCase()}`}
                    onChange={(event) => {
                      setFilter(event.target.value)
                      setLimit(STEP)
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Escape') {
                        event.preventDefault()
                        setFilter('')
                        setFiltering(false)
                      }
                    }}
                    onBlur={() => setFiltering(false)}
                    className="w-40 bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-faint"
                  />
                  <button
                    type="button"
                    aria-label="Clear search"
                    onClick={() => {
                      setFilter('')
                      setFiltering(false)
                    }}
                    className="flex size-5 items-center justify-center rounded-sm text-ink-muted hover:bg-hover hover:text-ink focus-visible:outline-2 focus-visible:outline-focus"
                  >
                    <X aria-hidden className="size-3" />
                  </button>
                </span>
              ) : (
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => setFiltering(true)}
                >
                  <Search aria-hidden />
                  Search
                </Button>
              )}
              <Popover>
                <PopoverTrigger
                  render={
                    <Button size="xs" variant="ghost">
                      <ArrowUpDown aria-hidden />
                      {sorts.length
                        ? `Sort: ${labelOfKey(sorts[0]!.key)}${sorts.length > 1 ? ` +${sorts.length - 1}` : ''}`
                        : 'Sort'}
                    </Button>
                  }
                />
                <PopoverPopup align="end" className="w-80">
                  <ul aria-label="Sort rules" className="flex flex-col gap-1.5">
                    {sorts.map((rule, at) => (
                      <li
                        key={rule.key}
                        className="flex items-center gap-1.5 text-[13px]"
                      >
                        <span className="w-9 shrink-0 text-xs text-ink-muted">
                          {at === 0 ? 'Sort' : 'Then'}
                        </span>
                        <select
                          aria-label={`Sort ${at + 1} field`}
                          value={rule.key}
                          onChange={(event) =>
                            setSorts(
                              sorts.map((held, i) =>
                                i === at
                                  ? { ...held, key: event.target.value }
                                  : held,
                              ),
                            )
                          }
                          className={SORT_SELECT}
                        >
                          {sortable
                            .filter(
                              (field) =>
                                field.key === rule.key ||
                                !sorts.some((held) => held.key === field.key),
                            )
                            .map((field) => (
                              <option key={field.key} value={field.key}>
                                {field.label}
                              </option>
                            ))}
                        </select>
                        <select
                          aria-label={`Sort ${at + 1} direction`}
                          value={rule.descending ? 'descending' : 'ascending'}
                          onChange={(event) =>
                            setSorts(
                              sorts.map((held, i) =>
                                i === at
                                  ? {
                                      ...held,
                                      descending:
                                        event.target.value === 'descending',
                                    }
                                  : held,
                              ),
                            )
                          }
                          className={SORT_SELECT}
                        >
                          <option value="ascending">Ascending</option>
                          <option value="descending">Descending</option>
                        </select>
                        <button
                          type="button"
                          aria-label={`Remove sort ${at + 1}`}
                          onClick={() =>
                            setSorts(sorts.filter((_, i) => i !== at))
                          }
                          className="flex size-6 shrink-0 items-center justify-center rounded-sm text-ink-muted hover:bg-hover hover:text-ink focus-visible:outline-2 focus-visible:outline-focus"
                        >
                          <X aria-hidden className="size-3" />
                        </button>
                      </li>
                    ))}
                  </ul>
                  {!sorts.length && (
                    <p className="text-[13px] text-ink-muted">
                      Not sorted. Add a sort to order the rows.
                    </p>
                  )}
                  <div className="mt-2 flex items-center gap-1">
                    <Button
                      size="xs"
                      variant="ghost"
                      disabled={!unsorted}
                      onClick={() =>
                        unsorted &&
                        setSorts([
                          ...sorts,
                          { key: unsorted.key, descending: false },
                        ])
                      }
                    >
                      <Plus aria-hidden />
                      Add sort
                    </Button>
                    <span className="flex-1" />
                    <Button
                      size="xs"
                      variant="ghost"
                      disabled={!sorts.length}
                      onClick={() => setSorts([])}
                    >
                      Clear sorts
                    </Button>
                  </div>
                </PopoverPopup>
              </Popover>
              <Menu>
                <MenuTrigger
                  render={
                    <Button size="xs" variant="ghost">
                      <Settings2 aria-hidden />
                      Options
                    </Button>
                  }
                />
                <MenuPopup align="end" className="w-64">
                  <MenuGroup>
                    <MenuGroupLabel>Columns</MenuGroupLabel>
                    {fields.map((field) => (
                      <MenuCheckboxItem
                        key={field.key}
                        closeOnClick={false}
                        disabled={field.key === identifier?.key}
                        checked={!hiddenKeys.includes(field.key)}
                        onCheckedChange={(checked) =>
                          table.getColumn(field.key)?.toggleVisibility(checked)
                        }
                      >
                        {field.label}
                      </MenuCheckboxItem>
                    ))}
                  </MenuGroup>
                  <MenuSeparator />
                  <MenuItem disabled={!rows.length} onClick={exportRows}>
                    <Download aria-hidden />
                    {selected.size
                      ? `Export ${selected.size} selected as CSV`
                      : 'Export as CSV'}
                  </MenuItem>
                  <MenuItem onClick={resetArrangement}>
                    <RotateCcw aria-hidden />
                    Reset arrangement
                  </MenuItem>
                  <MenuSeparator />
                  <MenuGroup>
                    <MenuGroupLabel>Theorem</MenuGroupLabel>
                    <MenuCheckboxItem
                      variant="switch"
                      closeOnClick={false}
                      disabled={
                        !access.write ||
                        declare.isPending ||
                        context.state === 'unreadable'
                      }
                      checked={context.state === 'available'}
                      onCheckedChange={setAssistance}
                    >
                      May use {plural.toLowerCase()} in answers
                    </MenuCheckboxItem>
                  </MenuGroup>
                  {context.state === 'available' && (
                    <MenuGroup>
                      <MenuGroupLabel>Fields Theorem may read</MenuGroupLabel>
                      {shownFields(type).map((field) => (
                        <MenuCheckboxItem
                          key={field.key}
                          closeOnClick={false}
                          aria-label={`Theorem may read ${field.label}`}
                          disabled={
                            !access.write ||
                            declare.isPending ||
                            field.key === identifier?.key
                          }
                          checked={!keptFromTheorem.has(field.key)}
                          onCheckedChange={(read) =>
                            setFieldRead(field.key, read)
                          }
                        >
                          {field.label}
                        </MenuCheckboxItem>
                      ))}
                    </MenuGroup>
                  )}
                </MenuPopup>
              </Menu>
            </div>

            {!access.write && (
              <div className="border-b border-separator px-3 py-1.5">
                <ReadOnlyNote type={type} />
              </div>
            )}
            <UnsavedEdits
              type={type}
              writes={writes}
              recordOf={(id) => records?.find((record) => record.id === id)}
              className="border-t-0"
            />
            {(createError !== null || deleteReport || declare.isError) && (
              <p
                role="alert"
                className="border-b border-separator bg-error-container/40 px-3 py-1.5 text-xs leading-5 text-ink"
              >
                {createError !== null &&
                  `Not added. ${crmErrorText(createError, type)} `}
                {deleteReport}
                {declare.isError &&
                  ` Not changed. ${crmErrorText(declare.error, type)}`}
              </p>
            )}

            {/* Rows */}
            <div
              ref={grid}
              role="grid"
              aria-label={`All ${plural}`}
              aria-rowcount={page.data ? rows.length + 1 : undefined}
              aria-colcount={columns.length + 2}
              aria-busy={page.isPending || undefined}
              className="min-h-0 flex-1 overflow-auto text-[13px]"
            >
              <table.AppTable>
                <div role="rowgroup" className="sticky top-0 z-20">
                  <div
                    role="row"
                    aria-rowindex={1}
                    className="flex border-b border-separator bg-raised"
                    style={{
                      height: HEADER,
                      width: `max(100%, ${gridWidth}px)`,
                    }}
                  >
                    <div
                      role="columnheader"
                      className="sticky left-0 z-10 flex shrink-0 items-center justify-center bg-raised"
                      style={{ width: CHECK }}
                    >
                      <Checkbox
                        aria-label={`Select all ${plural.toLowerCase()}`}
                        checked={allSelected}
                        indeterminate={someSelected && !allSelected}
                        disabled={!shown.length}
                        onCheckedChange={(checked) =>
                          setSelected(
                            checked
                              ? new Set(shown.map((r) => r.id))
                              : new Set(),
                          )
                        }
                      />
                    </div>
                    <HeaderDragContext
                      movable={movable.map((field) => field.key)}
                      labelOf={labelOfKey}
                      onMove={dropColumn}
                    >
                      {columns.map((field, col) => {
                        const rule = sorts.find(
                          (held) => held.key === field.key,
                        )
                        const header = headerOf.get(field.key)
                        const isIdentifier = field.key === identifier?.key
                        const at = movable.findIndex((f) => f.key === field.key)
                        return (
                          <SortableHeader
                            key={field.key}
                            id={field.key}
                            pinned={isIdentifier}
                            role="columnheader"
                            aria-sort={
                              rule
                                ? rule.descending
                                  ? 'descending'
                                  : 'ascending'
                                : 'none'
                            }
                            className={cn(
                              'group/header flex shrink-0 items-center border-s border-separator bg-raised data-dragging:shadow-md',
                              col === 0 ? 'sticky z-10 border-s-0' : 'relative',
                            )}
                            style={{
                              width: widthOf(field),
                              left: col === 0 ? CHECK : undefined,
                            }}
                          >
                            {(drag) => (
                              <>
                                <HeaderMenu
                                  field={field}
                                  isIdentifier={isIdentifier}
                                  canMoveLeft={at > 0}
                                  canMoveRight={
                                    at >= 0 && at < movable.length - 1
                                  }
                                  drag={drag}
                                  onSort={(descending) =>
                                    setSorts([{ key: field.key, descending }])
                                  }
                                  onSearch={() => setFiltering(true)}
                                  onMove={(delta) =>
                                    moveColumn(field.key, delta)
                                  }
                                  onHide={() =>
                                    table
                                      .getColumn(field.key)
                                      ?.toggleVisibility(false)
                                  }
                                >
                                  <FieldTypeIcon kind={field.field_type.kind} />
                                  <span className="min-w-0 flex-1 truncate">
                                    {field.label}
                                  </span>
                                  {rule &&
                                    (rule.descending ? (
                                      <ArrowDown
                                        aria-hidden
                                        className="size-3 shrink-0"
                                      />
                                    ) : (
                                      <ArrowUp
                                        aria-hidden
                                        className="size-3 shrink-0"
                                      />
                                    ))}
                                </HeaderMenu>
                                {header && header.column.getCanResize() && (
                                  <table.AppHeader header={header}>
                                    {(h) => <h.ResizeHandle />}
                                  </table.AppHeader>
                                )}
                              </>
                            )}
                          </SortableHeader>
                        )
                      })}
                    </HeaderDragContext>
                    <div
                      role="columnheader"
                      aria-label="Fields"
                      className="shrink-0 border-s border-separator bg-raised"
                      style={{ width: PLUS }}
                    >
                      <AddFieldMenu
                        hidden={hiddenFields}
                        onShow={(key) =>
                          table.getColumn(key)?.toggleVisibility(true)
                        }
                        onCustomize={() => void openDataModel(type)}
                      />
                    </div>
                  </div>
                </div>
              </table.AppTable>

              <div role="rowgroup">
                {shown.map((record, row) => {
                  const isSelected = selected.has(record.id)
                  const isPreviewed = record.id === previewId
                  const ground =
                    isPreviewed || isSelected ? 'bg-selected' : 'bg-background'
                  return (
                    <div
                      key={record.id}
                      role="row"
                      aria-rowindex={row + 2}
                      aria-selected={isSelected}
                      aria-current={isPreviewed ? 'true' : undefined}
                      onClick={() => setPreview(record.id)}
                      className={cn(
                        'group/tr flex cursor-default border-b border-separator',
                        ground,
                        !isPreviewed && !isSelected && 'hover:bg-hover',
                      )}
                      style={{
                        height: ROW,
                        width: `max(100%, ${gridWidth}px)`,
                      }}
                    >
                      <div
                        role="gridcell"
                        onClick={(event) => event.stopPropagation()}
                        className={cn(
                          'sticky left-0 z-10 flex shrink-0 select-none items-center justify-center',
                          ground,
                          !isPreviewed &&
                            !isSelected &&
                            'group-hover/tr:bg-hover',
                        )}
                        style={{ width: CHECK }}
                      >
                        <Checkbox
                          aria-label={`Select ${recordTitle(type, record)}`}
                          checked={isSelected}
                          onClick={(event) => {
                            shiftHeld.current = event.shiftKey
                          }}
                          onCheckedChange={() => {
                            markRow(record.id, shiftHeld.current)
                            shiftHeld.current = false
                          }}
                        />
                      </div>
                      {columns.map((field, col) => {
                        const edit = edits[editKey(record.id, field.key)]
                        const value = edit
                          ? edit.value
                          : record.values[field.key]
                        const active = focus.row === row && focus.col === col
                        const inline =
                          editing?.rowId === record.id &&
                          editing.col === field.key &&
                          editStyle(field) === 'inline'
                        return (
                          <div
                            key={field.key}
                            role="gridcell"
                            data-r={row}
                            data-c={col}
                            data-record={col === 0 ? record.id : undefined}
                            tabIndex={active ? 0 : -1}
                            aria-colindex={col + 2}
                            aria-readonly={!editable(field) || undefined}
                            onFocus={(event) => {
                              if (event.target === event.currentTarget)
                                setFocus({ row, col })
                            }}
                            onKeyDown={(event) => onCellKey(event, row, col)}
                            onDoubleClick={() => startEdit(row, col)}
                            className={cn(
                              'relative flex shrink-0 items-center gap-1.5 overflow-hidden border-s border-separator px-2 outline-none focus-visible:z-[5] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus',
                              col === 0 && cn('sticky z-10 border-s-0', ground),
                              col === 0 &&
                                !isPreviewed &&
                                !isSelected &&
                                'group-hover/tr:bg-hover',
                            )}
                            style={{
                              width: widthOf(field),
                              left: col === 0 ? CHECK : undefined,
                            }}
                          >
                            {inline ? (
                              <div
                                className="absolute inset-0 z-[6] flex items-center bg-background px-2 outline-2 -outline-offset-2 outline-focus"
                                onClick={(event) => event.stopPropagation()}
                              >
                                <FieldEditor
                                  field={field}
                                  hint={displayHint(type, field.key)}
                                  value={value}
                                  row={record}
                                  typed={editing.typed}
                                  onCommit={(next, move) =>
                                    commit(record, field, next, move)
                                  }
                                  onDiscard={discard}
                                />
                              </div>
                            ) : (
                              <>
                                <span className="flex min-w-0 flex-1 items-center overflow-hidden">
                                  {col === 0 ? (
                                    <RecordChip
                                      type={type}
                                      record={
                                        edit
                                          ? {
                                              ...record,
                                              values: {
                                                ...record.values,
                                                [field.key]: value,
                                              },
                                            }
                                          : record
                                      }
                                      weight="medium"
                                    />
                                  ) : (
                                    <CrmFieldValue
                                      type={type}
                                      record={record}
                                      field={field}
                                      value={value}
                                      tabIndex={-1}
                                      onOpenRelated={(target, id) =>
                                        void openRecord(target, id)
                                      }
                                      onToggle={
                                        editable(field) &&
                                        changesInPlace(type, field)
                                          ? (next) =>
                                              void writes.save(
                                                record,
                                                field,
                                                next,
                                              )
                                          : undefined
                                      }
                                    />
                                  )}
                                </span>
                                <EditMark edit={edit} />
                              </>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  )
                })}
              </div>

              {page.isPending && (
                <p role="status" className="px-3 py-3 text-ink-muted">
                  Loading {plural.toLowerCase()}
                </p>
              )}
              {page.isError && (
                <div
                  role="alert"
                  className="flex items-center gap-2 px-3 py-3 text-ink"
                >
                  <span>
                    {plural} could not be loaded.{' '}
                    {crmErrorText(page.error, type)}
                  </span>
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() => void page.refetch()}
                  >
                    Try again
                  </Button>
                </div>
              )}
              {page.data && rows.length === 0 && (
                <p className="px-3 py-3 text-ink-muted">
                  {loaded === 0
                    ? `No ${plural.toLowerCase()} yet.`
                    : `No ${plural.toLowerCase()} match “${filter.trim()}”.`}
                </p>
              )}
              {rows.length > shown.length && (
                <button
                  type="button"
                  onClick={() => setLimit((n) => n + STEP)}
                  className="flex w-full items-center px-3 text-start text-ink-muted hover:bg-hover hover:text-ink focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus"
                  style={{ height: ROW }}
                >
                  Show {Math.min(STEP, rows.length - shown.length)} more
                </button>
              )}

              {/* Add new */}
              {page.data && access.write && identifier && (
                <div
                  data-add-row
                  className="flex border-b border-separator"
                  style={{ height: ROW, width: `max(100%, ${gridWidth}px)` }}
                >
                  {draft === null ? (
                    <button
                      type="button"
                      disabled={create.isPending}
                      onClick={() => setDraft('')}
                      className="sticky left-0 flex h-full items-center gap-2 ps-2.5 pe-3 text-start text-ink-muted hover:text-ink focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus"
                    >
                      <Plus aria-hidden className="size-3.5" />
                      {create.isPending ? 'Adding' : 'Add new'}
                    </button>
                  ) : (
                    <div
                      className="sticky left-0 flex items-center ps-8 pe-2"
                      style={{ width: CHECK + IDENTIFIER }}
                    >
                      <input
                        autoFocus
                        value={draft}
                        aria-label={`New ${noun}: ${identifier.label.toLowerCase()}`}
                        placeholder={`${identifier.label}, then Enter`}
                        onFocus={() => {
                          draftLeft.current = false
                        }}
                        onChange={(event) => setDraft(event.target.value)}
                        onBlur={() => {
                          if (!draftLeft.current) addRecord(draft)
                        }}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            event.preventDefault()
                            draftLeft.current = true
                            addRecord(draft)
                          } else if (event.key === 'Escape') {
                            // Nothing is created.
                            event.preventDefault()
                            draftLeft.current = true
                            setDraft(null)
                          }
                        }}
                        className="h-6 w-full rounded-sm bg-background px-1.5 text-[13px] text-ink outline-2 outline-focus placeholder:text-ink-faint"
                      />
                    </div>
                  )}
                </div>
              )}

              {/* Calculate: over the records loaded, as the count below says */}
              {calculationsShown && page.data && columns.length > 0 && (
                <CalculationRow
                  fields={columns}
                  height={HEADER}
                  checkWidth={CHECK}
                  totalWidth={gridWidth}
                  widthOf={widthOf}
                  aggregates={arrangement.aggregates}
                  partial={total > loaded}
                  // Saved values only: an edit that is saving, refused or held
                  // joins the totals once Theorem has it.
                  valuesOf={(field) =>
                    rows.map((record) => record.values[field.key])
                  }
                  onChange={setAggregate}
                />
              )}
            </div>

            {/* Count */}
            <footer
              role="status"
              className="flex h-8 shrink-0 items-center border-t border-separator px-3 text-xs text-ink-muted tabular-nums"
            >
              {count()}
            </footer>
          </>
        )}
      </section>

      {bulk && access.write ? (
        <BulkUpdatePanel
          type={type}
          selected={chosen}
          writes={writes}
          onMark={(ids) => setSelected(new Set(ids))}
          onClose={() => setBulk(false)}
        />
      ) : null}
      {editing &&
        editingRow &&
        editingField &&
        editStyle(editingField) === 'popover' && (
          <CrmEditorPopover
            type={type}
            record={editingRow}
            field={editingField}
            value={
              edits[editKey(editingRow.id, editingField.key)]?.value ??
              editingRow.values[editingField.key]
            }
            anchor={editing.anchor}
            sideOffset={-ROW}
            onCommit={(value, move) =>
              commit(editingRow, editingField, value, move)
            }
            onCommitAway={(value) => {
              setEditing(null)
              void saveEdited(editingRow, editingField, value)
            }}
            onDiscard={discard}
          />
        )}

      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Delete {selected.size}{' '}
              {selected.size === 1 ? noun : plural.toLowerCase()}?
            </DialogTitle>
            <DialogDescription>
              They are removed from Theorem and cannot be brought back here. A
              record that changed since this table loaded is left alone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => void deleteSelected()}>
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

/** A type this sign-in may not read: said plainly, not drawn as an empty table. */
function Unavailable({ type }: { type: ObjectType }) {
  return (
    <div
      role="status"
      className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1 px-6 text-center"
    >
      <p className="text-sm font-medium text-ink">
        {type.label_plural} are not available to this sign-in.
      </p>
      <p className="max-w-sm text-xs leading-5 text-ink-muted">
        They may exist; this sign-in is not allowed to read them. Sign in with
        an account that can, or ask whoever manages this workspace.
      </p>
    </div>
  )
}
