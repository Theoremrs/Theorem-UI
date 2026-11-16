// SOURCING: bun:test rendering the `record_change_proposal` part with React into happy-dom, against a stand-in Theorem (the fixture's CRM plus the proposal and thread routes); the payload has the server's ProposalView shape
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from 'bun:test'
import type { ComponentProps } from 'react'
import { cleanup, click, waitFor } from '../../../test/blocks/render'
import { createFixtureServer, fixtureFetch } from './fixture'
import { decodeProposalPart, parseEvidence } from './proposal'
import {
  RecordChangeOutcomePart,
  RecordChangeProposalPart,
} from './record-change-proposal-part'
import { mountAt } from './test-harness'

const page = (
  window as unknown as { happyDOM: { setURL: (url: string) => void } }
).happyDOM
beforeAll(() => page.setURL('http://localhost:3000/'))
afterAll(() => page.setURL('about:blank'))

type Call = { method: string; path: string; headers: Headers; body?: string }
let calls: Call[]
/** What the stand-in answers: the GET of the proposal and the decision POST. */
let current: unknown
let decision: { status: number; body: unknown }
const realFetch = window.fetch

const proposal = (over: Record<string, unknown> = {}) => ({
  proposalId: 'proposal:1',
  threadId: 'thread:9',
  branchId: 'branch:1',
  runId: 'run:2',
  recordId: 'commitment:materials',
  objectTypeId: 'type:commitment',
  objectType: 'Commitment',
  baseRevision: 9,
  fields: [
    { key: 'due', label: 'Due', from: 'Wednesday', to: 'Friday' },
    { key: 'owed_to', label: 'Owed to', from: null, to: 'Noor' },
  ],
  reason: 'Noor said the kiln is free on Friday.',
  evidence: ['record:Interaction/interaction:planning@12'],
  status: 'pending_approval',
  applied: false,
  decision: null,
  createdAtMs: 1,
  ...over,
})

beforeEach(() => {
  calls = []
  current = { proposal: proposal() }
  decision = { status: 404, body: {} }
  const fixture = fixtureFetch(createFixtureServer())
  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(
      input instanceof Request ? input.url : String(input),
      'http://localhost:3000',
    )
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    )
    const method =
      init?.method ?? (input instanceof Request ? input.method : 'GET')
    const raw =
      init?.body ??
      (input instanceof Request ? await input.clone().text() : undefined)
    if (url.pathname.startsWith('/api/chat/v1/record-proposals/')) {
      calls.push({
        method,
        path: url.pathname,
        headers,
        body: typeof raw === 'string' ? raw : undefined,
      })
      if (method === 'POST')
        return Response.json(decision.body, { status: decision.status })
      return current === undefined
        ? Response.json({}, { status: 404 })
        : Response.json(current)
    }
    if (decodeURIComponent(url.pathname) === '/api/chat/v1/threads/thread:9')
      return Response.json({ thread: { threadId: 'thread:9', revision: 4 } })
    return fixture(input, init)
  }) as typeof fetch
})
afterEach(async () => {
  await cleanup()
  window.fetch = realFetch
})

type PartProps = ComponentProps<typeof RecordChangeProposalPart>
const part = (data: unknown) =>
  mountAt('/', () => (
    <RecordChangeProposalPart
      {...({ data, name: 'theorem-record_change_proposal' } as PartProps)}
    />
  ))

const button = (container: HTMLElement, name: string) =>
  [...container.querySelectorAll('button')].find(
    (b) => b.textContent === name,
  ) as HTMLButtonElement

test('pending, it shows each field as from to, the reason, and says nothing is saved yet', async () => {
  const { container } = await part({ proposal: proposal() })
  const rows = [
    ...container.querySelectorAll('ul[aria-label="Fields to change"] > li'),
  ]
  expect(rows).toHaveLength(2)
  expect(rows[0]!.textContent).toContain('Due')
  expect(rows[0]!.textContent).toContain('Wednesday')
  expect(rows[0]!.textContent).toContain('Friday')
  // An empty value is a dash, never "null".
  expect(rows[1]!.textContent).toContain('—')
  expect(rows[1]!.textContent).not.toContain('null')
  expect(container.textContent).toContain('Proposed change to')
  expect(container.textContent).toContain(
    'Noor said the kiln is free on Friday.',
  )
  expect(container.textContent).toContain(
    'Waiting for you. Nothing is saved until you approve.',
  )
  expect(button(container, 'Approve')).toBeTruthy()
  expect(button(container, 'Dismiss')).toBeTruthy()
})

test('it links to the record and to what the proposal rests on', async () => {
  const { container } = await part({ proposal: proposal() })
  const hrefs = [...container.querySelectorAll('a')].map((a) =>
    decodeURIComponent(a.getAttribute('href')!),
  )
  expect(hrefs).toContain('/crm/commitments/commitment:materials')
  expect(hrefs).toContain('/crm/interactions/interaction:planning')
})

