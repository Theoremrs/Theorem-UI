// SOURCING: the existing saved-view owners, wrapped and not replaced: the Work tracker's WorkView (components/work/contract, stored through components/work/api putView) and the Index's IndexView with its revisioned bindings (components/index/contract, stored through components/index/api reviseView). DATA-02: one presentation contract over both, where each owner compiles and runs its own query semantics and no new store holds a definition.
import type { Binding, IndexView, ItemQuery } from '@/components/index/contract'
import type {
  WorkField,
  WorkFilter,
  WorkGroupBy,
  WorkOperator,
  WorkOrderBy,
  WorkQuery,
  WorkView,
} from '@/components/work/contract'

export const SAVED_VIEW_SCHEMA = 'theorem.saved-view/1'

/** A condition of the shared filter shape. The owner decides which fields and operators it can run. */
export interface ViewCondition {
  field: string
  operator: string
  /** "me" stays "me": each viewer's own value is resolved by the owner when it runs. */
  value?: unknown
}
export interface ViewFilter {
  op: 'and' | 'or'
  conditions: Array<ViewCondition | ViewFilter>
}

export interface ViewPresentation {
  /** What the owner stored: `list`, `board`, or a layout this client does not know. */
  layout: string
  /** The layout actually drawn when the stored one is not supported here; announced, not silent. */
  fallback?: { shown: string; reason: string }
}

/** The domain that owns the definition and runs its queries. */
export type ViewOwner =
  | { kind: 'work'; scope: string }
  | { kind: 'index'; scope: 'home' | 'collection'; collectionId?: string }
  | { kind: string; scope?: string }

/**
 * A saved view as every consumer reads it. It holds the definition, never
 * the data it selects and never a table instance, so sharing it shares the
 * question, not the answer. Ephemeral search, scroll and unsaved adjustments
 * live in `SavedViewSession`.
 */
export interface SavedView {
  schema: typeof SAVED_VIEW_SCHEMA
  id: string
  owner: ViewOwner
  /** The owner's own schema version for this definition. */
  schemaVersion: number
  name: string
  filters: ViewFilter
  sort?: { field: string; direction: 'asc' | 'desc' }
  group?: string | null
  presentation: ViewPresentation
  visibleFields: string[]
  /** The owner's revision; a write names it. */
  revision: string | number
  /** The owner's definition exactly as read, kept so nothing the contract cannot express is lost. */
  original: unknown
}

/** What a viewer adjusts without saving: kept apart from the definition (DATA-02). */
export interface SavedViewSession {
  viewId: string
  search?: string
  scrollTop?: number
  /** Unsaved changes to the filters, sort or fields. */
  adjustments?: Partial<
    Pick<SavedView, 'filters' | 'sort' | 'group' | 'visibleFields'>
  >
}

export type CompileResult<TQuery> =
  | { ok: true; query: TQuery }
  | {
      ok: false
      /** The query is not run: a narrower reading would widen the view. */
      blocked: 'unsupported-filter'
      unsupported: ViewCondition[]
      /** The definition as stored, untouched. */
      original: unknown
    }

// Work

const WORK_FIELDS = [
  'status',
  'statusCategory',
  'priority',
  'assignee',
  'author',
  'label',
  'project',
  'milestone',
  'kind',
  'repo',
  'provider',
  'createdAt',
  'updatedAt',
  'dueAt',
  'checks',
  'reviewDecision',
  'draft',
  'text',
] as const satisfies readonly WorkField[]
const WORK_OPERATORS = [
  'is',
  'is_not',
  'in',
  'not_in',
  'contains',
  'before',
  'after',
  'is_empty',
  'is_not_empty',
] as const satisfies readonly WorkOperator[]
const WORK_GROUPS = [
  'status',
  'priority',
  'assignee',
  'project',
  'milestone',
  'label',
  'repo',
  'kind',
] as const
const WORK_LAYOUTS = ['list', 'board']

const isGroup = (node: ViewCondition | ViewFilter): node is ViewFilter =>
  'conditions' in node

/** Every condition in a filter tree, flattened. */
export function conditionsOf(filter: ViewFilter): ViewCondition[] {
  return filter.conditions.flatMap((node) =>
    isGroup(node) ? conditionsOf(node) : [node],
  )
}

export function fromWorkView(view: WorkView): SavedView {
  const filters = view.filter as unknown as ViewFilter
  return {
    schema: SAVED_VIEW_SCHEMA,
    id: view.id,
    owner: { kind: 'work', scope: view.scope },
    schemaVersion: 1,
    name: view.name,
    filters,
    sort: { field: view.orderBy.field, direction: view.orderBy.direction },
    group: view.groupBy,
    presentation: WORK_LAYOUTS.includes(view.layout)
      ? { layout: view.layout }
      : {
          layout: view.layout,
          fallback: {
            shown: 'list',
            reason: `Layout ${view.layout} is not available here.`,
          },
        },
    visibleFields: [...view.displayFields],
    revision: view.revision,
    original: view,
  }
}

