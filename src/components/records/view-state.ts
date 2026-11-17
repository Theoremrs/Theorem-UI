// SOURCING: zustand + zustand/middleware persist (a record view's arrangement, kept as lib/theorem/generation keeps the response defaults), synced with the person's Theorem preferences as `recordLayouts` by lib/theorem/models; a layout is the person's own arrangement (column order, widths, visibility and footer calculations) per view, held in this browser first and following the person through Theorem. Every read and write tolerates storage being unavailable, and only a change the person makes is saved. Filter text, sort and the previewed record are not here: the CRM table keeps those in the address
import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react'
import type { SetStateAction } from 'react'
import type {
  ColumnOrderState,
  ColumnSizingState,
  ColumnVisibilityState,
} from '@tanstack/react-table'
import type { AggregateOp } from './aggregate'
import { AGGREGATE_LABEL } from './aggregate'
import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'

export type RecordViewState = {
  columnOrder: ColumnOrderState
  columnSizing: ColumnSizingState
  columnVisibility: ColumnVisibilityState
  aggregates: Record<string, AggregateOp>
}

/**
 * Keys are `theorem.crm.view:<view>:<type>`, where <view> is the Index view
 * the table is drawn in (`default:records:person`, a custom view's id, or a
 * page module's own id). The older `theorem.records.view:` keys belonged to
 * the generic table that held filters and sorts too; they are left alone.
 */
export const STORAGE_PREFIX = 'theorem.crm.view:'

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Only what has the right shape is taken; a hand-edited or older entry cannot break the table. */
function sanitize(raw: unknown): Partial<RecordViewState> {
  if (!isObject(raw)) return {}
  const saved: Partial<RecordViewState> = {}
  if (
    Array.isArray(raw.columnOrder) &&
    raw.columnOrder.every((id) => typeof id === 'string')
  )
    saved.columnOrder = raw.columnOrder
  if (isObject(raw.columnSizing))
    saved.columnSizing = Object.fromEntries(
      Object.entries(raw.columnSizing).filter(
        ([, width]) => typeof width === 'number' && Number.isFinite(width),
      ),
    ) as ColumnSizingState
  if (isObject(raw.columnVisibility))
    saved.columnVisibility = Object.fromEntries(
      Object.entries(raw.columnVisibility).filter(
        ([, shown]) => typeof shown === 'boolean',
      ),
    ) as ColumnVisibilityState
  if (isObject(raw.aggregates))
    saved.aggregates = Object.fromEntries(
      Object.entries(raw.aggregates).filter(
        ([, op]) => typeof op === 'string' && op in AGGREGATE_LABEL,
      ),
    ) as Record<string, AggregateOp>
  return saved
}

/** One saved arrangement and when (ms) the person last changed it. Fields the person never set stay absent so the program's own `fields` fill them. */
export type SavedLayout = Partial<RecordViewState> & { at: number }

/** The most layouts kept on Theorem, newest first, so the preferences object stays far under its 64 KiB cap. */
export const MAX_SYNCED_LAYOUTS = 50
/** What the synced layouts may take of the preferences object's 64 KiB. */
export const MAX_SYNCED_BYTES = 32_000

/** Layouts read from storage or from Theorem: only well-shaped entries with a time and something arranged survive. */
export function readLayouts(value: unknown): Record<string, SavedLayout> {
  if (!isObject(value)) return {}
  const layouts: Record<string, SavedLayout> = {}
  for (const [key, raw] of Object.entries(value)) {
    if (
      !isObject(raw) ||
      typeof raw.at !== 'number' ||
      !Number.isFinite(raw.at)
    )
      continue
    const saved = sanitize(raw)
    if (Object.keys(saved).length) layouts[key] = { ...saved, at: raw.at }
  }
  return layouts
}

/** The layouts to hold after Theorem's copy arrives: its map wins when it carries one, else this browser's stands. */
export function mergeLayouts(
  local: Record<string, SavedLayout>,
  served: unknown,
): Record<string, SavedLayout> {
  return isObject(served) ? readLayouts(served) : local
}

