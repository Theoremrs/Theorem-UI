// SOURCING: bun:test over the activity view, rendered with React into happy-dom inside a memory router, with the organization read seeded into a QueryClient. fetch is stubbed, as no Theorem is running, and every call is recorded so a test can show that opening work starts nothing.
import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import { act, useState } from 'react'
import { cleanup, render, waitFor } from '../../../test/workspace'
import { useShell } from '@/components/shell/shell-state'
import { organizationKey } from '@/lib/theorem/organization'
import type { OrganizationRead, ThreadEntry } from '@/lib/theorem/organization'
import { useActivityView } from '@/lib/workbench/activity/arrangement'
import { ActivityView } from './activity-view'

const thread = (id: string, running = true): ThreadEntry => ({
  threadId: id,
  title: `Thread ${id}`,
  homeProjectId: 'p',
  revision: 1,
  createdAtMs: 1,
  memberships: [],
  attention: { reasons: [], running, runId: `run-${id}` },
})

const organization = (threads: ThreadEntry[]) =>
  ({
    threads,
    projects: [{ projectId: 'p', title: 'Project P' }],
    librarian: { state: 'idle' },
    complete: true,
    served: true,
  }) as unknown as OrganizationRead

function Harness() {
  const [frame, setFrame] = useState<HTMLDivElement | null>(null)
  return (
    <div ref={setFrame}>
      <button type="button" data-testid="origin">
        Origin
      </button>
      <ActivityView projectId="p" frame={frame} />
      <Outlet />
    </div>
  )
}

let calls: Array<{ url: string; method: string }> = []
let restoreFetch: (() => void) | undefined
let client: QueryClient

async function mount(threads: ThreadEntry[]) {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  client.setQueryData(organizationKey, organization(threads))
  const root = createRootRoute({ component: Harness })
  const routeTree = root.addChildren([
    createRoute({ getParentRoute: () => root, path: '/' }),
    createRoute({ getParentRoute: () => root, path: '/c/$threadId' }),
  ])
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  const { container } = await render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  return { container, router }
}

const region = (container: HTMLElement) =>
  container.querySelector<HTMLElement>('[aria-label="Agent activity"]')
const row = (container: HTMLElement, key: string) =>
  container.querySelector<HTMLButtonElement>(`[data-activity-row="${key}"]`)

beforeEach(() => {
  calls = []
  useActivityView.setState({
    open: false,
    expanded: false,
    placement: 'bottom',
    scope: 'project',
    selected: null,
    arranged: undefined,
    saved: {},
    origin: null,
  })
  useShell.setState({ workbench: undefined })
  const spy = spyOn(globalThis, 'fetch').mockImplementation((async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    calls.push({ url: String(input), method: init?.method ?? 'GET' })
    return new Response(null, { status: 404 })
  }) as unknown as typeof fetch)
  restoreFetch = () => spy.mockRestore()
})
afterEach(() => {
  restoreFetch?.()
  cleanup()
})

test('a click selects without navigating; Open work reveals the thread and starts nothing', async () => {
  const { container, router } = await mount([thread('a'), thread('b')])
  act(() => useActivityView.getState().openView({ origin: null }))
  const b = await waitFor(() => row(container, 'thread:b'))
  await act(async () => b.click())
  expect(b.getAttribute('aria-pressed')).toBe('true')
  expect(router.state.location.pathname).toBe('/')
  const open = container.querySelector<HTMLButtonElement>(
    '[aria-label="Open work: Thread b"]',
  )!
  await act(async () => open.click())
  await waitFor(() => router.state.location.pathname === '/c/b')
  // Opening twice reveals the same thread; no request was a write.
  await act(async () => open.click())
  expect(router.state.location.pathname).toBe('/c/b')
  expect(calls.filter((c) => c.method !== 'GET')).toEqual([])
  // The drawer stays open: navigating is not closing.
  expect(region(container)).not.toBeNull()
})

test('a thread filed in the project shown now opens there, even when pinned elsewhere', async () => {
  const filed: ThreadEntry = {
    ...thread('m'),
    homeProjectId: 'q',
    memberships: [
      { projectId: 'q', pinned: true, atMs: 1 },
      { projectId: 'p', pinned: false, atMs: 2 },
    ] as ThreadEntry['memberships'],
  }
  useShell.setState({ projectId: 'p' })
  const { container, router } = await mount([filed])
  act(() => useActivityView.getState().openView({ origin: null }))
  const open = await waitFor(() =>
    container.querySelector<HTMLButtonElement>(
      '[aria-label="Open work: Thread m"]',
    ),
  )
  await act(async () => open.click())
  await waitFor(() => router.state.location.pathname === '/c/m')
  expect(useShell.getState().projectId).toBe('p')
})

test('closing after Show all returns focus to the preview’s Show all', async () => {
  const { container } = await mount([thread('a')])
  const show = await waitFor(() =>
    container.querySelector<HTMLButtonElement>('[data-activity-return]'),
  )
  show.focus()
  await act(async () => show.click())
  await waitFor(() => region(container))
  await act(async () => {
    useActivityView.getState().close()
    await Bun.sleep(40)
  })
  expect(document.activeElement?.hasAttribute('data-activity-return')).toBe(
    true,
  )
})

