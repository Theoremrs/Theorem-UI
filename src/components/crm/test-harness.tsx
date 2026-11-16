// SOURCING: @tanstack/react-router's memory history and @tanstack/react-query, to mount a CRM component for a test as the app mounts it: inside a router that knows the CRM's places and a query client that does not retry. window.fetch is the in-memory fixture (./fixture)
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import { act } from 'react'
import type { ReactNode } from 'react'
import { render } from '../../../test/blocks/render'

/**
 * Renders `subject` at `path` in a router with the CRM's routes (and /index,
 * where "Data model" leads). The subject is drawn by the root, as ModeView
 * draws a mode whatever the matched child is.
 */
export async function mountAt(path: string, subject: () => ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const root = createRootRoute({ component: () => <>{subject()}</> })
  const empty = () => null
  const crm = createRoute({
    getParentRoute: () => root,
    path: '/crm',
    component: empty,
  })
  const type = createRoute({
    getParentRoute: () => crm,
    path: '$objectType',
    component: empty,
  })
  const record = createRoute({
    getParentRoute: () => type,
    path: '$recordId',
    component: empty,
  })
  const index = createRoute({
    getParentRoute: () => root,
    path: '/index',
    component: empty,
  })
  const home = createRoute({
    getParentRoute: () => root,
    path: '/',
    component: empty,
  })
  const router = createRouter({
    routeTree: root.addChildren([
      crm.addChildren([type.addChildren([record])]),
      index,
      home,
    ]),
    history: createMemoryHistory({ initialEntries: [path] }),
  })
  // Every place the router went, in order.
  const visited: string[] = []
  router.subscribe('onBeforeNavigate', ({ toLocation }) => {
    visited.push(toLocation.pathname)
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
  }
}
