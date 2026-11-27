// SOURCING: none. The pure state behind the References surface (LINK-03): rows grouped by canonical source identity, counts that say what they count, and a page state that keeps earlier rows when a later page fails and never reads a failed query as empty.
import { canonicalKey } from './registry'
import type { ReferenceOccurrence, ReferencesPage } from './provider'
import type { RelationshipKind } from './relationships'
import type { ResourceRef } from './types'

export interface ReferenceGroup {
  /** The canonical source identity, never a title. */
  sourceKey: string
  source: ResourceRef
  occurrences: ReferenceOccurrence[]
  relationships: RelationshipKind[]
}

/**
 * Repeated mentions in one source are one row; each occurrence keeps its own
 * destination. Order of first appearance is kept, so a later page appends.
 */
export function groupOccurrences(
  occurrences: readonly ReferenceOccurrence[],
): ReferenceGroup[] {
  const groups = new Map<string, ReferenceGroup>()
  for (const occurrence of occurrences) {
    const sourceKey = canonicalKey(occurrence.source.resource)
    const group = groups.get(sourceKey)
    if (!group) {
      groups.set(sourceKey, {
        sourceKey,
        source: occurrence.source,
        occurrences: [occurrence],
        relationships: [occurrence.relationship],
      })
      continue
    }
    group.occurrences.push(occurrence)
    if (!group.relationships.includes(occurrence.relationship))
      group.relationships.push(occurrence.relationship)
  }
  return [...groups.values()]
}

/** What the loaded rows contain, for a count that names its unit. */
export const visibleCounts = (groups: readonly ReferenceGroup[]) => ({
  sources: groups.length,
  occurrences: groups.reduce((n, g) => n + g.occurrences.length, 0),
})

export type ReferencesStatus =
  | 'loading'
  | 'ready'
  | 'loading-more'
  /** The first page failed: there is no answer, which is not an empty result. */
  | 'failed'
  /** A later page failed: the rows read so far stay. */
  | 'failed-more'
  | 'unsupported'

export interface ReferencesState {
  status: ReferencesStatus
  rows: readonly ReferenceOccurrence[]
  next?: string
  total?: ReferencesPage['total']
  error?: string
}

export const initialReferences: ReferencesState = {
  status: 'loading',
  rows: [],
}

export type ReferencesAction =
  | { type: 'reset' }
  | { type: 'more' }
  | { type: 'page'; page: ReferencesPage; append: boolean }
  | { type: 'failed'; error: string }
  | { type: 'unsupported' }

export function referencesReducer(
  state: ReferencesState,
  action: ReferencesAction,
): ReferencesState {
  switch (action.type) {
    case 'reset':
      return initialReferences
    case 'more':
      return state.next
        ? { ...state, status: 'loading-more', error: undefined }
        : state
    case 'page': {
      const seen = new Set(action.append ? state.rows.map((r) => r.id) : [])
      const fresh = action.page.occurrences.filter((r) => !seen.has(r.id))
      return {
        status: 'ready',
        rows: action.append ? [...state.rows, ...fresh] : fresh,
        next: action.page.next,
        total: action.page.total,
      }
    }
    case 'failed':
      return state.rows.length
        ? { ...state, status: 'failed-more', error: action.error }
        : { ...state, status: 'failed', error: action.error }
    case 'unsupported':
      return { status: 'unsupported', rows: [] }
  }
}

/** A count the row header may show: says whether it is the owner's total or only what is loaded. */
export function countLabel(state: ReferencesState): string {
  const groups = groupOccurrences(state.rows)
  const loaded = visibleCounts(groups)
  const total = state.total
  if (total && total.exact && !state.next)
    return `${total.count} visible ${total.unit}`
  if (total)
    return `${loaded[total.unit]} of ${total.exact ? '' : 'at least '}${total.count} visible ${total.unit}`
  return state.next
    ? `${loaded.sources} visible ${loaded.sources === 1 ? 'source' : 'sources'} so far`
    : `${loaded.sources} visible ${loaded.sources === 1 ? 'source' : 'sources'}`
}
