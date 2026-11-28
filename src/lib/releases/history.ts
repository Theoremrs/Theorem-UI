// SOURCING: ./state HistoryEntry. OWN-03: source, layout and data history are
// three lists with three names; a historical source revision opens current
// data, and only a provider's own snapshot is called a data version.
import type { HistoryAxis, HistoryEntry } from './state'

export const AXIS_LABEL: Record<HistoryAxis, string> = {
  source: 'Code history',
  layout: 'Layout history',
  data: 'Data history',
}

export const AXIS_NOTE: Record<HistoryAxis, string> = {
  source: 'Earlier versions of the code. Opening one shows your current data.',
  layout: 'Earlier arrangements of pages. It does not change your data.',
  data: 'Changes to the data itself. Going back needs a snapshot from the place that holds the data.',
}

/** Entries of one axis, newest first. */
export const historyOf = (entries: HistoryEntry[], axis: HistoryAxis) =>
  entries.filter((e) => e.axis === axis).toReversed()

/**
 * What a "view an earlier state" action may honestly say. Only a provider that
 * keeps snapshots can show data as it was; otherwise the code is shown over
 * the current data and says so.
 */
export function earlierViewLabel(
  axis: HistoryAxis,
  provider: { snapshots: boolean },
): string {
  if (axis === 'data')
    return provider.snapshots
      ? 'Data as it was (a snapshot from its provider)'
      : 'This provider keeps no snapshots, so earlier data cannot be shown'
  return axis === 'source'
    ? 'Earlier code, showing your current data'
    : 'Earlier layout, showing your current data'
}
