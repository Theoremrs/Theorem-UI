// SOURCING: @tanstack/react-table v9 through the vendored TanStack Table kitchen-sink-shadcn-base data table (components/data-table: createTableHook, filter, sort and view lists, pagination, resizing); lib/theorem/models for the model shape and formatContext; Intl.NumberFormat for prices and counts; ./models-search for the catalog's own contiguous search and natural name order; ./model-details for the right-side identity panel
import * as React from 'react'
import type { Column, FilterFn, SortFn } from '@tanstack/react-table'
import type { ExtendedColumnFilter } from '@/types/data-table'
import type { features } from '@/components/data-table/features'
import { DebouncedInput } from '@/components/data-table/debounced-input'
import {
  createAppColumnHelper,
  useAppTable,
  useCellContext,
} from '@/components/data-table/table-hook'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/data-table/ui/table'
import { Badge } from '@/components/coss/badge'
import { Icon } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { formatContext } from '@/lib/theorem/models'
import type { ModelOption } from '@/lib/theorem/models'
import { cn } from '@/lib/utils'
import {
  compareModelNames,
  matchesModelQuery,
  matchesModelTextFilter,
  pageIndexAfterFilters,
  pageIndexForRows,
} from './models-search'
import { ModelDetails } from './model-details'

/** A model as the table holds it: the option plus the person's marks on it. */
type ModelRow = ModelOption & { starred: boolean; inUse: boolean }

const ToggleStarContext = React.createContext<(ref: string) => void>(() => {})
const InspectContext = React.createContext<
  (ref: string, trigger: HTMLElement) => void
>(() => {})

const MODALITY_LABELS: Record<string, string> = {
  text: 'Text',
  image: 'Image',
  file: 'File',
  audio: 'Audio',
  video: 'Video',
}
const modalityLabel = (value: string) =>
  MODALITY_LABELS[value] ?? value.charAt(0).toUpperCase() + value.slice(1)

const SOURCE_LABELS: Record<ModelOption['source'], string> = {
  catalog: 'Configured catalog',
  openrouter: 'OpenRouter',
}

const usd = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumSignificantDigits: 3,
})

const Faint = ({ children = '–' }: { children?: React.ReactNode }) => (
  <span className="text-ink-faint">{children}</span>
)

function StarCell() {
  const cell = useCellContext<boolean>()
  const toggle = React.useContext(ToggleStarContext)
  const model = cell.row.original as ModelRow
  const starred = cell.getValue()
  return (
    <Button
      variant="ghost"
      size="icon-xs"
      aria-pressed={starred}
      aria-label={starred ? `Unstar ${model.name}` : `Star ${model.name}`}
      onClick={() => toggle(model.ref)}
      className={cn(starred ? 'text-redwood' : 'text-ink-faint hover:text-ink')}
    >
      <Icon.Star className={cn('size-3.5', starred && 'fill-current')} />
    </Button>
  )
}

function ModelCell() {
  const cell = useCellContext<string>()
  const model = cell.row.original as ModelRow
  const inspect = React.useContext(InspectContext)
  const trigger = React.useRef<HTMLButtonElement>(null)
  return (
    <button
      ref={trigger}
      type="button"
      className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
      aria-label={`Details for ${model.name}, ${model.ref}`}
      onClick={() => inspect(model.ref, trigger.current!)}
    >
      <span className="truncate text-ink" data-model-name title={model.name}>
        {model.name}
      </span>
      {model.inUse && (
        <Badge
          size="sm"
          className="shrink-0 border-transparent bg-redwood-container text-redwood-ink"
        >
          In use
        </Badge>
      )}
    </button>
  )
}

function TokensCell() {
  const value = useCellContext<number | undefined>().getValue()
  return value === undefined ? <Faint /> : <>{formatContext(value)}</>
}

