// SOURCING: bun:test rendering the inspector's "About" section (./record-links) in the CRM's router harness (components/crm/test-harness) with React into happy-dom. window.fetch is the in-memory CRM fixture (data model and records) plus a stubbed record-filing owner under /api/documents/v2 that keeps its history in memory and records each write, as no Theorem is running. Synthetic records and documents only
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
import {
  createFixtureServer,
  fixtureFetch,
  FIXTURE_TYPE,
} from '@/components/crm/fixture'
import type { ObjectType } from '@/components/records/contract'
import { resetCrmWrites } from '@/components/crm/queries'
import { mountAt } from '@/components/crm/test-harness'
import type {
  RecordFilingCorrection,
  RecordFilingHistory,
  RecordFilingReceipt,
} from './contract'
import { RecordLinks, linkReason, undoableCorrection } from './record-links'

const page = (
  window as unknown as { happyDOM: { setURL: (url: string) => void } }
).happyDOM
beforeAll(() => page.setURL('http://localhost:3000/'))
afterAll(() => page.setURL('about:blank'))

const DOC = 'doc:kiln-visit'

const receipt = (
  over: Partial<RecordFilingReceipt> & Pick<RecordFilingReceipt, 'receiptId'>,
): RecordFilingReceipt => ({
  schema: 'theorem-document/2',
  documentId: DOC,
  recordItemId: 'record:Person/person:noor',
  recordId: 'person:noor',
  nameSingular: 'Person',
  title: 'Noor',
  tier: 'learned',
  attribution: { kind: 'name_mention', where: 'text', tokens: ['noor'] },
  confidence: 0.55,
  actor: { kind: 'engine' },
  lowConfidence: false,
  generation: 1,
  ...over,
})

const NOOR = receipt({ receiptId: 'r1' })

const RESEARCH_TYPE: ObjectType = {
  object_type_id: 'objtype:demo:researchquestion',
  tenant_id: 'demo',
  name_singular: 'ResearchQuestion',
  name_plural: 'ResearchQuestions',
  label_singular: 'Research question',
  label_plural: 'Research questions',
  node_label: 'ResearchQuestion',
  label_identifier_field: 'question',
  fields: [
    {
      key: 'question',
      label: 'Question',
      field_type: { kind: 'text' },
      required: true,
      system: false,
    },
  ],
  enforcement: 'warn',
  system: false,
  content_anchor: 'anchor:research-question:1',
}
const RESEARCH_RECORD = {
  id: 'question:throughput',
  labels: ['ResearchQuestion'],
  properties: { question: 'When does this method improve throughput?' },
  version: 1,
}
type RecordRead = {
  objectTypeId: string
  input: Record<string, unknown>
}

let history: RecordFilingHistory
let writes: { path: string; body: Record<string, unknown> }[]
let historyStatus: number
let server: ReturnType<typeof createFixtureServer>
let crm: typeof fetch
let recordReads: RecordRead[]
let failRecordSearch: boolean
let readBarrier: ((read: RecordRead) => Promise<void> | undefined) | undefined

