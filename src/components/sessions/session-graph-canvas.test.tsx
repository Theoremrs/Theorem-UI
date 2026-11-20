// SOURCING: bun:test over a saved session graph, rendered with React into happy-dom (test/blocks/render) inside a TanStack memory router, with stories/fake-theorem answering Theorem's routes from the session graph story's fixture, which refuses a save made against an old revision; no Theorem is running
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from 'bun:test'
import { act } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from '@tanstack/react-router'
import { programKeys, saveSessionGraph } from '@/lib/program/api'
import { SHOW_ALL } from '@/lib/theorem/session-graph'
import { installFakeTheorem } from '@/stories/fake-theorem'
import { storyRoutes } from '@/stories/routes'
import {
  buttonNamed,
  cleanup,
  render,
  waitFor,
} from '../../../test/blocks/render'
import { SessionGraphSurface } from './session-graph-canvas'

const page = (
  window as unknown as { happyDOM: { setURL: (url: string) => void } }
).happyDOM
beforeAll(() => page.setURL('http://localhost:3000/canvas'))
afterAll(() => page.setURL('about:blank'))

const TOOLS = 'POST /api/environment/v1/tools/:name/call'
const SCOPE = { kind: 'tree', id: 'thread-graph-memory' } as const
let restore = () => {}
/** Holds the next saves until it is released. */
let hold: Promise<void> | undefined
let client: QueryClient

beforeEach(() => {
  hold = undefined
  const routes = storyRoutes(Date.now())
  restore = installFakeTheorem({
    ...routes,
    [TOOLS]: async (params, request) => {
      const args = (await request.clone().json()) as { action?: string }
      if (hold && args.action === 'save_session_graph') await hold
      return routes[TOOLS]!(params, request)
    },
  })
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
})
afterEach(async () => {
  await cleanup()
  restore()
})

/** A view saved earlier, opened on the canvas as the list. */
async function open() {
  const view = await saveSessionGraph({
    name: 'Graph memory',
    scope: SCOPE,
    layout: { direction: 'RIGHT' },
    show: SHOW_ALL,
  })
  const router = createRouter({
    routeTree: createRootRoute({
      component: () => <SessionGraphSurface viewId={view.node_id} />,
    }),
    history: createMemoryHistory({ initialEntries: ['/canvas'] }),
  })
  await render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  const list = await waitFor(() => buttonNamed(document, 'Show as list'))
  await act(() => list.click())
  await waitFor(() => header().includes('· saved'))
  return view
}

const header = () => document.querySelector('header')?.textContent ?? ''
const save = () => buttonNamed(document, /^Save(d)?$/)!

async function toggle(facet: string) {
  await act(() => buttonNamed(document, 'Show')!.click())
  const item = await waitFor(() =>
    [
      ...document.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"]'),
    ].find((el) => el.textContent.trim() === facet),
  )
  await act(() => item.click())
  await act(async () => {
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    )
  })
}

test('an edit made while a save is on its way stays unsaved', async () => {
  await open()
  await toggle('Tools')
  expect(header()).toContain('unsaved changes')

  let release = () => {}
  hold = new Promise((resolve) => (release = resolve))
  await act(() => save().click())
  await toggle('Documents')
  release()
  hold = undefined
  await waitFor(() => save().textContent === 'Save' && !save().disabled)
  // The save landed with Tools hidden, but Documents changed after it left.
  await act(() => new Promise((resolve) => setTimeout(resolve, 50)))
  expect(header()).toContain('unsaved changes')
  expect(save().disabled).toBe(false)

  await act(() => save().click())
  await waitFor(() => header().includes('· saved'))
  expect(save().textContent).toBe('Saved')
})

test('a reload that brings a newer revision saved elsewhere cannot be saved over', async () => {
  const view = await open()
  // Another browser saves the view, and this one reloads it on focus.
  const elsewhere = await saveSessionGraph({
    node_id: view.node_id,
    expected_revision: view.revision,
    name: view.name,
    scope: SCOPE,
    layout: { direction: 'DOWN' },
    show: { ...SHOW_ALL, artifacts: false },
  })
  await act(() =>
    client.refetchQueries({ queryKey: programKeys.sessionGraph(view.node_id) }),
  )
  await waitFor(
    () =>
      client.getQueryData<{ revision: number }>(
        programKeys.sessionGraph(view.node_id),
      )?.revision === elsewhere.revision,
  )

  await toggle('Tools')
  await act(() => save().click())
  await waitFor(() =>
    document.body.textContent.includes('saved elsewhere since it was opened'),
  )
  // What the other browser saved is still what is saved.
  const kept = await import('@/lib/program/api').then((api) =>
    api.loadSessionGraph(view.node_id),
  )
  expect(kept.revision).toBe(elsewhere.revision)
  expect(kept.layout.direction).toBe('DOWN')
})