function PriceCell() {
  const value = useCellContext<number | undefined>().getValue()
  if (value === undefined) return <Faint />
  return value === 0 ? <>Free</> : <>{usd.format(value)}</>
}

function InputsCell() {
  const inputs = useCellContext<readonly string[]>().getValue()
  const full = inputs.map(modalityLabel).join(', ')
  return (
    <span
      className="truncate text-ink-muted"
      data-model-inputs
      title={full || undefined}
      aria-label={full || undefined}
    >
      {full}
    </span>
  )
}

function BooleanCell() {
  const value = useCellContext<boolean>().getValue()
  return value ? <>Yes</> : <Faint>No</Faint>
}

function SourceCell() {
  const value = useCellContext<ModelOption['source']>().getValue()
  return <span className="text-ink-muted">{SOURCE_LABELS[value]}</span>
}

const columnHelper = createAppColumnHelper<ModelRow>()

/** Natural A-Z on the display name; vendor and ref break identical-name ties. */
const nameSort: SortFn<typeof features, ModelRow> = (first, second) =>
  compareModelNames(first.original, second.original)

/**
 * The catalog's global search: contiguous, case-insensitive, trimmed text in
 * the name, canonical ref or vendor as separate fields. It reads the row, not
 * the column value, so the hidden ref never widens a name match.
 */
const modelGlobalFilter: FilterFn<typeof features, ModelRow> = (
  row,
  _columnId,
  value,
) => matchesModelQuery(row.original, String(value ?? ''))

/**
 * The Model column's text filter: the same operators and joins the filter
 * list offers, with both sides compared case-insensitively (the shared
 * dynamic filter compares a raw value against case-folded comparators).
 */
const modelTextFilter: FilterFn<typeof features, ModelRow> = (row, columnId) =>
  matchesModelTextFilter(
    String(row.getValue(columnId) ?? ''),
    (row.table.store.state.columnFilters as Array<ExtendedColumnFilter>).filter(
      (filter) => filter.id === columnId,
    ),
  )

/** Options with how many models carry each, for the filter list's facets. */
function countOptions(
  values: Iterable<string>,
  label: (value: string) => string,
) {
  const counts = new Map<string, number>()
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1)
  return [...counts]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([value, count]) => ({ value, label: label(value), count }))
}

