// SOURCING: TanStack Table v9 through the app's kit hook (useAppTable: sorting, fuzzy global filter, column filters and faceted counts), coss ui Menu checkbox items for the category filter, the kit's DebouncedInput for search, date-fns for how long ago. The owner's review on 2026-11-14: no heading and no cut-off, newest first, a search button and a filter by common categories.
import { formatDistanceToNowStrict } from 'date-fns'
import { Link } from '@tanstack/react-router'
import { useMemo, useState } from 'react'
import type { ColumnFiltersState, FilterFn } from '@tanstack/react-table'
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
import { DebouncedInput } from '@/components/data-table/debounced-input'
import {
  createAppColumnHelper,
  useAppTable,
} from '@/components/data-table/table-hook'
import { Icon } from '@/components/icons'
import { SessionGlyph } from '@/components/organize/glyphs'
import { Button } from '@/components/ui/button'
import { lastMoved } from '@/lib/theorem/organization'
import type { ThreadEntry } from '@/lib/theorem/organization'
import { typeOf, useSidebarPrefs } from '@/lib/theorem/sidebar-prefs'
import { cn } from '@/lib/utils'

const ago = (atMs: number) =>
  Date.now() - atMs < 60_000
    ? 'just now'
    : `${formatDistanceToNowStrict(atMs)} ago`

type Row = {
  thread: ThreadEntry
  title: string
  detail: string
  type: string
  status: string
  origin: string
  moved: number
}

/** The categories a person filters by, in the order the menu shows them. */
const CATEGORIES = [
  { id: 'type', label: 'Type' },
  { id: 'status', label: 'Status' },
  { id: 'origin', label: 'Origin' },
] as const
type Category = (typeof CATEGORIES)[number]['id']

const ORIGIN_LABEL = {
  none: 'Started here',
  forked: 'Forked',
  continued: 'Continued',
} as const

/** Keeps a row whose value is one of those chosen; none chosen keeps all. */
const oneOf: FilterFn<any, any> = (row, columnId, chosen: unknown) =>
  !Array.isArray(chosen) ||
  chosen.length === 0 ||
  chosen.includes(row.getValue(columnId))

const helper = createAppColumnHelper<Row>()
const columns = helper.columns([
  helper.accessor('title', { id: 'title' }),
  helper.accessor('detail', { id: 'detail' }),
  helper.accessor('type', { id: 'type', filterFn: oneOf }),
  helper.accessor('status', { id: 'status', filterFn: oneOf }),
  helper.accessor('origin', { id: 'origin', filterFn: oneOf }),
  helper.accessor('moved', { id: 'moved', sortFn: 'basic' }),
])

const NEWEST_FIRST = [{ id: 'moved', desc: true }]
const ALL_ROWS = { pageIndex: 0, pageSize: Number.MAX_SAFE_INTEGER }

/** A session in the list: its mark, its name, where it came from, when it last moved. */
function SessionLine({ row }: { row: Row }) {
  const { thread } = row
  return (
    <li>
      <Link
        to="/c/$threadId"
        params={{ threadId: thread.threadId }}
        className="flex min-h-11 items-center gap-3 rounded-lg px-3 py-1.5 hover:bg-hover"
      >
        <SessionGlyph threadId={thread.threadId} className="text-ink-muted" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span data-appearance-recipe="ui.label" className="truncate">
            {row.title}
          </span>
          {row.detail && (
            <span className="truncate text-xs text-ink-muted">
              {row.detail}
            </span>
          )}
        </span>
        {row.status !== 'Idle' && (
          <span className="text-xs text-ink-muted">{row.status}</span>
        )}
        <span className="shrink-0 text-xs text-ink-muted tabular-nums">
          {ago(row.moved)}
        </span>
      </Link>
    </li>
  )
}

/**
 * A project's sessions, newest first, with a search and a filter by type,
 * status and origin.
 */
