// SOURCING: none — the Index's built-in view definitions as OpenUI Lang programs over the library in ./library; they are data, written in the language the library renders
import { workProgramFor } from '@/components/work/programs'
import { isWorkView } from '@/components/work/route'
import type { IndexView, Operation, Scope, ViewRevision } from './contract'

const OPERATIONS: Operation[] = [
  'open_item',
  'file_item',
  'correct_filing',
  'undo_correction',
  'ask_theorem',
  'pin_view',
  'set_preference',
]

const HOME = `$q = ""
root = Stack([search, results, shelves])
search = SearchField("Search the Index", $q)
found = Query("items", {q: $q}, {items: [], total: 0})
results = Section("Recent", [list])
list = ItemList(found.items, "list", "none", "Nothing matches yet.")
cols = Query("collections", {}, {collections: []})
shelves = Section("Collections", [grid])
grid = CollectionGrid(cols.collections)`

const COLLECTION = `$q = ""
root = Stack([search, results])
search = SearchField("Search this collection", $q)
found = Query("items", {q: $q}, {items: [], total: 0})
results = ItemList(found.items, "list", "kind", "This collection is empty.")`

const ATLAS = `$overlay = "density"
root = Stack([overlay, map])
overlay = Choice("Shade by", ["density", "boundary", "quantization_error", "activity"], $overlay)
m = Query("map", {overlay: $overlay}, {snapshot: null})
map = Atlas(m.snapshot, $overlay)`

export const DEFAULT_PREFIX = 'default:'
export const ATLAS_VIEW_ID = 'default:atlas'
export const RECORDS_PREFIX = 'default:records:'
export const DATA_MODEL_VIEW_ID = 'default:data-model'
/** Where records begin: the record types to add, before there are any. */
export const RECORDS_HOME_VIEW_ID = 'default:records'
/** One record's page: `default:record:<name_singular>/<id>`. */
export const RECORD_PAGE_PREFIX = 'default:record:'

export const recordsViewId = (nameSingular: string) =>
  `${RECORDS_PREFIX}${nameSingular}`
export const recordPageViewId = (nameSingular: string, recordId: string) =>
  `${RECORD_PAGE_PREFIX}${nameSingular}/${recordId}`
export function parseRecordPageViewId(viewId: string | undefined) {
  if (!viewId?.startsWith(RECORD_PAGE_PREFIX)) return undefined
  const rest = viewId.slice(RECORD_PAGE_PREFIX.length)
  const slash = rest.indexOf('/')
  if (slash <= 0 || slash === rest.length - 1) return undefined
  return { nameSingular: rest.slice(0, slash), recordId: rest.slice(slash + 1) }
}
/** The data model, or one object in it. */
export const dataModelViewId = (focus?: string) =>
  focus ? `${DATA_MODEL_VIEW_ID}:${focus}` : DATA_MODEL_VIEW_ID

