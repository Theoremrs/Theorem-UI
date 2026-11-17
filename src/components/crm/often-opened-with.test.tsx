// SOURCING: bun:test rendering the record preview and the record page as the Index draws them (./test-harness) with React into happy-dom. window.fetch is the in-memory CRM fixture (./fixture) with one addition: POST /api/index/v1/query, which answers the used-together binding with a stubbed result and records the binding it was asked (the record_documents binding reads empty), as no Theorem is running. Synthetic records and documents only
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from 'bun:test'
import { cleanup, click, waitFor } from '../../../test/blocks/render'
import { observer } from '@/components/index/observe'
import type { Binding, QueryResult } from '@/components/index/contract'
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
let opened: unknown[]
let answer: () => Response

const stubUsed = (result: QueryResult | 'fail') => {
  answer = () =>
    result === 'fail'
      ? Response.json(
          { error: { code: 'unavailable', message: 'down' } },
          { status: 503 },
        )
      : Response.json(result)
}

beforeEach(() => {
  resetCrmWrites()
  asked = []
  opened = []
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
      // The record's "Documents about this" asks too; it is not under test here.
      if (binding.kind === 'record_documents')
        return Response.json({ kind: 'items', items: [], total: 0 })
      asked.push(binding)
      return answer()
    }
    return crm(input, init)
  }) as typeof fetch
  spyOn(observer(), 'record').mockImplementation((event) => {
    opened.push(event)
  })
})
afterEach(async () => {
  await cleanup()
  window.fetch = realFetch
  ;(observer().record as unknown as { mockRestore: () => void }).mockRestore()
})

const noorItem = () => itemOf('Person', 'person:noor')
const preview = () =>
  mountAt(`/index?item=${encodeURIComponent(noorItem())}`, () => (
    <IndexRecords />
  ))
const section = (container: HTMLElement) =>
  container.querySelector('[aria-label="Often opened with"]')
const rowNamed = (root: Element, name: string) =>
  [...root.querySelectorAll('button')].find((b) => b.textContent.includes(name))

const MIXED: QueryResult = {
  kind: 'used_together',
  items: [
    {
      documentId: 'doc:kiln-notes',
      title: 'Kiln notes',
      documentKind: 'note',
      snippet: '',
      collectionIds: [],
      updatedPosition: 1,
      sessions: 2,
    } as never,
  ],
  records: [
    {
      itemId: 'record:Organization/org:kiln',
      recordId: 'org:kiln',
      nameSingular: 'Organization',
      title: 'Kiln Street Studio',
      sessions: 3,
    },
    {
      itemId: 'record:Person/person:avery',
      recordId: 'person:avery',
      nameSingular: 'Person',
      title: '',
      sessions: 1,
    },
  ],
}

describe('Often opened with', () => {
  test('lists record and document neighbours, anchored on the record item id', async () => {
    stubUsed(MIXED)
    const { container, search } = await preview()
    const list = await waitFor(() => section(container))
    expect(asked[0]).toEqual({
      kind: 'used_together',
      anchorIds: [noorItem()],
      limit: 8,
    })
    expect(list.textContent).toContain('Kiln Street Studio')
    // A record without a title shows its id.
    expect(list.textContent).toContain('person:avery')
    expect(list.textContent).toContain('Kiln notes')

    // A record neighbour opens its page; a document opens beside the view.
    await click(rowNamed(list, 'Kiln Street Studio')!)
    await waitFor(
      () => search().view === 'default:record:Organization/org:kiln',
    )
    expect(opened).toContainEqual(
      expect.objectContaining({
        kind: 'item_opened',
        subjects: ['record:Organization/org:kiln'],
      }),
    )
  })

  test('a document neighbour opens as the Index opens an item', async () => {
    stubUsed(MIXED)
    const { container, search } = await preview()
    const list = await waitFor(() => section(container))
    await click(rowNamed(list, 'Kiln notes')!)
    await waitFor(() => search().item === 'doc:kiln-notes')
  })

  test('an older server result without records still lists its documents', async () => {
    stubUsed({ kind: 'used_together', items: MIXED.items })
    const { container } = await preview()
    const list = await waitFor(() => section(container))
    expect(list.textContent).toContain('Kiln notes')
    expect(list.querySelectorAll('li')).toHaveLength(1)
  })

  test('is hidden when nothing was opened alongside', async () => {
    stubUsed({ kind: 'used_together', items: [], records: [] })
    const { container } = await preview()
    await waitFor(() => asked.length > 0)
    await waitFor(() => container.textContent.includes('Noor'))
    expect(section(container)).toBeNull()
  })

  test('is hidden, with no error shown, when the read fails', async () => {
    stubUsed('fail')
    const { container } = await preview()
    await waitFor(() => asked.length > 0)
    await waitFor(() => container.textContent.includes('Noor'))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(section(container)).toBeNull()
    expect(container.querySelector('[role="alert"]')).toBeNull()
  })

  test('the record page lists them too', async () => {
    stubUsed(MIXED)
    const { container } = await mountAt(pageAt('Person', 'person:noor'), () => (
      <IndexRecords />
    ))
    const list = await waitFor(() => section(container))
    expect(list.textContent).toContain('Kiln Street Studio')
    expect(asked[0]).toMatchObject({ anchorIds: [noorItem()] })
  })
})
