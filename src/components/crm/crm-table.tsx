// SOURCING: Twenty's record table for the anatomy and the measurements Theorem's spec fixes (a 44 px page header, a 40 px view bar, a sticky 32 px header row with field-type icons, 36 px rows, a 32 px checkbox column, a 220 px pinned identifier column, an "Add new" row, a count footer, a 420 px record preview); the ported Twenty primitives (./twenty); coss ui Menu; the schema register's inline editors (components/records/fields); the WAI-ARIA grid pattern for the roles and the roving cell focus. TanStack Table v9 through the app's kit hook (components/data-table/table-hook, vendored from TanStack's kitchen-sink-shadcn-base example) owns the columns, their widths and pinning, sorting, the filter, hidden columns and the marked rows; the rows it returns are drawn here to Twenty's measurements
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ListFilter,
  Plus,
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
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from '@/components/coss/menu'
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
  recordTitle,
} from '@/components/records/model'
import { useDeclareObjectType } from '@/components/records/queries'
import { toInput } from '@/components/records/schema-edit'
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
import {
  CrmEditorPopover,
  CrmFieldValue,
  EditMark,
  RecordChip,
  editStyle,
} from './cells'
import { useCrmScope } from './context'
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
import { RecordPreview } from './record-preview'
import { BulkUpdatePanel } from './bulk-update'
import { Checkbox } from './twenty/checkbox'
import { TypeIcon } from './type-icons'

const ROW = 36
const HEADER = 32
const CHECK = 32
const IDENTIFIER = 220
/** Rows drawn at first, and added by "Show more". */
const STEP = 200
/** The checkbox column's id; no field is named this. */
const SELECT = '__select'
/** Every row at once: the table pages by "Show more", not by TanStack's pager. */
const ALL_ROWS = { pageIndex: 0, pageSize: Number.MAX_SAFE_INTEGER }
const columnHelper = createAppColumnHelper<CrmRecord>()

type Sort = { key: string; descending: boolean }
type Editing = {
  rowId: string
  col: string
  typed?: string
  anchor: Element | null
  /** What the record was when the editor opened. */
  read: EditorRead
}

const NUMBER = new Intl.NumberFormat('en-US')

/** A sort as one string, so it can be compared with what the address holds. */
const sortToText = (sort: Sort | null) =>
  sort ? `${sort.descending ? '-' : '+'}${sort.key}` : ''
const sortFromText = (text: string): Sort | null =>
  text ? { key: text.slice(1), descending: text.startsWith('-') } : null

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