function modelColumns(models: readonly ModelOption[]) {
  const numeric = {
    sortUndefined: 'last' as const,
    enableGlobalFilter: false,
    size: 92,
  }
  const numericHeader = 'flex w-full justify-end'
  return columnHelper.columns([
    columnHelper.accessor('starred', {
      id: 'starred',
      header: () => (
        <span className="flex w-full justify-center" aria-label="Starred">
          <Icon.Star className="size-3.5" />
        </span>
      ),
      cell: () => <StarCell />,
      sortFn: 'basic',
      sortDescFirst: true,
      enableHiding: false,
      enableResizing: false,
      enableGlobalFilter: false,
      size: 40,
      meta: { label: 'Starred', variant: 'boolean' },
    }),
    // The visible display name alone: the hidden ref must not steer the
    // order, and the catalog's own global filter reads name, ref and vendor
    // as separate fields.
    columnHelper.accessor('name', {
      id: 'name',
      header: ({ header }) => <header.ColumnHeader />,
      cell: () => <ModelCell />,
      sortFn: nameSort,
      filterFn: modelTextFilter,
      enableHiding: false,
      size: 240,
      minSize: 160,
      meta: { label: 'Model', variant: 'text' },
    }),
    columnHelper.accessor('vendor', {
      id: 'vendor',
      header: ({ header }) => <header.ColumnHeader />,
      cell: ({ cell }) => <cell.TextCell />,
      enableGlobalFilter: false,
      size: 112,
      meta: { label: 'Vendor', variant: 'multi-select' },
    }),
    columnHelper.accessor('contextLength', {
      id: 'contextLength',
      ...numeric,
      header: ({ header }) => <header.ColumnHeader className={numericHeader} />,
      cell: () => <TokensCell />,
      size: 148,
      meta: { label: 'Context (tokens)', variant: 'number' },
    }),
    columnHelper.accessor('maxOutput', {
      id: 'maxOutput',
      ...numeric,
      header: ({ header }) => <header.ColumnHeader className={numericHeader} />,
      cell: () => <TokensCell />,
      size: 172,
      meta: { label: 'Max output (tokens)', variant: 'number' },
    }),
    columnHelper.accessor('promptPrice', {
      id: 'promptPrice',
      ...numeric,
      header: ({ header }) => <header.ColumnHeader className={numericHeader} />,
      cell: () => <PriceCell />,
      size: 108,
      meta: { label: 'Input $/M', variant: 'number' },
    }),
    columnHelper.accessor('completionPrice', {
      id: 'completionPrice',
      ...numeric,
      header: ({ header }) => <header.ColumnHeader className={numericHeader} />,
      cell: () => <PriceCell />,
      size: 116,
      meta: { label: 'Output $/M', variant: 'number' },
    }),
    columnHelper.accessor('inputs', {
      id: 'inputs',
      header: ({ header }) => <header.ColumnHeader />,
      cell: () => <InputsCell />,
      getUniqueValues: (row) => [...row.inputs],
      enableSorting: false,
      enableGlobalFilter: false,
      size: 150,
      meta: {
        label: 'Inputs',
        variant: 'multi-select',
        options: countOptions(
          models.flatMap((m) => m.inputs),
          modalityLabel,
        ),
      },
    }),
    columnHelper.accessor('tools', {
      id: 'tools',
      header: ({ header }) => <header.ColumnHeader />,
      cell: () => <BooleanCell />,
      sortFn: 'basic',
      sortDescFirst: true,
      enableGlobalFilter: false,
      size: 120,
      meta: { label: 'Native tools', variant: 'boolean' },
    }),
    columnHelper.accessor('reasoning', {
      id: 'reasoning',
      header: ({ header }) => <header.ColumnHeader />,
      cell: () => <BooleanCell />,
      sortFn: 'basic',
      sortDescFirst: true,
      enableGlobalFilter: false,
      size: 112,
      meta: { label: 'Reasoning', variant: 'boolean' },
    }),
    columnHelper.accessor(
      (row) =>
        row.addedAtMs === undefined ? undefined : new Date(row.addedAtMs),
      {
        id: 'addedAt',
        header: ({ header }) => <header.ColumnHeader />,
        cell: ({ cell }) => <cell.DateCell />,
        sortFn: 'datetime',
        sortUndefined: 'last',
        enableGlobalFilter: false,
        size: 112,
        meta: { label: 'Added', variant: 'date' },
      },
    ),
    columnHelper.accessor('source', {
      id: 'source',
      header: ({ header }) => <header.ColumnHeader />,
      cell: () => <SourceCell />,
      enableGlobalFilter: false,
      size: 128,
      meta: {
        label: 'Source',
        variant: 'select',
        options: countOptions(
          models.map((m) => m.source),
          (value) => SOURCE_LABELS[value as ModelOption['source']],
        ),
      },
    }),
  ])
}

/** Sticky placement for a pinned column, as the kitchen sink's example computes it. */
function pinningStyles(
  column: Column<typeof features, ModelRow>,
): React.CSSProperties {
  const isPinned = column.getIsPinned()
  const isLastStart = isPinned === 'start' && column.getIsLastColumn('start')
  const isFirstEnd = isPinned === 'end' && column.getIsFirstColumn('end')
  return {
    boxShadow: isLastStart
      ? '-1px 0 0 0 var(--line-separator) inset'
      : isFirstEnd
        ? '1px 0 0 0 var(--line-separator) inset'
        : undefined,
    insetInlineStart:
      isPinned === 'start' ? `${column.getStart('start')}px` : undefined,
    insetInlineEnd:
      isPinned === 'end' ? `${column.getAfter('end')}px` : undefined,
    position: isPinned ? 'sticky' : 'relative',
    zIndex: isPinned ? 1 : 0,
  }
}

