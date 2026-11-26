// SOURCING: zustand + zustand/middleware persist (per-browser view preferences, as components/shell/shell-state keeps the shell's); the rules are the unified agent spec's WS-02 (insertion order, manual order persists, events never reorder or reselect), WS-05 (finished work stays until removed or the scope changes), DR-02 (project scope first, All work explicit) and DR-03 (compression never overwrites the saved arrangement), docs/plans/theo-workbench/SPEC-UNIFIED-AGENT-EXPERIENCE-1.0.md §3.
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { ActivityEntry } from './projection'

export type ActivityScope = 'project' | 'all'
export type DrawerPlacement = 'bottom' | 'right'

/** One row the view keeps: the owner's latest entry, and whether the owner still lists it. */
export interface ArrangedItem {
  entry: ActivityEntry
  /** False once the owner stops listing it: the row stays, saying so, until the person removes it. */
  listed: boolean
}

export interface Arranged {
  projectId: string
  scope: ActivityScope
  order: string[]
  items: Record<string, ArrangedItem>
  /** Rows the person removed, with the run they showed then: the same work does not come back. */
  removed: Record<string, string>
}

/** Work the page's own workspace owns carries no project; it belongs to the project shown now. */
export const inScope = (
  entry: ActivityEntry,
  scope: ActivityScope,
  projectId: string,
) => scope === 'all' || !entry.projects || entry.projects.includes(projectId)

/**
 * What a removal remembers about the work. A run's id where the owner gives one; otherwise its state,
 * so a terminal or side chat with no run comes back once its state changes or it leaves and returns.
 */
const runOf = (entry: ActivityEntry) => entry.runId ?? `~${entry.execution}`
/** A removed row whose run-less work stopped being listed: anything listed under that key later is new. */
const LEFT = '~left'

/**
 * The rows to show after the owners' latest listing. Rows keep their places; new work joins at the
 * end in the listing's order; a row the owners stop listing stays, marked, so finished work is not
 * erased. A change of project or scope starts again from the listing, keeping a saved manual order
 * where its keys still appear.
 */
export function arrange(
  previous: Pick<Arranged, 'projectId' | 'scope' | 'order' | 'removed'> &
    Partial<Pick<Arranged, 'items'>>,
  entries: ActivityEntry[],
  { projectId, scope }: { projectId: string; scope: ActivityScope },
): Arranged {
  const same = previous.projectId === projectId && previous.scope === scope
  const removed = same ? { ...previous.removed } : {}
  const current = new Map<string, ActivityEntry>()
  const listedKeys = new Set(entries.map((entry) => entry.key))
  for (const [key, marker] of Object.entries(removed))
    if (!listedKeys.has(key) && marker.startsWith('~')) removed[key] = LEFT
  for (const entry of entries) {
    if (!inScope(entry, scope, projectId)) continue
    const gone = removed[entry.key]
    if (gone !== undefined) {
      // New work on the same resource (a new run) comes back; the same run stays removed.
      if (gone === runOf(entry)) continue
      delete removed[entry.key]
    }
    current.set(entry.key, entry)
  }
  const kept = same ? (previous.items ?? {}) : {}
  const order: string[] = []
  const items: Record<string, ArrangedItem> = {}
  for (const key of same ? previous.order : []) {
    const entry = current.get(key)
    if (entry) items[key] = { entry, listed: true }
    else if (kept[key]) items[key] = { entry: kept[key].entry, listed: false }
    else continue
    order.push(key)
  }
  for (const [key, entry] of current) {
    if (items[key]) continue
    items[key] = { entry, listed: true }
    order.push(key)
  }
  return { projectId, scope, order, items, removed }
}

/** Takes a row out of this arrangement. The work itself is untouched. */
export function removeFrom(arranged: Arranged, key: string): Arranged {
  const item = arranged.items[key]
  if (!item) return arranged
  const items = { ...arranged.items }
  delete items[key]
  return {
    ...arranged,
    order: arranged.order.filter((k) => k !== key),
    items,
    removed: { ...arranged.removed, [key]: runOf(item.entry) },
  }
}

/** Moves a row by `by` places, within the list. */
export function moveIn(arranged: Arranged, key: string, by: number): Arranged {
  const from = arranged.order.indexOf(key)
  if (from < 0) return arranged
  const to = Math.max(0, Math.min(arranged.order.length - 1, from + by))
  if (to === from) return arranged
  const order = [...arranged.order]
  order.splice(from, 1)
  order.splice(to, 0, key)
  return { ...arranged, order }
}

/** Below this width a right drawer shows at the bottom for now; the saved placement stays right. */
export const RIGHT_MIN_WIDTH = 720
export const SIZE = {
  bottom: { min: 160, initial: 320 },
  right: { min: 280, initial: 420 },
} as const

