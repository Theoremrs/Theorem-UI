// SOURCING: none — a record view's arrangement (column order, widths, visibility and footer calculations) kept in localStorage per view until Theorem holds record view state; every read and write tolerates storage being unavailable, and only a change the person makes is saved. Filter text, sort and the previewed record are not here: the CRM table keeps those in the address
import { useCallback, useEffect, useState } from 'react'
import type { SetStateAction } from 'react'
import type {
  ColumnOrderState,
  ColumnSizingState,
  ColumnVisibilityState,
} from '@tanstack/react-table'
import type { AggregateOp } from './aggregate'
import { AGGREGATE_LABEL } from './aggregate'

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

function read(key: string): Partial<RecordViewState> {
  try {
    const raw = window.localStorage.getItem(STORAGE_PREFIX + key)
    return raw ? sanitize(JSON.parse(raw)) : {}
  } catch {
    return {}
  }
}

type Held = { key: string; state: RecordViewState; changed: boolean }

/**
 * The arrangement for `key`, starting from `initial` for anything not saved.
 * Nothing is written until the arrangement is changed, so a view nobody has
 * rearranged keeps following its program's `fields`; `reset` forgets it.
 */
export function useRecordViewState(
  key: string,
  initial: () => RecordViewState,
) {
  const load = (forKey: string): Held => ({
    key: forKey,
    state: { ...initial(), ...read(forKey) },
    changed: false,
  })
  const [held, setHeld] = useState<Held>(() => load(key))
  if (held.key !== key) setHeld(load(key))
  useEffect(() => {
    if (!held.changed) return
    try {
      window.localStorage.setItem(
        STORAGE_PREFIX + held.key,
        JSON.stringify(held.state),
      )
    } catch {
      // A private window or full storage keeps the arrangement for this visit only.
    }
  }, [held])
  const setState = useCallback(
    (next: SetStateAction<RecordViewState>) =>
      setHeld((now) => ({
        ...now,
        state: typeof next === 'function' ? next(now.state) : next,
        changed: true,
      })),
    [],
  )
  const reset = () => {
    try {
      window.localStorage.removeItem(STORAGE_PREFIX + key)
    } catch {
      // Nothing saved to remove.
    }
    setHeld({ key, state: initial(), changed: false })
  }
  return [held.state, setState, reset] as const
}
