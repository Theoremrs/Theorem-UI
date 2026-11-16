// SOURCING: @tanstack/react-router's memory history and @tanstack/react-query, to mount a CRM component for a test as the app mounts it: inside a router that knows the Index's place (/index and its search) and a query client that does not retry, with the record views drawn as Index mode draws them (the view the search names, and the record open beside it). window.fetch is the in-memory fixture (./fixture)
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  useSearch,
} from '@tanstack/react-router'
import { act } from 'react'
import type { ReactNode } from 'react'
import { render } from '../../../test/blocks/render'
import {
  IndexPlaceContext,
  indexSearch,
  useIndexNavigate,
} from '@/components/index/navigation'
import type { IndexSearch } from '@/components/index/navigation'
import {
  RECORDS_HOME_VIEW_ID,
  RECORDS_PREFIX,
  parseRecordPageViewId,
  recordPageViewId,
  recordsViewId,
} from '@/components/index/programs'
import { parseRecordItemId, recordItemId } from '@/components/records/model'
import { CrmScopeProvider, useCrmScopeValue } from './context'
import { RecordsSection } from './crm-panel'
import {
  CrmRecordInspector,
  CrmRecordPageView,
  CrmTableView,
  RecordsHome,
} from './index-views'

/** An /index address: a type's table, a record's page, or the records home. */
export function indexAt(search: IndexSearch) {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(search))
    params.set(key, String(value))
  return `/index?${params.toString()}`
}
export const tableAt = (name: string, rest: IndexSearch = {}) =>
  indexAt({ view: recordsViewId(name), ...rest })
export const pageAt = (name: string, id: string) =>
  indexAt({ view: recordPageViewId(name, id) })
export const homeAt = () => indexAt({ view: RECORDS_HOME_VIEW_ID })
/** The Index item for a record opened beside a view. */
export const itemOf = (name: string, id: string) => `record:${name}/${id}`

/**
 * Records as Index mode draws them, without OpenUI: the view the address
 * names (a type's table, a record's page or the records home), the record
 * open beside it, and, with `panel`, the Index panel's records list.
 */
export function IndexRecords({ panel = false }: { panel?: boolean }) {
  const search = indexSearch(useSearch({ strict: false }))
  const navigate = useIndexNavigate()
  const scope = useCrmScopeValue()
  const page = parseRecordPageViewId(search.view)
  const table = search.view?.startsWith(RECORDS_PREFIX)
    ? search.view.slice(RECORDS_PREFIX.length)
    : undefined
  const open = parseRecordItemId(search.item ?? '')
  return (
    <IndexPlaceContext.Provider
      value={{ search: { ...search, scope: { kind: 'home' } }, navigate }}
    >
      <CrmScopeProvider value={scope}>
        {panel && (
          <nav aria-label="Index">
            <RecordsSection />
          </nav>
        )}
        <main>
          {page ? (
            <CrmRecordPageView
              object={page.nameSingular}
              recordId={page.recordId}
            />
          ) : table ? (
            <CrmTableView object={table} />
          ) : search.view === RECORDS_HOME_VIEW_ID ? (
            <RecordsHome />
          ) : null}
        </main>
        {open && (
          <CrmRecordInspector
            key={search.item}
            nameSingular={open.nameSingular}
            recordId={open.recordId}
            onOpenRelated={(type, id) => navigate.openItem(recordItemId(type, id))}
            onClose={navigate.closeItem}
          />
        )}
      </CrmScopeProvider>
    </IndexPlaceContext.Provider>
  )
}

/**
 * Renders `subject` at `path` in a router with /index (where every record
 * view is) and Settings' Profile. The subject is drawn by the root, as ModeView
 * draws a mode whatever the matched child is.
 */
export async function mountAt(path: string, subject: () => ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const root = createRootRoute({ component: () => <>{subject()}</> })
  const empty = () => null
  const index = createRoute({
    getParentRoute: () => root,
    path: '/index',
    component: empty,
  })
  const profile = createRoute({
    getParentRoute: () => root,
    path: '/settings/profile',
    component: empty,
  })
  const home = createRoute({
    getParentRoute: () => root,
    path: '/',
    component: empty,
  })
  const router = createRouter({
    routeTree: root.addChildren([
      index,
      profile,
      home,
    ]),
    history: createMemoryHistory({ initialEntries: [path] }),
  })
  // Every place the router went, in order.
  const visited: string[] = []
  router.subscribe('onBeforeNavigate', ({ toLocation }) => {
    visited.push(toLocation.href)
  })
  await router.load()
  const view = await render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  )
  // Let the first reads land, as they have by the time a person looks.
  await act(() => new Promise((resolve) => setTimeout(resolve, 5)))
  return {
    ...view,
    router,
    client,
    visited,
    path: () => router.state.location.pathname,
    /** The Index place the address names now. */
    search: () =>
      indexSearch(router.state.location.search),
  }
}