export function ProjectSessions({
  threads,
  titles,
}: {
  threads: readonly ThreadEntry[]
  titles: ReadonlyMap<string, string>
}) {
  const chosen = useSidebarPrefs((s) => s.sessionTypes)
  const custom = useSidebarPrefs((s) => s.customTypes)
  const [searching, setSearching] = useState(false)
  const [search, setSearch] = useState('')
  const [filters, setFilters] = useState<ColumnFiltersState>([])

  const rows = useMemo(
    () =>
      threads.map((thread): Row => {
        const origin = thread.origin
        const source = origin && titles.get(origin.threadId)
        return {
          thread,
          title: thread.title || 'New chat',
          detail: source
            ? `${origin.kind === 'forked' ? 'Forked from' : 'Continues'} ${source}`
            : (thread.summary?.text ?? ''),
          type: typeOf(thread.threadId, chosen, custom).label,
          status: thread.attention.running
            ? 'Running'
            : thread.attention.reasons.length
              ? 'Needs you'
              : 'Idle',
          origin: ORIGIN_LABEL[origin?.kind ?? 'none'],
          moved: lastMoved(thread),
        }
      }),
    [threads, titles, chosen, custom],
  )

  const table = useAppTable({
    columns,
    data: rows,
    getRowId: (row) => row.thread.threadId,
    state: {
      sorting: NEWEST_FIRST,
      columnFilters: filters,
      globalFilter: search,
      pagination: ALL_ROWS,
    },
    onColumnFiltersChange: (updater) =>
      setFilters((old) =>
        typeof updater === 'function' ? updater(old) : updater,
      ),
    onGlobalFilterChange: (updater) =>
      setSearch((old) =>
        String(typeof updater === 'function' ? updater(old) : updater),
      ),
  })

  const chosenIn = (category: Category): string[] => {
    const value = filters.find((f) => f.id === category)?.value
    return Array.isArray(value) ? value : []
  }
  const toggle = (category: Category, value: string) => {
    const current = chosenIn(category)
    const next = current.includes(value)
      ? current.filter((v) => v !== value)
      : [...current, value]
    setFilters((old) => [
      ...old.filter((f) => f.id !== category),
      ...(next.length ? [{ id: category, value: next }] : []),
    ])
  }
  const activeCount = CATEGORIES.reduce((n, c) => n + chosenIn(c.id).length, 0)
  const narrowed = search !== '' || activeCount > 0
  const matched = table.getRowModel().rows.map((row) => row.original)
  // A category with one value cannot narrow anything, unless it already is.
  const facets = CATEGORIES.flatMap(({ id, label }) => {
    const counts: ReadonlyMap<unknown, number> =
      table.getColumn(id)?.getFacetedUniqueValues() ?? new Map()
    const values = [...counts.keys()].map(String).sort()
    return values.length > 1 || chosenIn(id).length
      ? [{ id, label, values, counts }]
      : []
  })

  if (!threads.length)
    return (
      <p className="text-sm text-ink-muted">
        No sessions yet. Start one above.
      </p>
    )

  return (
    <section aria-label="Sessions" className="flex flex-col gap-2">
      <div className="flex min-h-8 items-center gap-1">
        {searching ? (
          <DebouncedInput
            autoFocus
            value={search}
            onChange={(value) => setSearch(String(value))}
            onKeyDown={(event) => {
              if (event.key !== 'Escape') return
              setSearch('')
              setSearching(false)
            }}
            placeholder="Search sessions"
            aria-label="Search sessions"
            className="h-8 min-w-0 flex-1"
          />
        ) : (
          <Button
            variant="ghost"
            size="sm"
            aria-label="Search sessions"
            onClick={() => setSearching(true)}
            className="text-ink-muted"
          >
            <Icon.Search className="size-4" />
            Search
          </Button>
        )}
        <Menu>
          <MenuTrigger
            render={
              <Button
                variant="ghost"
                size="sm"
                className={cn(
                  'text-ink-muted',
                  activeCount > 0 && 'bg-selected text-ink',
                )}
              />
            }
          >
            <Icon.Filter className="size-4" />
            {activeCount > 0 ? `Filter · ${activeCount}` : 'Filter'}
          </MenuTrigger>
          <MenuPopup align="start" className="min-w-52">
            {facets.map(({ id, label, values, counts }, index) => (
              <MenuGroup key={id}>
                {index > 0 && <MenuSeparator />}
                <MenuGroupLabel>{label}</MenuGroupLabel>
                {values.map((value) => (
                  <MenuCheckboxItem
                    key={value}
                    checked={chosenIn(id).includes(value)}
                    onCheckedChange={() => toggle(id, value)}
                  >
                    <span className="flex items-center gap-2">
                      <span className="flex-1">{value}</span>
                      <span className="text-xs text-ink-muted tabular-nums">
                        {counts.get(value)}
                      </span>
                    </span>
                  </MenuCheckboxItem>
                ))}
              </MenuGroup>
            ))}
            {activeCount > 0 && (
              <>
                <MenuSeparator />
                <MenuItem onClick={() => setFilters([])}>
                  Clear filters
                </MenuItem>
              </>
            )}
          </MenuPopup>
        </Menu>
        {narrowed && (
          <span className="ms-auto text-xs text-ink-muted tabular-nums">
            {matched.length} of {threads.length}
          </span>
        )}
      </div>
      {matched.length ? (
        <ul className="-mx-3 flex flex-col">
          {matched.map((row) => (
            <SessionLine key={row.thread.threadId} row={row} />
          ))}
        </ul>
      ) : (
        <p className="px-3 py-2 text-sm text-ink-muted">No sessions match.</p>
      )}
    </section>
  )
}