test('double-clicking a drawer row opens its work, like the Open work action', async () => {
  const { container, router } = await mount([thread('a')])
  act(() => useActivityView.getState().openView({ origin: null }))
  const a = await waitFor(() => row(container, 'thread:a'))
  await act(async () => {
    a.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
  })
  await waitFor(() => router.state.location.pathname === '/c/a')
})

test('Escape closes only from the view’s own chrome and returns focus to the opener', async () => {
  const { container } = await mount([thread('a')])
  const origin = container.querySelector<HTMLButtonElement>(
    '[data-testid="origin"]',
  )!
  origin.focus()
  act(() => useActivityView.getState().openView({ origin }))
  const a = await waitFor(() => row(container, 'thread:a'))
  await act(async () => a.click())
  // A run id is selectable text, not chrome: Escape there is left to it.
  const runId = await waitFor(() =>
    [...container.querySelectorAll('dd')].find(
      (d) => d.textContent === 'run-a',
    ),
  )
  await act(async () => {
    runId.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    )
  })
  expect(region(container)).not.toBeNull()
  // A control that already handled Escape keeps it.
  const handled = new KeyboardEvent('keydown', {
    key: 'Escape',
    bubbles: true,
    cancelable: true,
  })
  handled.preventDefault()
  await act(async () => {
    a.dispatchEvent(handled)
  })
  expect(region(container)).not.toBeNull()
  a.focus()
  await act(async () => {
    a.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    )
  })
  expect(region(container)).toBeNull()
  expect(document.activeElement).toBe(origin)
})

test('expanding and restoring keep the selection and the row', async () => {
  const { container } = await mount([thread('a'), thread('b')])
  act(() => useActivityView.getState().openView({ origin: null }))
  const b = await waitFor(() => row(container, 'thread:b'))
  await act(async () => b.click())
  const expand = container.querySelector<HTMLButtonElement>(
    '[aria-label="Expand to full workspace"]',
  )!
  await act(async () => expand.click())
  expect(region(container)?.dataset.activityPlacement).toBe('full')
  expect(row(container, 'thread:b')?.getAttribute('aria-pressed')).toBe('true')
  const restore = container.querySelector<HTMLButtonElement>(
    '[aria-label="Restore drawer"]',
  )!
  await act(async () => restore.click())
  expect(region(container)?.dataset.activityPlacement).toBe('bottom')
  expect(row(container, 'thread:b')?.getAttribute('aria-pressed')).toBe('true')
})

test('new work joins the end without moving focus, the selection or other rows', async () => {
  const { container } = await mount([thread('a'), thread('b')])
  act(() => useActivityView.getState().openView({ origin: null }))
  const b = await waitFor(() => row(container, 'thread:b'))
  await act(async () => b.click())
  b.focus()
  act(() => {
    client.setQueryData(
      organizationKey,
      organization([thread('c'), thread('b'), thread('a', false)]),
    )
  })
  await waitFor(() => row(container, 'thread:c'))
  const keys = [
    ...container.querySelectorAll<HTMLElement>('[data-activity-row]'),
  ].map((el) => el.dataset.activityRow)
  expect(keys).toEqual(['thread:a', 'thread:b', 'thread:c'])
  expect(document.activeElement).toBe(row(container, 'thread:b'))
  expect(useActivityView.getState().selected).toBe('thread:b')
  // The thread that stopped running stays, saying so.
  expect(row(container, 'thread:a')?.textContent).toContain(
    'Not listed as working now',
  )
})

test('the compact preview counts work; its header opens the drawer on that run', async () => {
  const { container, router } = await mount([thread('a'), thread('b')])
  const preview = await waitFor(() =>
    container.querySelector<HTMLElement>(
      '[aria-label="Agent activity preview"]',
    ),
  )
  expect(preview.textContent).toContain('2 working')
  const disclosure =
    preview.querySelector<HTMLButtonElement>('[aria-expanded]')!
  await act(async () => disclosure.click())
  const b = await waitFor(() => row(container, 'thread:b'))
  // A single click selects in place.
  await act(async () => b.click())
  expect(region(container)).toBeNull()
  expect(router.state.location.pathname).toBe('/')
  await act(async () => {
    b.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
  })
  await waitFor(() => region(container))
  expect(useActivityView.getState().selected).toBe('thread:b')
  expect(row(container, 'thread:b')?.getAttribute('aria-pressed')).toBe('true')
  expect(router.state.location.pathname).toBe('/')
})

test('the view says what it cannot see', async () => {
  const { container } = await mount([thread('a')])
  act(() => useActivityView.getState().openView({ origin: null }))
  await waitFor(() => region(container))
  const text = region(container)!.textContent
  expect(text).toContain('Theorem serves no project-wide run list yet')
  expect(text).toContain('The workspace is not open here')
})