/** The `max` most recently changed layouts. */
export function trimLayouts(
  layouts: Record<string, SavedLayout>,
  max = MAX_SYNCED_LAYOUTS,
  maxBytes = MAX_SYNCED_BYTES,
): Record<string, SavedLayout> {
  const newest = Object.entries(layouts)
    .sort(([, a], [, b]) => b.at - a.at)
    .slice(0, max)
  // Theorem refuses a preferences object over 64 KiB, and the refusal would
  // stop the models from syncing too, so the oldest layouts give way first.
  let bytes = 2
  const kept: [string, SavedLayout][] = []
  for (const entry of newest) {
    bytes += JSON.stringify(entry).length + 1
    if (bytes > maxBytes) break
    kept.push(entry)
  }
  return Object.fromEntries(kept)
}

type LayoutsState = { layouts: Record<string, SavedLayout> }

/** Storage that never throws: a private window or full storage keeps layouts for this visit only. */
const safeStorage = createJSONStorage<{ layouts: Record<string, SavedLayout> }>(
  () => ({
    getItem: (name) => {
      try {
        return window.localStorage.getItem(name)
      } catch {
        return null
      }
    },
    setItem: (name, value) => {
      try {
        window.localStorage.setItem(name, value)
      } catch {
        // Kept for this visit only.
      }
    },
    removeItem: (name) => {
      try {
        window.localStorage.removeItem(name)
      } catch {
        // Nothing saved to remove.
      }
    },
  }),
)

/** Every arrangement the person has made, by view key; the preferences sync carries it to Theorem. */
export const useRecordLayouts = create<LayoutsState>()(
  persist(() => ({ layouts: {} }), {
    name: 'theorem-ui:record-layouts',
    storage: safeStorage,
    partialize: ({ layouts }) => ({ layouts }),
    merge: (persisted, current) => ({
      ...current,
      layouts: readLayouts(
        (persisted as Partial<LayoutsState> | undefined)?.layouts,
      ),
    }),
  }),
)

/** The pre-store arrangement kept under `theorem.crm.view:<key>`, still read until the view is next changed. */
function readLegacy(key: string): Partial<RecordViewState> {
  try {
    const raw = window.localStorage.getItem(STORAGE_PREFIX + key)
    return raw ? sanitize(JSON.parse(raw)) : {}
  } catch {
    return {}
  }
}

function forgetLegacy(key: string) {
  try {
    window.localStorage.removeItem(STORAGE_PREFIX + key)
  } catch {
    // Nothing saved to remove.
  }
}

function withoutTime({
  at: _at,
  ...saved
}: SavedLayout): Partial<RecordViewState> {
  return saved
}

/**
 * The arrangement for `key`, starting from `initial` for anything not saved.
 * Nothing is written until the arrangement is changed, so a view nobody has
 * rearranged keeps following its program's `fields`; `reset` forgets it. A
 * saved arrangement follows the person through Theorem's preferences, and a
 * layout from before the store existed is read once from its old key.
 */
export function useRecordViewState(
  key: string,
  initial: () => RecordViewState,
) {
  const saved = useRecordLayouts((now) => now.layouts[key])
  // A reset of a view that only has the old entry changes nothing in the store.
  const [forgotten, forgot] = useReducer((n: number) => n + 1, 0)
  const state = useMemo<RecordViewState>(
    () => ({
      ...initial(),
      ...(saved ? withoutTime(saved) : readLegacy(key)),
    }),
    // `initial` is the program's fields at this moment; only a saved change or another view reloads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key, saved, forgotten],
  )
  // A saved layout supersedes any old entry, so a reset made elsewhere
  // cannot fall back to it.
  useEffect(() => {
    if (saved) forgetLegacy(key)
  }, [key, saved])
  const program = useRef(initial)
  useEffect(() => {
    program.current = initial
  })
  const setState = useCallback(
    (next: SetStateAction<RecordViewState>) => {
      // Read at the moment of the change, so two changes before a render both land.
      const held = useRecordLayouts.getState().layouts[key]
      const now: RecordViewState = {
        ...program.current(),
        ...(held ? withoutTime(held) : readLegacy(key)),
      }
      const value = typeof next === 'function' ? next(now) : next
      useRecordLayouts.setState((all) => ({
        layouts: { ...all.layouts, [key]: { ...value, at: Date.now() } },
      }))
      // Its values now live in the store; left behind, the old entry would
      // come back when Theorem's copy of this view is reset.
      forgetLegacy(key)
    },
    [key],
  )
  const reset = () => {
    forgetLegacy(key)
    useRecordLayouts.setState((now) => {
      const { [key]: _gone, ...rest } = now.layouts
      return { layouts: rest }
    })
    forgot()
  }
  return [state, setState, reset] as const
}