const realFetch = window.fetch
beforeEach(() => {
  resetCrmWrites()
  writes = []
  historyStatus = 200
  history = {
    schema: 'theorem-document/2',
    documentId: DOC,
    receipts: [NOOR],
    links: [NOOR],
    corrections: [],
  }
  server = createFixtureServer()
  server.state.types.push(RESEARCH_TYPE)
  server.state.nodes.push({
    ...RESEARCH_RECORD,
    properties: { ...RESEARCH_RECORD.properties },
  })
  crm = fixtureFetch(server)
  recordReads = []
  failRecordSearch = false
  readBarrier = undefined
  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(
      input instanceof Request ? input.url : String(input),
      'http://localhost:3000',
    )
    const path = url.pathname
    if (path.endsWith('/record-filings') && init?.method !== 'POST')
      return historyStatus === 200
        ? Response.json(history)
        : Response.json(
            { error: { code: 'unavailable', message: 'down' } },
            { status: historyStatus },
          )
    if (path.includes('/record-filings/') && path.endsWith('/corrections')) {
      const body = JSON.parse(String(init?.body)) as {
        receiptId: string
        recordItemId: string | null
      }
      writes.push({ path, body })
      const correction: RecordFilingCorrection = {
        schema: 'theorem-document/2',
        correctionId: 'c1',
        receiptId: body.receiptId,
        documentId: DOC,
        fromRecordItemId: history.receipts.find(
          (saved) => saved.receiptId === body.receiptId,
        )!.recordItemId,
        toRecordItemId: body.recordItemId,
        actor: { kind: 'human', actorId: 'p' },
        generation: 2,
        undo: false,
        undone: false,
      }
      const separator = body.recordItemId?.indexOf('/') ?? -1
      const typeName = body.recordItemId?.slice('record:'.length, separator)
      const recordId = body.recordItemId?.slice(separator + 1)
      const targetType = server.state.types.find(
        (type) => type.name_singular === typeName,
      )
      const target = server.state.nodes.find(
        (node) =>
          node.id === recordId &&
          targetType &&
          node.labels.includes(targetType.node_label),
      )
      if (body.recordItemId && (!targetType || !target))
        throw new Error('The correction names no declared fixture record.')
      const moved =
        body.recordItemId && targetType && target
          ? receipt({
              receiptId: 'r2',
              recordItemId: body.recordItemId,
              recordId: target.id,
              nameSingular: targetType.name_singular,
              title: String(
                target.properties[targetType.label_identifier_field] ??
                  target.id,
              ),
              tier: 'precedent',
              attribution: {
                kind: 'correction',
                actor: { kind: 'human', actorId: 'p' },
              },
              confidence: 1,
              generation: 2,
            })
          : undefined
      history = {
        ...history,
        receipts: moved ? [...history.receipts, moved] : history.receipts,
        links: moved ? [moved] : [],
        corrections: [...history.corrections, correction],
      }
      return Response.json(
        { ...correction, ...(moved ? { receipt: moved } : {}) },
        { status: 201 },
      )
    }
    if (path.includes('/record-filing-corrections/')) {
      writes.push({ path, body: JSON.parse(String(init?.body)) })
      history = {
        ...history,
        links: [NOOR],
        corrections: [
          ...history.corrections.map((c) => ({ ...c, undone: true })),
          {
            schema: 'theorem-document/2',
            correctionId: 'c2',
            receiptId: 'r1',
            documentId: DOC,
            fromRecordItemId: null,
            toRecordItemId: 'record:Person/person:noor',
            actor: { kind: 'human', actorId: 'p' },
            generation: 3,
            undo: true,
            undone: false,
          },
        ],
      }
      return Response.json(history.corrections.at(-1), { status: 201 })
    }
    if (path === '/graphql') {
      const raw =
        input instanceof Request
          ? await input.clone().text()
          : String(init?.body ?? '{}')
      const body = JSON.parse(raw) as {
        variables?: {
          verb?: string
          objectTypeId?: string
          input?: Record<string, unknown>
        }
      }
      if (body.variables?.verb === 'find_many') {
        const read = {
          objectTypeId: String(body.variables.objectTypeId),
          input: body.variables.input ?? {},
        }
        recordReads.push(read)
        await readBarrier?.(read)
        if (failRecordSearch)
          return Response.json({ errors: [{ message: 'unavailable' }] })
      }
    }
    return crm(input, init)
  }) as typeof fetch
})
afterEach(async () => {
  await cleanup()
  window.fetch = realFetch
})

const mount = () => mountAt('/index', () => <RecordLinks documentId={DOC} />)
const about = (container: HTMLElement) =>
  container.querySelector('section[aria-label="About"]')
const buttonNamed = (root: ParentNode, name: string) =>
  [...root.querySelectorAll('button')].find(
    (b) => b.textContent.trim() === name,
  )

const options = () => [
  ...document.querySelectorAll<HTMLElement>('[role="option"]'),
]
const optionNamed = (name: string) =>
  options().find((option) => option.textContent.trim() === name)
const searchInput = (label: string) =>
  [...document.querySelectorAll<HTMLInputElement>('input')].find(
    (input) => input.getAttribute('aria-label') === label,
  )

async function openPicker(container: HTMLElement) {
  const section = await waitFor(() => about(container))
  await click(buttonNamed(section, 'Change…')!)
  return waitFor(() => searchInput('Find a person'))
}

