// SOURCING: bun:test rendering the record preview and record page as the Index draws them (./test-harness) with React into happy-dom. window.fetch is the in-memory CRM fixture (./fixture) plus POST /api/index/v1/query, which answers the record_documents binding with a stubbed result and records each binding asked (used-together reads empty), as no Theorem is running. Synthetic records and documents only
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test'
import { act } from 'react'
import { cleanup, click, waitFor } from '../../../test/blocks/render'
import type { Binding, IndexItem, QueryResult } from '@/components/index/contract'
import { DOCUMENTS_ABOUT_LIMIT } from './documents-about'
import { createFixtureServer, fixtureFetch } from './fixture'
import { resetCrmWrites } from './queries'
import { IndexRecords, itemOf, mountAt, pageAt } from './test-harness'

const page = (
  window as unknown as { happyDOM: { setURL: (url: string) => void } }
).happyDOM
beforeAll(() => page.setURL('http://localhost:3000/'))
afterAll(() => page.setURL('about:blank'))

const realFetch = window.fetch
let asked: Binding[]
let answer: () => Response

const doc = (n: number): IndexItem => ({
  documentId: `doc:${n}`,
  title: `Visit notes ${n}`,
  documentKind: 'note',
  revision: { position: 1, contentDigest: 'x' },
  collectionIds: [],
  updatedPosition: n,
  snippet: '',
})
const stub = (result: QueryResult | 'fail') => {
  answer = () =>
    result === 'fail'
      ? Response.json(
          { error: { code: 'invalid_binding', message: 'unknown kind' } },
          { status: 400 },
        )
      : Response.json(result)
}

beforeEach(() => {
  resetCrmWrites()
  asked = []
  const crm = fixtureFetch(createFixtureServer())
  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(
      input instanceof Request ? input.url : String(input),
      'http://localhost:3000',
    )
    if (url.pathname === '/api/index/v1/query') {
      const { binding } = JSON.parse(String(init?.body)) as {
        binding: Binding
      }
      if (binding.kind === 'used_together')
        return Response.json({ kind: 'used_together', items: [], records: [] })
      asked.push(binding)
      return answer()
    }
    return crm(input, init)
  }) as typeof fetch
})
afterEach(async () => {
  await cleanup()
  window.fetch = realFetch
})

const noorItem = () => itemOf('Person', 'person:noor')
const preview = () =>
  mountAt(`/index?item=${encodeURIComponent(noorItem())}`, () => (
    <IndexRecords />
  ))
const section = (container: HTMLElement) =>
  container.querySelector('[aria-label="Documents about this"]')

describe('Documents about this', () => {
  test('lists the documents filed to the record, asked by its item id, and opens one', async () => {
    stub({ kind: 'items', items: [doc(1), doc(2)], total: 2 })
    const { container, search } = await preview()
    const list = await waitFor(() => section(container))
    expect(asked[0]).toEqual({
      kind: 'record_documents',
      recordItemId: noorItem(),
    })
    expect(list.querySelectorAll('li')).toHaveLength(2)
    const row = [...list.querySelectorAll('button')].find((b) =>
      b.textContent.includes('Visit notes 2'),
    )!
    await click(row)
    await waitFor(() => search().item === 'doc:2')
  })

  test('shows the first few and counts the rest', async () => {
    const items = Array.from({ length: DOCUMENTS_ABOUT_LIMIT + 3 }, (_, i) =>
      doc(i + 1),
    )
    stub({ kind: 'items', items, total: items.length })
    const { container } = await preview()
    const list = await waitFor(() => section(container))
    expect(list.querySelectorAll('li')).toHaveLength(DOCUMENTS_ABOUT_LIMIT)
    expect(list.textContent).toContain('and 3 more')
  })

  test('is hidden when no document is about the record, or the binding is refused', async () => {
    for (const result of [
      { kind: 'items', items: [], total: 0 } as QueryResult,
      'fail' as const,
    ]) {
      stub(result)
      const { container } = await preview()
      await waitFor(() => asked.length > 0)
      await waitFor(() => container.textContent.includes('Noor'))
      await act(() => new Promise((resolve) => setTimeout(resolve, 50)))
      expect(section(container)).toBeNull()
      expect(container.querySelector('[role="alert"]')).toBeNull()
      await cleanup()
      asked = []
    }
  })

  test('the record page lists them too', async () => {
    stub({ kind: 'items', items: [doc(1)], total: 1 })
    const { container } = await mountAt(pageAt('Person', 'person:noor'), () => (
      <IndexRecords />
    ))
    const list = await waitFor(() => section(container))
    expect(list.textContent).toContain('Visit notes 1')
  })
})