/** One type's records as a table, with the record preview beside it. */
export function CrmTable({ type }: { type: ObjectType }) {
  const scope = useCrmScope()
  const { life, titleOf } = scope
  const access = accessFor(life, type)
  const page = useCrmRecords(type, { enabled: access.read })
  const writes = useCrmWrites(type)
  const create = useCreateCrmRecord(type)
  const declare = useDeclareObjectType()
  const { openRecord } = useCrmNavigate()
  const view = useCrmTableSearch(type)
  const previewId = view.record
  const changeView = view.change
  const setPreview = useCallback(
    (recordId: string | undefined) => void changeView({ record: recordId }),
    [changeView],
  )
  const edits = useCrmEdits((s) => s.edits)

  const identifier = identifierField(type)
  // Filter and sort are typed here and mirrored to the address, so the field
  // never waits on the router.
  const [filter, setFilter] = useMirrored(
    view.q ?? '',
    useCallback(
      (text: string) => void changeView({ q: text || undefined }),
      [changeView],
    ),
  )
  const [filtering, setFiltering] = useState(false)
  const [sortText, setSortText] = useMirrored(
    sortToText(
      view.sort ? { key: view.sort, descending: view.desc === true } : null,
    ),
    useCallback(
      (text: string) => {
        const next = sortFromText(text)
        void changeView({
          sort: next?.key,
          desc: next?.descending ? true : undefined,
        })
      },
      [changeView],
    ),
  )
  const sort = useMemo(() => sortFromText(sortText), [sortText])
  const setSort = useCallback(
    (next: Sort | null) => setSortText(sortToText(next)),
    [setSortText],
  )
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set())
  const [limit, setLimit] = useState(STEP)
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
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
  const fields = useMemo(() => {
    const rest = shownFields(type).filter(
      (field) => field.key !== identifier?.key,
    )
    return identifier ? [identifier, ...rest] : rest
  }, [type, identifier])
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
              size:
                field.key === identifier?.key
                  ? IDENTIFIER
                  : KIND[field.field_type.kind].width,
              enableResizing: false,
              enableHiding: field.key !== identifier?.key,
              sortUndefined: 'last',
              sortFn: (a, b, columnId) =>
                compare(a.getValue(columnId), b.getValue(columnId)),
              // The filter is over a record's name, whichever column holds it.
              filterFn: (row, _columnId, needle) =>
                recordTitle(type, row.original)
                  .toLowerCase()
                  .includes(String(needle)),
            },
          ),
        ),
      ]),
    [fields, identifier?.key, titleOf, type],
  )

  const records = page.data?.records
  const loaded = records?.length ?? 0
  const total = page.data?.count ?? 0
  const data = useMemo(() => records ?? [], [records])
  const needle = filter.trim().toLowerCase()
  const table = useAppTable({
    columns: tableColumns,
    data,
    getRowId: (record) => record.id,
    state: {
      sorting: sort ? [{ id: sort.key, desc: sort.descending }] : [],
      columnFilters:
        needle && fields[0] ? [{ id: fields[0].key, value: needle }] : [],
      columnVisibility: Object.fromEntries(
        [...hidden].map((key) => [key, false]),
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
      const held = sort ? [{ id: sort.key, desc: sort.descending }] : []
      const [next] = typeof updater === 'function' ? updater(held) : updater
      setSort(next ? { key: next.id, descending: next.desc } : null)
    },
    onColumnVisibilityChange: (updater) =>
      setHidden((held) => {
        const before = Object.fromEntries([...held].map((key) => [key, false]))
        const after = typeof updater === 'function' ? updater(before) : updater
        return new Set(Object.keys(after).filter((key) => after[key] === false))
      }),
    onRowSelectionChange: (updater) =>
      setSelected((held) => {
        const before = Object.fromEntries(
          [...held].map((id) => [id, true as const]),
        )
        const after = typeof updater === 'function' ? updater(before) : updater
        return new Set(Object.keys(after).filter((id) => after[id]))
      }),
    enableRowSelection: true,
    enableMultiSort: false,
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
  const rows = table.getRowModel().rows.map((row) => row.original)
  const shown = rows.slice(0, limit)
  const previewed = previewId
    ? records?.find((record) => record.id === previewId)
    : undefined

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
  const allSelected =
    shown.length > 0 && shown.every((record) => selected.has(record.id))
  const someSelected = shown.some((record) => selected.has(record.id))
  // The marked records as they are read now; a mark on a record that has
  // gone is not among them.
  const chosen = useMemo(
    () => (records ?? []).filter((record) => selected.has(record.id)),
    [records, selected],
  )
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
      return `Showing the first ${NUMBER.format(loaded)} of ${some(total)}. Filter and sort work on these ${NUMBER.format(loaded)}.`
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
              {selected.size > 0 && access.write && (
                <>
                  <span className="text-xs text-ink-muted tabular-nums">
                    {selected.size} selected
                  </span>
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
                  <span aria-hidden className="mx-1 h-4 w-px bg-separator" />
                </>
              )}
              {filtering || filter ? (
                <span className="flex h-7 items-center gap-1 rounded-md border border-control bg-background ps-2 pe-1 focus-within:outline-2 focus-within:outline-focus">
                  <ListFilter aria-hidden className="size-3.5 text-ink-muted" />
                  <input
                    autoFocus={filtering}
                    value={filter}
                    aria-label={`Filter ${plural.toLowerCase()} by ${identifier?.label.toLowerCase() ?? 'name'}`}
                    placeholder={`${identifier?.label ?? 'Name'} contains`}
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
                    aria-label="Clear filter"
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
                  <ListFilter aria-hidden />
                  Filter
                </Button>
              )}
              <Menu>
                <MenuTrigger
                  render={
                    <Button size="xs" variant="ghost">
                      <ArrowUpDown aria-hidden />
                      {sort
                        ? `Sort: ${type.fields.find((f) => f.key === sort.key)?.label ?? sort.key}`
                        : 'Sort'}
                    </Button>
                  }
                />
                <MenuPopup align="end" className="w-56">
                  <MenuRadioGroup
                    value={sort?.key ?? ''}
                    onValueChange={(key) =>
                      setSort({
                        key: String(key),
                        descending: sort?.descending ?? false,
                      })
                    }
                  >
                    <MenuGroupLabel>Sort by</MenuGroupLabel>
                    {shownFields(type).map((field) => (
                      <MenuRadioItem
                        key={field.key}
                        value={field.key}
                        closeOnClick={false}
                      >
                        {field.label}
                      </MenuRadioItem>
                    ))}
                  </MenuRadioGroup>
                  <MenuSeparator />
                  <MenuRadioGroup
                    value={sort?.descending ? 'descending' : 'ascending'}
                    onValueChange={(direction) =>
                      sort &&
                      setSort({
                        ...sort,
                        descending: direction === 'descending',
                      })
                    }
                  >
                    <MenuRadioItem
                      value="ascending"
                      disabled={!sort}
                      closeOnClick={false}
                    >
                      Ascending
                    </MenuRadioItem>
                    <MenuRadioItem
                      value="descending"
                      disabled={!sort}
                      closeOnClick={false}
                    >
                      Descending
                    </MenuRadioItem>
                  </MenuRadioGroup>
                  <MenuSeparator />
                  <MenuItem disabled={!sort} onClick={() => setSort(null)}>
                    Clear sort
                  </MenuItem>
                </MenuPopup>
              </Menu>
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
                    {shownFields(type).map((field) => (
                      <MenuCheckboxItem
                        key={field.key}
                        closeOnClick={false}
                        disabled={field.key === identifier?.key}
                        checked={!hidden.has(field.key)}
                        onCheckedChange={(checked) =>
                          table.getColumn(field.key)?.toggleVisibility(checked)
                        }
                      >
                        {field.label}
                      </MenuCheckboxItem>
                    ))}
                  </MenuGroup>
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
              aria-colcount={columns.length + 1}
              aria-busy={page.isPending || undefined}
              className="min-h-0 flex-1 overflow-auto text-[13px]"
            >
              <div role="rowgroup" className="sticky top-0 z-20">
                <div
                  role="row"
                  aria-rowindex={1}
                  className="flex border-b border-separator bg-raised"
                  style={{
                    height: HEADER,
                    width: `max(100%, ${totalWidth}px)`,
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
                          checked ? new Set(shown.map((r) => r.id)) : new Set(),
                        )
                      }
                    />
                  </div>
                  {columns.map((field, col) => {
                    const sorted = sort?.key === field.key
                    return (
                      <div
                        key={field.key}
                        role="columnheader"
                        aria-sort={
                          sorted
                            ? sort.descending
                              ? 'descending'
                              : 'ascending'
                            : 'none'
                        }
                        className={cn(
                          'flex shrink-0 items-center border-s border-separator bg-raised',
                          col === 0 && 'sticky z-10 border-s-0',
                        )}
                        style={{
                          width: widthOf(field),
                          left: col === 0 ? CHECK : undefined,
                        }}
                      >
                        <button
                          type="button"
                          title={field.description}
                          onClick={() =>
                            // Ascending, then descending, then unsorted.
                            sorted && sort.descending
                              ? table.getColumn(field.key)?.clearSorting()
                              : table
                                  .getColumn(field.key)
                                  ?.toggleSorting(sorted)
                          }
                          className="flex h-full min-w-0 flex-1 items-center gap-1.5 px-2 text-start text-xs text-ink-muted hover:bg-hover hover:text-ink focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus"
                        >
                          <FieldTypeIcon kind={field.field_type.kind} />
                          <span className="min-w-0 flex-1 truncate">
                            {field.label}
                          </span>
                          {sorted &&
                            (sort.descending ? (
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
                        </button>
                      </div>
                    )
                  })}
                </div>
              </div>

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
                        width: `max(100%, ${totalWidth}px)`,
                      }}
                    >
                      <div
                        role="gridcell"
                        onClick={(event) => event.stopPropagation()}
                        className={cn(
                          'sticky left-0 z-10 flex shrink-0 items-center justify-center',
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
                          onCheckedChange={() => toggleSelected(record.id)}
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
                                        editStyle(field) === 'toggle'
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
                  style={{ height: ROW, width: `max(100%, ${totalWidth}px)` }}
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
      {!bulk && previewed && (
        <RecordPreview
          key={previewed.id}
          type={type}
          record={previewed}
          writes={writes}
          writable={access.write}
          onClose={() => {
            setPreview(undefined)
            step(focus.row, focus.col)
          }}
        />
      )}

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