async function chooseType(plural: string, inputLabel: string) {
  const selector = await waitFor(() =>
    document.querySelector<HTMLElement>('[aria-label="Record type"]'),
  )
  await click(selector)
  const option = await waitFor(() => optionNamed(plural))
  // Select requires a pointer press on an unhighlighted item before its click.
  await act(() => {
    option.dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        pointerType: 'mouse',
        button: 0,
      }),
    )
    option.dispatchEvent(
      new PointerEvent('pointerup', {
        bubbles: true,
        pointerType: 'mouse',
        button: 0,
      }),
    )
    option.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }))
  })
  return waitFor(() => searchInput(inputLabel))
}

async function enterSearch(input: HTMLInputElement, value: string) {
  await act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('linkReason', () => {
  test('says why, in a sentence', () => {
    expect(
      linkReason(
        receipt({
          receiptId: 'x',
          attribution: { kind: 'identifier', field: 'email_address' },
        }),
      ),
    ).toBe("Noor's email address appears in it.")
    expect(
      linkReason(
        receipt({
          receiptId: 'x',
          attribution: { kind: 'name_mention', where: 'title', tokens: [] },
        }),
      ),
    ).toBe('Named in the title.')
    expect(linkReason(NOOR)).toBe('Named in the text.')
    expect(
      linkReason(
        receipt({
          receiptId: 'x',
          tier: 'precedent',
          attribution: { kind: 'made', proposalId: 'proposal:draft' },
          confidence: 1,
        }),
      ),
    ).toBe('Theorem drafted it for this record when you approved it.')
  })
})

describe('undoableCorrection', () => {
  const correction = (
    over: Partial<RecordFilingCorrection>,
  ): RecordFilingCorrection => ({
    schema: 'theorem-document/2',
    correctionId: 'c',
    receiptId: 'r1',
    documentId: DOC,
    actor: { kind: 'human', actorId: 'p' },
    generation: 1,
    undo: false,
    undone: false,
    ...over,
  })
  test('only the latest correction, and not once it is an undo or undone', () => {
    const base = { ...history, corrections: [] as RecordFilingCorrection[] }
    expect(undoableCorrection(base)).toBeUndefined()
    const a = correction({ correctionId: 'a', generation: 1 })
    const b = correction({ correctionId: 'b', generation: 2 })
    expect(
      undoableCorrection({ ...base, corrections: [b, a] })?.correctionId,
    ).toBe('b')
    expect(
      undoableCorrection({ ...base, corrections: [a, { ...b, undone: true }] }),
    ).toBeUndefined()
    expect(
      undoableCorrection({ ...base, corrections: [a, { ...b, undo: true }] }),
    ).toBeUndefined()
  })
})

describe('About', () => {
  test('shows the linked record, why, and opens its page', async () => {
    const { container, search } = await mount()
    const section = await waitFor(() => about(container))
    expect(section.textContent).toContain('Noor')
    expect(section.textContent).toContain('Named in the text.')
    await click(buttonNamed(section, 'Noor')!)
    await waitFor(() => search().view === 'default:record:Person/person:noor')
  })

  test('says when Theorem was not sure', async () => {
    history.links = [{ ...NOOR, lowConfidence: true }]
    const { container } = await mount()
    const section = await waitFor(() => about(container))
    expect(section.textContent).toContain('Theorem was not sure')
  })

  test('"Not about Noor" dismisses the link and offers to undo it', async () => {
    const { container } = await mount()
    const section = await waitFor(() => about(container))
    await click(buttonNamed(section, 'Not about Noor')!)
    expect(writes[0]).toMatchObject({
      path: '/api/documents/v2/record-filings/r1/corrections',
      body: { receiptId: 'r1', recordItemId: null },
    })
    const undo = await waitFor(() =>
      buttonNamed(container, 'Undo "Not about Noor"'),
    )
    // The link is gone; only the way back remains.
    expect(buttonNamed(container, 'Not about Noor')).toBeUndefined()
    await click(undo)
    expect(writes[1]!.path).toBe(
      '/api/documents/v2/record-filing-corrections/c1/undo',
    )
    await waitFor(() => buttonNamed(container, 'Not about Noor'))
    expect(container.textContent).not.toContain('Undo')
  })

  test('Change… moves the link to another record of the same type', async () => {
    const { container } = await mount()
    const section = await waitFor(() => about(container))
    await click(buttonNamed(section, 'Change…')!)
    const input = await waitFor(() =>
      document.querySelector<HTMLInputElement>(
        'input[aria-label="Find a person"]',
      ),
    )
    expect(input).toBeDefined()
    const option = await waitFor(() =>
      [...document.querySelectorAll('[role="option"]')].find((o) =>
        o.textContent.includes('Avery Quinn'),
      ),
    )
    // The record already linked is not offered.
    expect(
      [...document.querySelectorAll('[role="option"]')].some(
        (o) => o.textContent.trim() === 'Noor',
      ),
    ).toBe(false)
    await click(option)
    await waitFor(() => writes.length > 0)
    expect(writes[0]!.body).toEqual(
      expect.objectContaining({
        receiptId: 'r1',
        recordItemId: 'record:Person/person:avery',
      }),
    )
    await waitFor(() => buttonNamed(container, 'Undo change to Avery Quinn'))
    expect(about(container)!.textContent).toContain('Linked here by a person.')
  })

  test('does not search records while the picker is closed', async () => {
    const { client, container } = await mount()
    await waitFor(() => about(container))
    await waitFor(() => !client.isFetching())
    expect(recordReads).toEqual([])
    expect(searchInput('Find a person')).toBeUndefined()
  })

  test('keeps an existing non-built-in system type editable and can move its link to research', async () => {
    const type: ObjectType = {
      ...RESEARCH_TYPE,
      object_type_id: 'objtype:demo:catalogentry',
      name_singular: 'CatalogEntry',
      name_plural: 'CatalogEntries',
      label_singular: 'Catalog entry',
      label_plural: 'Catalog entries',
      node_label: 'CatalogEntry',
      label_identifier_field: 'title',
      fields: [
        {
          key: 'title',
          label: 'Title',
          field_type: { kind: 'text' },
          required: true,
          system: false,
        },
      ],
      system: true,
      content_anchor: 'anchor:catalog-entry:1',
    }
    server.state.types.push(type)
    server.state.nodes.push({
      id: 'catalog:imported',
      labels: ['CatalogEntry'],
      properties: { title: 'Imported benchmark entry' },
      version: 1,
    })
    const linked = receipt({
      receiptId: 'r1',
      recordItemId: 'record:CatalogEntry/catalog:imported',
      recordId: 'catalog:imported',
      nameSingular: type.name_singular,
      title: 'Imported benchmark entry',
    })
    history = { ...history, receipts: [linked], links: [linked] }

    const { container } = await mount()
    const section = await waitFor(() => about(container))
    expect(section.textContent).toContain('Catalog entry')
    const change = buttonNamed(section, 'Change…')
    expect(change).toBeDefined()
    await click(change!)
    await waitFor(() => searchInput('Find a catalog entry'))
    const selector = await waitFor(() =>
      document.querySelector<HTMLElement>('[aria-label="Record type"]'),
    )
    expect(selector.textContent).toContain('Catalog entries')

    await chooseType('Research questions', 'Find a research question')
    await click(
      await waitFor(() => optionNamed(RESEARCH_RECORD.properties.question)),
    )
    await waitFor(() => writes.length === 1)
    expect(writes[0]).toMatchObject({
      path: '/api/documents/v2/record-filings/r1/corrections',
      body: {
        receiptId: 'r1',
        recordItemId: 'record:ResearchQuestion/question:throughput',
      },
    })
    expect(history.corrections[0]).toMatchObject({
      fromRecordItemId: linked.recordItemId,
      toRecordItemId: 'record:ResearchQuestion/question:throughput',
    })
    await waitFor(() =>
      buttonNamed(
        container,
        'Undo change to ' + RESEARCH_RECORD.properties.question,
      ),
    )
    expect(about(container)!.textContent).toContain('Research question')
  })

  test('moves to a custom declared research type and undoes through the same owner', async () => {
    const { container } = await mount()
    await openPicker(container)
    await chooseType('Research questions', 'Find a research question')
    await click(
      await waitFor(() => optionNamed(RESEARCH_RECORD.properties.question)),
    )
    await waitFor(() => writes.length === 1)
    expect(writes[0]).toMatchObject({
      path: '/api/documents/v2/record-filings/r1/corrections',
      body: {
        schema: 'theorem-document/2',
        receiptId: 'r1',
        recordItemId: 'record:ResearchQuestion/question:throughput',
      },
    })
    const undo = await waitFor(() =>
      buttonNamed(
        container,
        'Undo change to ' + RESEARCH_RECORD.properties.question,
      ),
    )
    expect(about(container)!.textContent).toContain('Research question')
    expect(about(container)!.textContent).toContain('Linked here by a person.')
    expect(history.links[0]).toMatchObject({
      recordId: RESEARCH_RECORD.id,
      nameSingular: RESEARCH_TYPE.name_singular,
      title: RESEARCH_RECORD.properties.question,
    })
    await click(undo)
    expect(writes[1]!.path).toBe(
      '/api/documents/v2/record-filing-corrections/c1/undo',
    )
    await waitFor(() => buttonNamed(container, 'Not about Noor'))
    expect(history.links).toEqual([NOOR])
    expect(history.receipts).toHaveLength(2)
  })

  test('searches bounded pages of only the selected type, including beyond its first page', async () => {
    for (let i = 0; i < 40; i++) {
      server.state.nodes.push({
        id: 'person:extra-' + i,
        labels: ['Person'],
        properties: { name: 'Person ' + i },
        version: 1,
      })
      server.state.nodes.push({
        id: 'question:extra-' + i,
        labels: ['ResearchQuestion'],
        properties: { question: 'Question ' + i },
        version: 1,
      })
    }
    const later = 'Benchmark outside the first page'
    server.state.nodes.push({
      id: 'question:later',
      labels: ['ResearchQuestion'],
      properties: { question: later },
      version: 1,
    })
    const { container } = await mount()
    await openPicker(container)
    await waitFor(() => optionNamed('Avery Quinn'))
    expect(recordReads.length).toBeGreaterThan(0)
    expect(
      recordReads.every((read) => read.objectTypeId === FIXTURE_TYPE.person),
    ).toBe(true)
    for (const read of recordReads) {
      expect(read.input.limit).toBeLessThanOrEqual(20)
      expect(read.input.offset).toBeUndefined()
    }

    recordReads.length = 0
    const input = await chooseType(
      'Research questions',
      'Find a research question',
    )
    await waitFor(() => optionNamed('Question 0'))
    expect(optionNamed(later)).toBeUndefined()
    await enterSearch(input, 'outside')
    await waitFor(() => optionNamed(later))
    expect(recordReads.length).toBeGreaterThan(0)
    for (const read of recordReads) {
      expect(read.objectTypeId).toBe(RESEARCH_TYPE.object_type_id)
      expect(read.input.limit).toBeLessThanOrEqual(20)
      expect(read.input.offset).toBeUndefined()
    }
    expect(
      recordReads.some(
        (read) =>
          Array.isArray(read.input.filters) &&
          read.input.filters.some(
            (filter: { field_key: string; value: unknown }) =>
              filter.field_key === 'question' && filter.value === 'outside',
          ),
      ),
    ).toBe(true)
  })

  test('removes the old query results before the next debounced search runs', async () => {
    const { container } = await mount()
    const input = await openPicker(container)
    await waitFor(() => optionNamed('Avery Quinn'))
    const reads = recordReads.length
    await enterSearch(input, 'Nobody matches this')
    expect(optionNamed('Avery Quinn')).toBeUndefined()
    expect(recordReads).toHaveLength(reads)
    await waitFor(() => recordReads.length > reads)
    await waitFor(() =>
      document.body.textContent.includes('No matching records returned.'),
    )
    expect(optionNamed('Avery Quinn')).toBeUndefined()
    expect(writes).toEqual([])
  })

  test('switches cached queries even when their result timestamps are identical', async () => {
    const { container, client } = await mount()
    const updatedAt = Date.now() - 1000
    const cacheKey = (query: string) => [
      'theorem',
      'crm',
      'search',
      FIXTURE_TYPE.person,
      query,
    ]
    const cachedRecord = (id: string, name: string) => ({
      id,
      values: { name },
      relations: {},
      version: 1,
      labels: ['Person'],
    })
    client.setQueryData(
      cacheKey('Alpha'),
      [cachedRecord('person:alpha', 'Alpha result')],
      { updatedAt },
    )
    client.setQueryData(
      cacheKey('Beta'),
      [cachedRecord('person:beta', 'Beta result')],
      { updatedAt },
    )

    const input = await openPicker(container)
    await waitFor(() => optionNamed('Avery Quinn'))
    const reads = recordReads.length
    await enterSearch(input, 'Alpha')
    await waitFor(() => optionNamed('Alpha result'))
    expect(optionNamed('Beta result')).toBeUndefined()
    await enterSearch(input, 'Beta')
    expect(optionNamed('Alpha result')).toBeUndefined()
    await waitFor(() => optionNamed('Beta result'))
    expect(optionNamed('Alpha result')).toBeUndefined()
    // Both fresh cache entries were used; a new fetch did not mask the collision.
    expect(recordReads).toHaveLength(reads)
  })

  test('does not offer the previous type while the selected type is still loading', async () => {
    let release: () => void = () => undefined
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    readBarrier = (read) =>
      read.objectTypeId === RESEARCH_TYPE.object_type_id ? pending : undefined
    try {
      const { container } = await mount()
      await openPicker(container)
      await waitFor(() => optionNamed('Avery Quinn'))
      await chooseType('Research questions', 'Find a research question')
      await waitFor(() =>
        recordReads.some(
          (read) => read.objectTypeId === RESEARCH_TYPE.object_type_id,
        ),
      )
      expect(optionNamed('Avery Quinn')).toBeUndefined()
      expect(optionNamed(RESEARCH_RECORD.properties.question)).toBeUndefined()
      expect(writes).toEqual([])
      release()
      await waitFor(() => optionNamed(RESEARCH_RECORD.properties.question))
      expect(optionNamed('Avery Quinn')).toBeUndefined()
    } finally {
      release()
      readBarrier = undefined
    }
  })

  test('disables a known unreadable type and never searches it', async () => {
    server = createFixtureServer({ unreadable: ['organizations'] })
    crm = fixtureFetch(server)
    const { container, client } = await mount()
    await waitFor(() => !client.isFetching())
    await openPicker(container)
    const selector = await waitFor(() =>
      document.querySelector<HTMLElement>('[aria-label="Record type"]'),
    )
    await click(selector)
    const organization = await waitFor(() => optionNamed('Organizations'))
    expect(organization.getAttribute('aria-disabled')).toBe('true')
    await click(organization)
    expect(searchInput('Find a person')).toBeDefined()
    expect(
      recordReads.some(
        (read) => read.objectTypeId === FIXTURE_TYPE.organization,
      ),
    ).toBe(false)
    expect(writes).toEqual([])
  })

  test('reports a failed search and retries without treating it as an empty result', async () => {
    failRecordSearch = true
    const { container } = await mount()
    await openPicker(container)
    const alert = await waitFor(
      () =>
        [...document.querySelectorAll<HTMLElement>('[role="alert"]')].find(
          (element) => element.textContent.includes('could not be searched'),
        ),
      4000,
    )
    expect(document.body.textContent).not.toContain(
      'No matching records returned.',
    )
    expect(optionNamed('Avery Quinn')).toBeUndefined()
    failRecordSearch = false
    await click(buttonNamed(alert, 'Try again')!)
    await waitFor(() => optionNamed('Avery Quinn'))
    expect(
      recordReads.every((read) => read.objectTypeId === FIXTURE_TYPE.person),
    ).toBe(true)
    expect(writes).toEqual([])
  })

  test('shows nothing when the document is about no record', async () => {
    history = { ...history, receipts: [], links: [], corrections: [] }
    const { container } = await mount()
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)))
    expect(about(container)).toBeNull()
  })

  test('a failed read says so rather than showing no records', async () => {
    historyStatus = 503
    const { container } = await mount()
    const section = await waitFor(() => about(container), 4000)
    expect(section.textContent).toContain('could not be read')
  })

  test('a reply without its lists says so rather than breaking', async () => {
    history = { schema: 'theorem-document/2', documentId: 'd1' } as never
    const { container } = await mount()
    const section = await waitFor(() => about(container), 4000)
    expect(section.textContent).toContain('could not be read')
  })
})
