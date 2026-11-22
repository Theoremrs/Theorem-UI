// SOURCING: bun:test rendering a stored view program with the Index's real ViewRenderer (the real OpenUI parser and library) with React into happy-dom. fetch is stubbed for POST /api/index/v1/query (each binding kind answered with synthetic documents and records) and the CSRF bootstrap, as no Theorem is running; the host is a recording stub
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  spyOn,
  test,
} from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, click, render, waitFor } from '../../../test/blocks/render'
import type { Binding, QueryResult } from './contract'
import { PREVIEW_HOST } from './library'
import type { IndexHost } from './library'
import { ViewRenderer } from './view-renderer'

const page = (
  window as unknown as { happyDOM: { setURL: (url: string) => void } }
).happyDOM
beforeAll(() => page.setURL('http://localhost:3000/index'))
afterAll(() => page.setURL('about:blank'))

const doc = (documentId: string, title: string) => ({
  documentId,
  title,
  documentKind: 'note',
  snippet: `${title} text`,
  collectionIds: [],
  updatedPosition: 1,
})

const result = (binding: Binding): QueryResult => {
  switch (binding.kind) {
    case 'items':
      return {
        kind: 'items',
        total: binding.query.ids?.length ?? 0,
        items: (binding.query.ids ?? []).map((id) =>
          doc(id, `Note ${id}`),
        ) as never,
      }
    case 'collections':
      return { kind: 'collections', collections: [] }
    case 'filing_history':
      return { kind: 'filing_history', receipts: [] }
    case 'records':
      return {
        kind: 'records',
        records: binding.ids.map((itemId) => {
          const [nameSingular, recordId] = itemId
            .slice('record:'.length)
            .split('/')
          return {
            itemId,
            recordId: recordId!,
            nameSingular: nameSingular!,
            title: recordId === 'person:noor' ? 'Noor' : '',
          }
        }),
      }
    default:
      throw new Error(`unexpected ${binding.kind}`)
  }
}

let asked: Binding[] = []
let restore: (() => void) | undefined
const stub = () => {
  asked = []
  const spy = spyOn(globalThis, 'fetch').mockImplementation((async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const path = new URL(String(input), 'http://localhost:3000').pathname
    if (path === '/api/chat/v1/bootstrap')
      return Response.json({
        schema: 'theorem.chat.bootstrap.v1',
        csrfToken: 'c',
      })
    if (path === '/api/index/v1/query') {
      const { binding } = JSON.parse(String(init?.body)) as { binding: Binding }
      asked.push(binding)
      return Response.json(result(binding))
    }
    if (path.endsWith('/collections')) return Response.json({ collections: [] })
    return Response.json({})
  }) as typeof fetch)
  restore = () => spy.mockRestore()
}
afterEach(async () => {
  restore?.()
  restore = undefined
  await cleanup()
})

const host = () => {
  const calls = {
    views: [] as string[],
    items: [] as string[],
    events: [] as unknown[],
  }
  const value: IndexHost = {
    ...PREVIEW_HOST,
    openView: (id) => void calls.views.push(id),
    openItem: (id) => void calls.items.push(id),
    record: (event) => void calls.events.push(event),
  }
  return { calls, value }
}

const draw = (
  program: string,
  bindings: Record<string, Binding>,
  value: IndexHost,
) =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ViewRenderer
        definition={{ program, bindings, operations: ['open_item'] }}
        host={value}
      />
    </QueryClientProvider>,
  )

const MIXED = `root = IndexComparison(found, cols, [filings_0, filings_1], recs)
found = Query("items", {}, {items: [], total: 0})
cols = Query("collections", {}, {collections: []})
filings_0 = Query("filings_0", {}, {receipts: []})
filings_1 = Query("filings_1", {}, {receipts: []})
recs = Query("records", {}, {records: []})`

const NOOR = 'record:Person/person:noor'
const KILN = 'record:Organization/org:kiln'

describe('IndexComparison with records', () => {
  test('renders the documents and a Records section, and opens a record page on click', async () => {
    stub()
    const { calls, value } = host()
    const { container } = await draw(
      MIXED,
      {
        items: { kind: 'items', query: { ids: ['a', 'b'] } },
        collections: { kind: 'collections' },
        filings_0: { kind: 'filing_history', documentId: 'a' },
        filings_1: { kind: 'filing_history', documentId: 'b' },
        records: { kind: 'records', ids: [NOOR, KILN] },
      },
      value,
    )
    const section = await waitFor(() =>
      container.querySelector('[aria-label="Records"]'),
    )
    expect(container.textContent).toContain('Note a')
    expect(container.textContent).toContain('Note b')
    expect(section.querySelector('h3')!.textContent).toBe('Records')
    expect(section.textContent).toContain('Noor')
    // No title: the record id stands in.
    expect(section.textContent).toContain('org:kiln')
    // Each row carries its type's mark.
    expect(section.querySelectorAll('li svg')).toHaveLength(2)
    expect(asked).toContainEqual({ kind: 'records', ids: [NOOR, KILN] })

    const noor = [...section.querySelectorAll('button')].find((b) =>
      b.textContent.includes('Noor'),
    )!
    await click(noor)
    expect(calls.views).toEqual(['default:record:Person/person:noor'])
    expect(calls.events).toContainEqual({
      kind: 'item_opened',
      subjects: [NOOR],
    })
  })

  test('a group of only records renders no documents and no empty strip', async () => {
    stub()
    const { value } = host()
    const program = `root = IndexComparison(found, cols, [], recs)
found = Query("items", {}, {items: [], total: 0})
cols = Query("collections", {}, {collections: []})
recs = Query("records", {}, {records: []})`
    const { container } = await draw(
      program,
      {
        items: { kind: 'items', query: { ids: [] } },
        collections: { kind: 'collections' },
        records: { kind: 'records', ids: [NOOR] },
      },
      value,
    )
    await waitFor(() => container.querySelector('[aria-label="Records"]'))
    expect(container.querySelector('.snap-x')).toBeNull()
    expect(container.textContent).toContain('Noor')
  })

  test('a documents-only program renders as before, with no Records section', async () => {
    stub()
    const { calls, value } = host()
    const program = `root = IndexComparison(found, cols, [filings_0])
found = Query("items", {}, {items: [], total: 0})
cols = Query("collections", {}, {collections: []})
filings_0 = Query("filings_0", {}, {receipts: []})`
    const { container } = await draw(
      program,
      {
        items: { kind: 'items', query: { ids: ['a'] } },
        collections: { kind: 'collections' },
        filings_0: { kind: 'filing_history', documentId: 'a' },
      },
      value,
    )
    await waitFor(() => container.textContent.includes('Note a'))
    expect(container.querySelector('[aria-label="Records"]')).toBeNull()
    await click(container.querySelector('.snap-x button')!)
    expect(calls.items).toEqual(['a'])
  })
})