/** The presentation the container allows now, leaving the saved choice as it is (DR-03, UI-04). */
export function effectivePlacement(
  placement: DrawerPlacement,
  containerWidth: number,
): DrawerPlacement {
  return placement === 'right' && containerWidth < RIGHT_MIN_WIDTH
    ? 'bottom'
    : placement
}

/** A saved size within what the container has room for now, without changing what is saved. */
export function effectiveSize(
  placement: DrawerPlacement,
  saved: number,
  room: number,
) {
  const { min } = SIZE[placement]
  return Math.max(Math.min(min, room), Math.min(saved, room))
}

const savedKey = (projectId: string, scope: ActivityScope) =>
  `${projectId}\u0000${scope}`
/** How many project and scope arrangements the browser keeps. */
const SAVED_LIMIT = 24

interface ActivityViewState {
  open: boolean
  /** Shown as the full agent workspace rather than as a drawer. */
  expanded: boolean
  placement: DrawerPlacement
  size: Record<DrawerPlacement, number>
  scope: ActivityScope
  /** The row the person chose. Owner events never set it. */
  selected: string | null
  arranged?: Arranged
  /** Manual order and removals, per project and scope, kept across reloads. */
  saved: Record<string, { order: string[]; removed: Record<string, string> }>
  /** The control focus returns to when the view closes. Not persisted. */
  origin: HTMLElement | null
  openView: (options?: { origin?: HTMLElement | null; select?: string }) => void
  close: () => void
  setExpanded: (expanded: boolean) => void
  setPlacement: (placement: DrawerPlacement) => void
  setSize: (placement: DrawerPlacement, size: number) => void
  setScope: (scope: ActivityScope) => void
  select: (key: string | null) => void
  sync: (entries: ActivityEntry[], projectId: string) => void
  remove: (key: string) => void
  move: (key: string, by: number) => void
}

const remember = (
  saved: ActivityViewState['saved'],
  arranged: Arranged,
): ActivityViewState['saved'] => {
  const key = savedKey(arranged.projectId, arranged.scope)
  const next = { ...saved }
  delete next[key]
  next[key] = { order: arranged.order, removed: arranged.removed }
  const keys = Object.keys(next)
  for (const old of keys.slice(0, Math.max(0, keys.length - SAVED_LIMIT)))
    delete next[old]
  return next
}

export const useActivityView = create<ActivityViewState>()(
  persist(
    (set, get) => ({
      open: false,
      expanded: false,
      placement: 'bottom',
      size: { bottom: SIZE.bottom.initial, right: SIZE.right.initial },
      scope: 'project',
      selected: null,
      saved: {},
      origin: null,
      openView: ({ origin, select } = {}) =>
        set((state) => ({
          open: true,
          origin:
            origin === undefined
              ? (state.origin ??
                (document.activeElement instanceof HTMLElement
                  ? document.activeElement
                  : null))
              : origin,
          ...(select ? { selected: select } : {}),
        })),
      close: () => {
        const { origin } = get()
        set({ open: false, expanded: false, origin: null })
        if (origin?.isConnected) origin.focus({ preventScroll: true })
        // An opener inside the compact preview was unmounted with it: focus its remounted
        // counterpart once it renders again.
        else if (origin)
          requestAnimationFrame(() =>
            document
              .querySelector<HTMLElement>('[data-activity-return]')
              ?.focus({ preventScroll: true }),
          )
      },
      setExpanded: (expanded) => set({ expanded }),
      setPlacement: (placement) => set({ placement }),
      setSize: (placement, size) =>
        set((state) => ({
          size: {
            ...state.size,
            [placement]: Math.max(SIZE[placement].min, Math.round(size)),
          },
        })),
      setScope: (scope) => set({ scope }),
      select: (selected) => set({ selected }),
      sync: (entries, projectId) =>
        set((state) => {
          const { scope } = state
          const previous =
            state.arranged &&
            state.arranged.projectId === projectId &&
            state.arranged.scope === scope
              ? state.arranged
              : {
                  projectId,
                  scope,
                  ...(state.saved[savedKey(projectId, scope)] ?? {
                    order: [],
                    removed: {},
                  }),
                }
          const arranged = arrange(previous, entries, { projectId, scope })
          return { arranged }
        }),
      remove: (key) =>
        set((state) => {
          if (!state.arranged) return {}
          const arranged = removeFrom(state.arranged, key)
          return {
            arranged,
            saved: remember(state.saved, arranged),
            selected: state.selected === key ? null : state.selected,
          }
        }),
      move: (key, by) =>
        set((state) => {
          if (!state.arranged) return {}
          const arranged = moveIn(state.arranged, key, by)
          return { arranged, saved: remember(state.saved, arranged) }
        }),
    }),
    {
      name: 'theorem.activity-view',
      version: 1,
      partialize: (state) => ({
        placement: state.placement,
        size: state.size,
        scope: state.scope,
        saved: state.saved,
      }),
    },
  ),
)