const supportedWork = (c: ViewCondition) =>
  (WORK_FIELDS as readonly string[]).includes(c.field) &&
  (WORK_OPERATORS as readonly string[]).includes(c.operator)

/**
 * The Work query a definition runs. A condition the tracker cannot evaluate
 * (a field or operator a newer definition added) blocks the query: dropping
 * it would show more items than the view means, so the view is not run and
 * its stored definition is kept as it is.
 */
export function compileWork(
  view: SavedView,
  extra: { cursor?: string; limit?: number } = {},
): CompileResult<WorkQuery> {
  const unsupported = conditionsOf(view.filters).filter(
    (c) => !supportedWork(c),
  )
  const sortOk =
    !view.sort ||
    ['updatedAt', 'createdAt', 'priority', 'dueAt', 'title', 'status'].includes(
      view.sort.field,
    )
  const groupOk =
    view.group == null ||
    (WORK_GROUPS as readonly string[]).includes(view.group)
  if (unsupported.length || !sortOk || !groupOk)
    return {
      ok: false,
      blocked: 'unsupported-filter',
      unsupported: unsupported.length
        ? unsupported
        : [
            {
              field: !sortOk
                ? `sort:${view.sort?.field}`
                : `group:${view.group}`,
              operator: 'unsupported',
            },
          ],
      original: view.original,
    }
  return {
    ok: true,
    query: {
      filter: view.filters as unknown as WorkFilter,
      groupBy: (view.group ?? null) as WorkGroupBy,
      ...(view.sort && { orderBy: view.sort as WorkOrderBy }),
      ...extra,
    },
  }
}

// Index

const INDEX_PRESENTATION = 'program'

/** The structured filters an Index `items` binding holds: the filter semantics the Index can run. */
function indexConditions(query: ItemQuery): ViewCondition[] {
  return [
    ...(query.q ? [{ field: 'q', operator: 'contains', value: query.q }] : []),
    ...(query.collectionId
      ? [{ field: 'collection', operator: 'is', value: query.collectionId }]
      : []),
    ...(query.kind
      ? [{ field: 'kind', operator: 'is', value: query.kind }]
      : []),
    ...(query.ids ? [{ field: 'id', operator: 'in', value: query.ids }] : []),
  ]
}

export function fromIndexView(view: IndexView): SavedView {
  const bindings = Object.values(view.current.bindings)
  const conditions: ViewCondition[] = []
  for (const binding of bindings) {
    if (binding.kind === 'items')
      conditions.push(...indexConditions(binding.query))
    // Another binding (a map, used-together, filing history) is a query of
    // its own, not a filter this contract can express; it stays in `original`.
  }
  const items = bindings.find(
    (b): b is Extract<Binding, { kind: 'items' }> => b.kind === 'items',
  )
  return {
    schema: SAVED_VIEW_SCHEMA,
    id: view.viewId,
    owner:
      view.scope.kind === 'collection'
        ? {
            kind: 'index',
            scope: 'collection',
            collectionId: view.scope.collectionId,
          }
        : { kind: 'index', scope: 'home' },
    schemaVersion: 1,
    name: view.current.title,
    filters: { op: 'and', conditions },
    sort: items?.query.sort
      ? {
          field: items.query.sort,
          direction: items.query.sort === 'title' ? 'asc' : 'desc',
        }
      : undefined,
    group: null,
    // The Index draws a view with its program; the contract names it, it does not redraw it.
    presentation: { layout: INDEX_PRESENTATION },
    visibleFields: [],
    revision: view.current.revision,
    original: view,
  }
}

/**
 * The bindings the Index runs for a definition. Filters this contract holds
 * for an `items` binding are rebuilt; a definition carrying a condition the
 * Index cannot run is blocked, and the original bindings are returned
 * untouched with the block.
 */
export function compileIndex(
  view: SavedView,
): CompileResult<Record<string, Binding>> {
  const original = view.original as IndexView
  const unsupported = conditionsOf(view.filters).filter(
    (c) => !['q', 'collection', 'kind', 'id'].includes(c.field),
  )
  if (unsupported.length)
    return { ok: false, blocked: 'unsupported-filter', unsupported, original }
  return { ok: true, query: original.current.bindings }
}

/** Whether a viewer's adjusted filters are saved: only a deliberate save changes the definition. */
export const isAdjusted = (session: SavedViewSession) =>
  session.adjustments !== undefined &&
  Object.keys(session.adjustments).length > 0
