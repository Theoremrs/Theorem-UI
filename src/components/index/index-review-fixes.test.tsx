// SOURCING: bun:test rendering the Index's ViewColumn and the view library's record components with React into happy-dom, in the router the CRM harness builds (crm/test-harness). window.fetch answers the Index's view routes with a stored view and the CRM's /graphql from its in-memory fixture, as no Theorem is running. Synthetic records only
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useSearch } from '@tanstack/react-router'
import { act } from 'react'
import { cleanup, click, render, waitFor } from '../../../test/blocks/render'
import { createFixtureServer, fixtureFetch } from '@/components/crm/fixture'
import { mountAt } from '@/components/crm/test-harness'
import type { IndexView } from './contract'
import { PREVIEW_HOST } from './library'
import type { IndexHost } from './library'
import { ViewColumn } from './index-surface'
import { IndexPlaceContext, indexSearch, useIndexNavigate } from './navigation'
import { ViewRenderer } from './view-renderer'

const page = (
  window as unknown as { happyDOM: { setURL: (url: string) => void } }
).happyDOM
beforeAll(() => page.setURL('http://localhost:3000/'))
afterAll(() => page.setURL('about:blank'))

const realFetch = window.fetch
const SAVED = 'user:people'
const revision = (n: number) => ({
  revision: n,
  createdAtMs: 1,
  author: { kind: 'person', id: 'p' },
  title: 'People I keep',
  purpose: 'My people.',
  program: 'root = RecordTable("person")',
  bindings: {},
  operations: [],
  note: `revision ${n}`,
})
const saved = (n: number) =>
  ({
    viewId: SAVED,
    scope: { kind: 'home' },
    origin: 'user',
    pinned: false,
    archived: false,
    createdAtMs: 1,
    updatedAtMs: 1,
    current: revision(n),
  }) as unknown as IndexView

beforeEach(() => {
  const crm = fixtureFetch(createFixtureServer())
  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(
      input instanceof Request ? input.url : String(input),
      'http://localhost:3000',
    )
    if (url.pathname === `/api/index/v1/views/${encodeURIComponent(SAVED)}`)
      return Response.json({ view: saved(1), revisions: [revision(1)] })
    if (url.pathname === '/api/index/v1/views')
      return Response.json({ views: [saved(1)] })
    if (url.pathname === '/api/index/v1/collections')
      return Response.json({ collections: [] })
    if (url.pathname === '/api/index/v1/proposals')
      return Response.json({ proposals: [] })
    return crm(input, init)
  }) as typeof fetch
})
afterEach(async () => {
  await cleanup()
  window.fetch = realFetch
})

function ColumnAtUrl() {
  const search = indexSearch(useSearch({ strict: false }))
  const navigate = useIndexNavigate()
  return (
    <IndexPlaceContext.Provider
      value={{ search: { ...search, scope: { kind: 'home' } }, navigate }}
    >
      <ViewColumn />
    </IndexPlaceContext.Provider>
  )
}

test('a saved view that is one record table keeps its header, and its newer-revision notice', async () => {
  const view = await mountAt(`/index?view=${encodeURIComponent(SAVED)}`, () => (
    <ColumnAtUrl />
  ))
  const header = await waitFor(() => view.container.querySelector('header'))
  expect(header.textContent).toContain('People I keep')
  expect(
    [...view.container.querySelectorAll('button')].some((b) =>
      b.textContent.includes('Edit'),
    ),
  ).toBe(true)
  expect(view.container.textContent).not.toContain('newer revision')

  // A revision made elsewhere arrives: it waits behind a notice.
  await act(async () => {
    view.client.setQueryData(['theorem', 'index', 'view', SAVED], {
      view: saved(2),
      revisions: [revision(2), revision(1)],
    })
  })
  await waitFor(() =>
    view.container.textContent.includes('This view has a newer revision.'),
  )
  expect(
    [...view.container.querySelectorAll('button')].some(
      (b) => b.textContent.trim() === 'Show it',
    ),
  ).toBe(true)
})

test('a record table in a preview keeps its place to itself and never moves the live Index', async () => {
  const view = await mountAt('/index?view=live', () => <PreviewOverLiveIndex />)
  const cell = await waitFor(() =>
    [...view.container.querySelectorAll('[role="gridcell"]')].find((c) =>
      c.textContent.includes('Noor'),
    ),
  )
  const before = view.router.state.location.href
  await click(cell)
  await act(() => new Promise((resolve) => setTimeout(resolve, 20)))
  expect(view.router.state.location.href).toBe(before)
})

function PreviewOverLiveIndex() {
  const search = indexSearch(useSearch({ strict: false }))
  const navigate = useIndexNavigate()
  const host: IndexHost = { ...PREVIEW_HOST }
  return (
    <IndexPlaceContext.Provider
      value={{ search: { ...search, scope: { kind: 'home' } }, navigate }}
    >
      <ViewRenderer
        definition={{
          program: 'root = RecordTable("person")',
          bindings: {},
          operations: [],
        }}
        host={host}
      />
    </IndexPlaceContext.Provider>
  )
}

test('a record opened from a comparison closes the item beside it', async () => {
  const opened: { view: string; options: unknown }[] = []
  const host: IndexHost = {
    ...PREVIEW_HOST,
    openView: (view, options) => void opened.push({ view, options }),
  }
  window.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as {
      binding?: { kind: string }
    }
    if (body.binding?.kind === 'records')
      return Response.json({
        kind: 'records',
        records: [
          {
            itemId: 'record:Person/person:noor',
            recordId: 'person:noor',
            nameSingular: 'Person',
            title: 'Noor',
          },
        ],
      })
    if (body.binding?.kind === 'items')
      return Response.json({ kind: 'items', items: [], total: 0 })
    if (body.binding?.kind === 'collections')
      return Response.json({ kind: 'collections', collections: [] })
    return Response.json({ csrfToken: 'csrf' })
  }) as typeof fetch
  const { container } = await render(
    <QueryClientProvider client={new QueryClient()}>
      <ViewRenderer
        definition={{
          program: `root = IndexComparison(found, cols, [], recs)
found = Query("items", {}, {items: [], total: 0})
cols = Query("collections", {}, {collections: []})
recs = Query("records", {}, {records: []})`,
          bindings: {
            items: { kind: 'items', query: { ids: [] } },
            collections: { kind: 'collections' },
            records: { kind: 'records', ids: ['record:Person/person:noor'] },
          } as never,
          operations: [],
        }}
        host={host}
      />
    </QueryClientProvider>,
  )
  const row = await waitFor(() =>
    [...container.querySelectorAll('button')].find((b) =>
      b.textContent.includes('Noor'),
    ),
  )
  await click(row)
  expect(opened).toEqual([
    {
      view: expect.stringContaining('person:noor'),
      options: { closeItem: true },
    },
  ])
})