/** Programs that draw tables, diagrams or the work tracker's screens take the view's full width. */
export const isWideProgram = (program: string) =>
  /\b(RecordTable|RecordPage|RecordsHome|DataModel|Work(View|List|Board|ViewBar|Inbox|Item|Projects|Project))\(/.test(
    program,
  )
/**
 * A program that is one record table, one record page or the records home
 * is the whole view: it draws its own header and scrolls inside itself.
 */
export const isFullBleedProgram = (program: string) =>
  /^\s*root = (RecordTable|RecordPage|RecordsHome)\([^\n]*\)\s*$/.test(program)
export const isDefaultView = (viewId: string) =>
  viewId.startsWith(DEFAULT_PREFIX)

function revision(
  fields: Pick<ViewRevision, 'title' | 'purpose' | 'program' | 'bindings'>,
): ViewRevision {
  return {
    revision: 0,
    createdAtMs: 0,
    author: { kind: 'engine' },
    operations: OPERATIONS,
    note: 'Built into Theorem UI.',
    ...fields,
  }
}

function defaultView(
  viewId: string,
  scope: Scope,
  current: ViewRevision,
): IndexView {
  return {
    viewId,
    scope,
    origin: 'default',
    pinned: false,
    archived: false,
    createdAtMs: 0,
    updatedAtMs: 0,
    current,
  }
}

/** The view a scope opens with before anything is saved or learned. */
export function defaultViewFor(
  scope: Scope,
  collectionName?: string,
): IndexView {
  if (scope.kind === 'home')
    return defaultView(
      'default:home',
      scope,
      revision({
        title: 'Everything',
        purpose:
          'Search everything filed, newest first, and the collections it is in.',
        program: HOME,
        bindings: {
          items: { kind: 'items', query: { sort: 'updated' } },
          collections: { kind: 'collections' },
        },
      }),
    )
  return defaultView(
    `default:collection:${scope.collectionId}`,
    scope,
    revision({
      title: collectionName ?? 'Collection',
      purpose: 'Everything filed in this collection, grouped by kind.',
      program: COLLECTION,
      bindings: {
        items: {
          kind: 'items',
          query: { collectionId: scope.collectionId, sort: 'updated' },
        },
      },
    }),
  )
}

export const atlasView = (): IndexView =>
  defaultView(
    ATLAS_VIEW_ID,
    { kind: 'home' },
    revision({
      title: 'Atlas',
      purpose:
        'Where the material sits by meaning. A way to look, never a way to file.',
      program: ATLAS,
      bindings: { map: { kind: 'map', overlay: 'density' } },
    }),
  )

/** One declared object's records, as a table to sort, filter and edit. */
export const recordsView = (nameSingular: string, labelPlural?: string) =>
  defaultView(
    recordsViewId(nameSingular),
    { kind: 'home' },
    revision({
      title: labelPlural ?? nameSingular,
      purpose: `Every ${(labelPlural ?? nameSingular).toLowerCase()} record, to sort, filter and edit in place.`,
      program: `root = RecordTable(${JSON.stringify(nameSingular)})`,
      bindings: {},
    }),
  )

/** One record in full: its properties, what changed, and what it is tied to. */
export const recordPageView = (
  nameSingular: string,
  recordId: string,
  labelSingular?: string,
) =>
  defaultView(
    recordPageViewId(nameSingular, recordId),
    { kind: 'home' },
    revision({
      title: labelSingular ?? nameSingular,
      purpose: `One ${(labelSingular ?? nameSingular).toLowerCase()} record in full.`,
      program: `root = RecordPage(${JSON.stringify(nameSingular)}, ${JSON.stringify(recordId)})`,
      bindings: {},
    }),
  )

/** The record types Theorem can hold, and adding them. */
export const recordsHomeView = () =>
  defaultView(
    RECORDS_HOME_VIEW_ID,
    { kind: 'home' },
    revision({
      title: 'Records',
      purpose:
        'The people, organizations and promises Theorem keeps as records, and adding them.',
      program: 'root = RecordsHome()',
      bindings: {},
    }),
  )

/** The schema: what objects there are, how they relate, and what is not declared yet. */
export const dataModelView = (focus?: string, labelPlural?: string) =>
  defaultView(
    dataModelViewId(focus),
    { kind: 'home' },
    revision({
      title: focus ? `${labelPlural ?? focus} · Data model` : 'Data model',
      purpose: focus
        ? `The fields and relations of ${(labelPlural ?? focus).toLowerCase()}, and what their records carry beyond them.`
        : 'The objects Theorem holds, how they relate, and what records carry that is not declared yet.',
      program: focus
        ? `root = DataModel(${JSON.stringify(focus)})`
        : 'root = DataModel()',
      bindings: {},
    }),
  )

/**
 * The revision on screen. A built-in view is rebuilt in this page, so a
 * collection name that arrives after the first paint replaces "Collection".
 * A stored view keeps the revision this tab opened or last saved.
 */
export function revisionOnScreen(
  view: IndexView,
  held: ViewRevision | undefined,
): ViewRevision {
  if (view.origin === 'default') return view.current
  return held ?? view.current
}

/** A work tracker screen: the program is one component that reads the tracker itself. */
function workView(viewId: string): IndexView | undefined {
  const screen = workProgramFor(viewId)
  return (
    screen &&
    defaultView(
      viewId,
      { kind: 'home' },
      revision({
        title: screen.title,
        purpose: screen.purpose,
        program: screen.program,
        bindings: {},
      }),
    )
  )
}

/** Every built-in view, for tests and for resolving a default id from the URL. */
export function resolveDefaultView(
  viewId: string,
  collectionName?: (collectionId: string) => string | undefined,
  objectLabel?: (nameSingular: string) => string | undefined,
  objectLabelSingular?: (nameSingular: string) => string | undefined,
): IndexView | undefined {
  if (viewId === ATLAS_VIEW_ID) return atlasView()
  if (viewId === RECORDS_HOME_VIEW_ID) return recordsHomeView()
  const page = parseRecordPageViewId(viewId)
  if (page)
    return recordPageView(
      page.nameSingular,
      page.recordId,
      objectLabelSingular?.(page.nameSingular),
    )
  if (viewId.startsWith(RECORDS_PREFIX)) {
    const name = viewId.slice(RECORDS_PREFIX.length)
    return name ? recordsView(name, objectLabel?.(name)) : undefined
  }
  if (viewId === DATA_MODEL_VIEW_ID) return dataModelView()
  if (viewId.startsWith(`${DATA_MODEL_VIEW_ID}:`)) {
    const name = viewId.slice(DATA_MODEL_VIEW_ID.length + 1)
    return dataModelView(name, objectLabel?.(name))
  }
  if (isWorkView(viewId)) return workView(viewId)
  if (viewId === 'default:home') return defaultViewFor({ kind: 'home' })
  const prefix = 'default:collection:'
  if (viewId.startsWith(prefix)) {
    const collectionId = viewId.slice(prefix.length)
    return defaultViewFor(
      { kind: 'collection', collectionId },
      collectionName?.(collectionId),
    )
  }
  return undefined
}