export function ModelsTable({
  models,
  starred,
  onToggleStar,
  selected,
}: {
  models: readonly ModelOption[]
  /** Model refs. */
  starred: readonly string[]
  onToggleStar: (ref: string) => void
  /** The picked model ref, marked "In use". */
  selected: string | undefined
}): React.JSX.Element {
  const [columnFilters, setColumnFilters] = React.useState<
    Array<ExtendedColumnFilter>
  >([])
  const [globalFilter, setGlobalFilter] = React.useState('')
  const [pageIndex, setPageIndex] = React.useState(0)
  const [pageSize, setPageSize] = React.useState(50)
  const [inspected, setInspected] = React.useState<string | undefined>()
  const detailsTrigger = React.useRef<HTMLElement | null>(null)

  const data = React.useMemo(() => {
    const stars = new Set(starred)
    return models.map((model): ModelRow => ({
      ...model,
      starred: stars.has(model.ref),
      inUse: model.ref === selected,
    }))
  }, [models, starred, selected])

  const columns = React.useMemo(() => modelColumns(models), [models])

  // A query or column-filter change returns to page one; starring, which
  // changes only the marks on the rows, never moves the page.
  const search = React.useCallback((value: string) => {
    setGlobalFilter(value)
    setPageIndex(pageIndexAfterFilters())
  }, [])
  const filterColumns = React.useCallback(
    (updater: React.SetStateAction<Array<ExtendedColumnFilter>>) => {
      setColumnFilters(updater)
      setPageIndex(pageIndexAfterFilters())
    },
    [],
  )

  const table = useAppTable(
    {
      columns,
      data,
      getRowId: (row) => row.ref,
      state: {
        columnFilters,
        globalFilter,
        pagination: { pageIndex, pageSize },
      },
      onColumnFiltersChange: filterColumns,
      onGlobalFilterChange: (updater) =>
        search(typeof updater === 'function' ? updater(globalFilter) : updater),
      onPaginationChange: (updater) => {
        const next =
          typeof updater === 'function'
            ? updater({ pageIndex, pageSize })
            : updater
        setPageIndex(next.pageIndex)
        setPageSize(next.pageSize)
      },
      globalFilterFn: modelGlobalFilter,
      // The page resets deliberately on query/filter changes above, and
      // clamps below; a star must not reset it.
      autoResetPageIndex: false,
      initialState: {
        sorting: [{ id: 'name', desc: false }],
        columnVisibility: { maxOutput: false, source: false, addedAt: false },
        columnPinning: { start: ['starred', 'name'], end: [] },
        columnOrder: columns.map((c) => c.id ?? ''),
      },
    },
    (state) => state,
  )

  const rowCount = table.getFilteredRowModel().rows.length
  // A catalog refresh can shrink the list under the current page: hold the
  // page while it exists, clamp to the last page when it does not. Adjusting
  // state during render is React's documented pattern for derived corrections.
  const [previousRowCount, setPreviousRowCount] = React.useState(rowCount)
  if (previousRowCount !== rowCount) {
    setPreviousRowCount(rowCount)
    const clamped = pageIndexForRows(pageIndex, rowCount, pageSize)
    if (clamped !== pageIndex) setPageIndex(clamped)
  }

  const inspectedModel = inspected
    ? data.find((model) => model.ref === inspected)
    : undefined
  const inspect = React.useCallback((ref: string, trigger: HTMLElement) => {
    detailsTrigger.current = trigger
    setInspected(ref)
  }, [])

  const pinnedCell = (pinned: false | 'start' | 'end') =>
    pinned ? 'bg-raised group-hover/row:bg-hover' : undefined

  return (
    <ToggleStarContext.Provider value={onToggleStar}>
      <InspectContext.Provider value={inspect}>
        <table.AppTable>
          <div className="flex min-w-0 flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative min-w-40 flex-1">
                <Icon.Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-ink-faint" />
                <DebouncedInput
                  value={globalFilter}
                  onChange={(value) => search(String(value))}
                  placeholder="Search models..."
                  aria-label="Search models"
                  className="h-7 pl-8 text-sm"
                />
              </div>
              <table.FilterList />
              <table.SortList />
              <table.ViewOptions />
            </div>
            <div className="overflow-hidden rounded-lg border border-separator bg-raised">
              <Table
                containerClassName="max-h-[min(70vh,44rem)] overflow-auto"
                style={{ width: table.getTotalSize(), minWidth: '100%' }}
              >
                <TableHeader className="sticky top-0 z-20 bg-raised [&_tr]:border-separator">
                  {table.getHeaderGroups().map((headerGroup) => (
                    <TableRow
                      key={headerGroup.id}
                      className="hover:bg-transparent"
                    >
                      {headerGroup.headers
                        .filter((header) => header.column.getIsVisible())
                        .map((header) => (
                          <table.AppHeader header={header} key={header.id}>
                            {(h) => (
                              <TableHead
                                colSpan={h.colSpan}
                                className={cn(
                                  'relative h-9',
                                  h.column.id === 'starred' && 'px-0',
                                  [
                                    'contextLength',
                                    'maxOutput',
                                    'promptPrice',
                                    'completionPrice',
                                  ].includes(h.column.id) && 'justify-end',
                                  h.column.getIsPinned() && 'bg-raised',
                                )}
                                style={{
                                  flexGrow: h.getSize(),
                                  width: h.getSize(),
                                  ...pinningStyles(h.column),
                                }}
                              >
                                {h.isPlaceholder ? null : <h.FlexRender />}
                                <h.ResizeHandle />
                              </TableHead>
                            )}
                          </table.AppHeader>
                        ))}
                    </TableRow>
                  ))}
                </TableHeader>
                <TableBody>
                  {table.getRowModel().rows.length ? (
                    table.getRowModel().rows.map((row) => (
                      <TableRow
                        key={row.id}
                        className="group/row border-separator"
                        data-in-use={row.original.inUse ? '' : undefined}
                      >
                        {row.getVisibleCells().map((cell) => (
                          <table.AppCell cell={cell} key={cell.id}>
                            {(c) => (
                              <TableCell
                                className={cn(
                                  'py-1.5 text-sm text-ink',
                                  c.column.id === 'starred' &&
                                    'justify-center px-0',
                                  [
                                    'contextLength',
                                    'maxOutput',
                                    'promptPrice',
                                    'completionPrice',
                                  ].includes(c.column.id) &&
                                    'justify-end tabular-nums',
                                  pinnedCell(c.column.getIsPinned()),
                                )}
                                style={{
                                  flexGrow: c.column.getSize(),
                                  width: c.column.getSize(),
                                  ...pinningStyles(c.column),
                                }}
                              >
                                <c.FlexRender />
                              </TableCell>
                            )}
                          </table.AppCell>
                        ))}
                      </TableRow>
                    ))
                  ) : (
                    <TableRow className="hover:bg-transparent">
                      <TableCell className="w-full justify-center py-8 text-sm text-ink-muted">
                        No model matches.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
            <table.Pagination pageSizeOptions={[25, 50, 100]} noun="model" />
          </div>
        </table.AppTable>
      </InspectContext.Provider>
      <ModelDetails
        model={inspectedModel}
        starred={inspectedModel?.starred ?? false}
        inUse={inspectedModel?.inUse ?? false}
        onClose={() => setInspected(undefined)}
        returnFocusTo={detailsTrigger}
      />
    </ToggleStarContext.Provider>
  )
}
