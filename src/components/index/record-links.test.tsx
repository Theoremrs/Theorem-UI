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
import { createFixtureServer, fixtureFetch } from '@/components/crm/fixture'
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

let history: RecordFilingHistory
let writes: { path: string; body: Record<string, unknown> }[]
let historyStatus: number

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
  const crm = fixtureFetch(createFixtureServer())
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
        fromRecordItemId: 'record:Person/person:noor',
        toRecordItemId: body.recordItemId,
        actor: { kind: 'human', actorId: 'p' },
        generation: 2,
        undo: false,
        undone: false,
      }
      const moved = body.recordItemId
        ? receipt({
            receiptId: 'r2',
            recordItemId: body.recordItemId,
            recordId: body.recordItemId.split('/')[1]!,
            title: 'Avery Quinn',
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
    return crm(input, init)
  }) as typeof fetch
})
afterEach(async () => {
  await cleanup()
  window.fetch = realFetch
})

const mount = () =>
  mountAt('/index', () => <RecordLinks documentId={DOC} />)
const about = (container: HTMLElement) =>
  container.querySelector('section[aria-label="About"]')
const buttonNamed = (root: ParentNode, name: string) =>
  [...root.querySelectorAll('button')].find(
    (b) => b.textContent.trim() === name,
  )

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
    expect(undoableCorrection({ ...base, corrections: [b, a] })?.correctionId).toBe('b')
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
    const input = await waitFor(
      () =>
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