test('approve sends the decision with the thread revision, CSRF and a fresh idempotency key', async () => {
  decision = {
    status: 201,
    body: {
      decision: 'approve',
      proposal: proposal({
        status: 'applied',
        applied: true,
        decision: {
          decision: 'approve',
          decided_at_ms: 5,
          before_revision: 9,
          after_revision: 10,
        },
      }),
    },
  }
  const { container } = await part({ proposal: proposal() })
  await click(button(container, 'Approve'))
  await waitFor(() => container.textContent.includes('Saved at revision 10'))
  const sent = calls.find((c) => c.method === 'POST')!
  expect(decodeURIComponent(sent.path)).toBe(
    '/api/chat/v1/record-proposals/proposal:1/decision',
  )
  expect(JSON.parse(sent.body!)).toEqual({ decision: 'approve' })
  expect(sent.headers.get('If-Match')).toBe('"4"')
  expect(sent.headers.get('X-CSRF-Token')).toBe('csrf')
  expect(sent.headers.get('Idempotency-Key')).toBeTruthy()
  expect(container.querySelector('button')).toBeNull()
})

test('a revision that moved on is refused and says the record keeps its values', async () => {
  decision = {
    status: 409,
    body: { code: 'record_revision_stale', title: 'Stale', detail: 'moved' },
  }
  const { container } = await part({ proposal: proposal() })
  // Once the decision is refused, the server reads back the refused proposal.
  current = {
    proposal: proposal({
      status: 'refused',
      decision: {
        decision: 'approve',
        decided_at_ms: 5,
        before_revision: 9,
        after_revision: null,
        current_revision: 11,
        refusal: { code: 'record_revision_stale', detail: 'moved' },
      },
    }),
  }
  await click(button(container, 'Approve'))
  await waitFor(() =>
    container.textContent.includes(
      'Not applied: this commitment changed after it was proposed, so it keeps its current values.',
    ),
  )
  expect(container.querySelector('button')).toBeNull()
  expect(container.querySelector('[role="alert"]')).toBeNull()
})

test('a failed decision shows an error and leaves the buttons to try again', async () => {
  decision = { status: 500, body: { title: 'The store is busy.' } }
  const { container } = await part({ proposal: proposal() })
  await click(button(container, 'Dismiss'))
  await waitFor(() => container.querySelector('[role="alert"]') !== null)
  expect(container.querySelector('[role="alert"]')!.textContent).toContain(
    'The store is busy.',
  )
  expect(button(container, 'Dismiss').disabled).toBe(false)
  expect(JSON.parse(calls.find((c) => c.method === 'POST')!.body!)).toEqual({
    decision: 'dismiss',
  })
})

test('the current state replaces the snapshot; where the server has none, the snapshot stays', async () => {
  current = {
    proposal: proposal({
      status: 'dismissed',
      decision: { decision: 'dismiss', decided_at_ms: 5, before_revision: 9 },
    }),
  }
  const settled = await part({ proposal: proposal() })
  await waitFor(() =>
    settled.container.textContent.includes("won't propose this again"),
  )
  expect(settled.container.querySelector('button')).toBeNull()
  await cleanup()

  current = undefined
  const kept = await part({ proposal: proposal() })
  expect(button(kept.container, 'Approve')).toBeTruthy()
})

test('another refusal is shown with its own detail', async () => {
  current = {
    proposal: proposal({
      status: 'refused',
      decision: {
        decision: 'approve',
        decided_at_ms: 5,
        before_revision: 9,
        refusal: { code: 'field_invalid', detail: 'Due is not a date.' },
      },
    }),
  }
  const { container } = await part({ proposal: proposal() })
  await waitFor(() =>
    container.textContent.includes('Not applied: Due is not a date.'),
  )
})

test('an evidence reference splits the revision off the last @ only when it is digits', () => {
  expect(parseEvidence('record:Interaction/interaction:planning@12')).toEqual({
    objectType: 'Interaction',
    recordId: 'interaction:planning',
    revision: 12,
  })
  expect(parseEvidence('record:Person/mail@example.com@3')).toEqual({
    objectType: 'Person',
    recordId: 'mail@example.com',
    revision: 3,
  })
  expect(parseEvidence('record:Person/mail@example.com')).toEqual({
    objectType: 'Person',
    recordId: 'mail@example.com',
    revision: undefined,
  })
  expect(parseEvidence('web:something')).toBeUndefined()
})

test('a payload that is not a proposal draws nothing, and the outcome part draws nothing', async () => {
  expect(decodeProposalPart({ proposal: { status: 'nope' } })).toBeUndefined()
  const none = await part({ nothing: true })
  expect(none.container.textContent).toBe('')
  await cleanup()
  const outcome = await mountAt('/', () => (
    <RecordChangeOutcomePart
      {...({
        data: { proposalId: 'proposal:1' },
        name: 'theorem-record_change_outcome',
      } as ComponentProps<typeof RecordChangeOutcomePart>)}
    />
  ))
  expect(outcome.container.textContent).toBe('')
})
