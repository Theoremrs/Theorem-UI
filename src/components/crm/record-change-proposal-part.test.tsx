// SOURCING: bun:test rendering the `record_change_proposal` part with React into happy-dom, against a stand-in Theorem (the fixture's CRM plus the proposal and thread routes); the payload has the server's ProposalView shape
import { recordPageViewId } from '@/components/index/programs'
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
import { OpenDocumentProvider } from './context'
import { createFixtureServer, fixtureFetch } from './fixture'
import { decodeProposalPart, parseEvidence } from './proposal'
import {
  RecordChangeOutcomePart,
  RecordChangeProposalPart,
} from './record-change-proposal-part'
import { crmKeys } from './queries'
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
  expect(hrefs).toContain(
    `/index?view=${recordPageViewId('Commitment', 'commitment:materials')}`,
  )
  expect(hrefs).toContain(
    `/index?view=${recordPageViewId('Interaction', 'interaction:planning')}`,
  )
})

test('a change resting on filed documents quotes each, and its title opens the document', async () => {
  const opened: string[] = []
  const sources = [
    {
      documentId: 'doc:noor-note',
      title: 'Note from Noor',
      revision: { position: 3, contentDigest: 'sha256:abc' },
      quote: 'Her new phone is 555-0142',
    },
    // Without a quote it rests on nothing it can show, so it is left out.
    { documentId: 'doc:empty', title: 'Empty', quote: '' },
  ]
  current = { proposal: proposal({ sources }) }
  const { container } = await mountAt('/', () => (
    <OpenDocumentProvider value={(id) => void opened.push(id)}>
      <RecordChangeProposalPart
        {...({
          data: { proposal: proposal({ sources }) },
          name: 'theorem-record_change_proposal',
        } as PartProps)}
      />
    </OpenDocumentProvider>
  ))
  const list = container.querySelector('ul[aria-label="From documents"]')!
  const rows = [...list.querySelectorAll('li')]
  expect(rows).toHaveLength(1)
  expect(rows[0]!.querySelector('blockquote')!.textContent).toBe(
    'Her new phone is 555-0142',
  )
  expect(rows[0]!.textContent).toContain('revision 3')
  await click(button(container, 'Note from Noor'))
  expect(opened).toEqual(['doc:noor-note'])
})

test('outside an inspector a source links to its document in the Index', async () => {
  const sources = [
    {
      documentId: 'doc:noor-note',
      title: 'Note from Noor',
      quote: 'Her new phone',
    },
  ]
  current = { proposal: proposal({ sources }) }
  const { container } = await part({ proposal: proposal({ sources }) })
  const link = [...container.querySelectorAll('a')].find(
    (a) => a.textContent === 'Note from Noor',
  )!
  expect(decodeURIComponent(link.getAttribute('href')!)).toContain(
    'item=doc:noor-note',
  )
})

test('a change resting on nothing filed lists no documents', async () => {
  const { container } = await part({ proposal: proposal() })
  expect(container.querySelector('ul[aria-label="From documents"]')).toBeNull()
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

const taskProposal = (over: Record<string, unknown> = {}) =>
  proposal({
    fields: [{ key: 'task', label: 'Task', from: null, to: 'wi_materials' }],
    reason: 'You owe Noor the materials list.',
    evidence: [],
    action: {
      kind: 'task',
      title: 'Send Noor the materials list',
      details: 'Clay, glazes and kiln times.',
      work_item_id: 'wi_materials',
    },
    ...over,
  })

test('a proposed task shows the task, not its id, and says no task is made yet', async () => {
  current = { proposal: taskProposal() }
  const { container } = await part({ proposal: taskProposal() })
  expect(container.textContent).toContain('Proposed task for')
  const task = container.querySelector('[aria-label="Task"]')!
  expect(task.textContent).toContain('Send Noor the materials list')
  expect(task.textContent).toContain('Clay, glazes and kiln times.')
  expect(
    container.querySelector('ul[aria-label="Fields to change"]'),
  ).toBeNull()
  expect(container.textContent).not.toContain('wi_materials')
  expect(container.textContent).toContain(
    'Waiting for you. No task is made until you approve.',
  )
})

test('an approved task says which task was made and opens it in the work tracker', async () => {
  current = { proposal: taskProposal() }
  decision = {
    status: 201,
    body: {
      decision: 'approve',
      proposal: taskProposal({
        status: 'applied',
        applied: true,
        decision: {
          decision: 'approve',
          decided_at_ms: 5,
          before_revision: 9,
          after_revision: 10,
          result: {
            kind: 'task',
            workItemId: 'wi_materials',
            key: 'T-4',
            title: 'Send Noor the materials list',
          },
        },
      }),
    },
  }
  const { container } = await part({ proposal: taskProposal() })
  await click(button(container, 'Approve'))
  await waitFor(() =>
    container.textContent.includes('Added T-4 to your work tracker'),
  )
  const open = [...container.querySelectorAll('a')].find(
    (a) => a.textContent === 'Open T-4',
  )!
  expect(decodeURIComponent(open.getAttribute('href')!)).toBe(
    '/index?item=work:wi_materials',
  )
})

test('a refused task approval says no task was made, and a stale one that the commitment changed', async () => {
  const refused = (code: string, detail: string) =>
    taskProposal({
      status: 'refused',
      decision: {
        decision: 'approve',
        decided_at_ms: 5,
        before_revision: 9,
        after_revision: 10,
        refusal: { code, detail },
      },
    })
  current = {
    proposal: refused(
      'record_write_not_granted',
      'this request may not change commitments',
    ),
  }
  const { container } = await part({ proposal: taskProposal() })
  await waitFor(() =>
    container.textContent.includes(
      'No task was made: this request may not change commitments',
    ),
  )
  expect(container.textContent).not.toContain('Not applied')
  await cleanup()
  current = { proposal: refused('record_revision_stale', 'moved') }
  const stale = await part({ proposal: taskProposal() })
  await waitFor(() =>
    stale.container.textContent.includes(
      'Not applied: this commitment changed after it was proposed',
    ),
  )
})

test('a task proposal decodes its task and an approval its result', () => {
  const decoded = decodeProposalPart({ proposal: taskProposal() })!
  expect(decoded.task).toEqual({
    title: 'Send Noor the materials list',
    details: 'Clay, glazes and kiln times.',
    workItemId: 'wi_materials',
  })
  expect(decodeProposalPart({ proposal: proposal() })!.task).toBeUndefined()
})

const DRAFT_ID = 'note:draft-materials'
const draftProposal = (over: Record<string, unknown> = {}) =>
  proposal({
    fields: [{ key: 'draft', label: 'Draft', from: null, to: DRAFT_ID }],
    reason: 'You owe Noor the materials list by Friday.',
    evidence: [],
    action: {
      kind: 'message_draft',
      subject: 'Materials list for the workshop',
      body: 'Hi Noor,\n\nHere is the materials list: clay, glazes and kiln times.',
      to: { record_id: 'person:noor', title: 'Noor Rahman' },
      document_id: DRAFT_ID,
    },
    ...over,
  })

test('a proposed message draft shows who it is for and what it says, not its id, and that nothing is sent', async () => {
  current = { proposal: draftProposal() }
  const { container } = await part({ proposal: draftProposal() })
  expect(container.textContent).toContain('Proposed message draft for')
  const draft = container.querySelector('[aria-label="Message draft"]')!
  expect(draft.textContent).toContain('To Noor Rahman')
  expect(draft.textContent).toContain('Materials list for the workshop')
  expect(draft.textContent).toContain('clay, glazes and kiln times')
  expect(
    container.querySelector('ul[aria-label="Fields to change"]'),
  ).toBeNull()
  expect(container.textContent).not.toContain(DRAFT_ID)
  expect(container.textContent).toContain(
    'Waiting for you. Nothing is saved or sent until you approve.',
  )
})

test('an approved draft says where it was filed and that nothing was sent, and opens the draft', async () => {
  current = { proposal: draftProposal() }
  decision = {
    status: 201,
    body: {
      decision: 'approve',
      proposal: draftProposal({
        status: 'applied',
        applied: true,
        decision: {
          decision: 'approve',
          decided_at_ms: 5,
          before_revision: 9,
          after_revision: 10,
          result: {
            kind: 'message_draft',
            documentId: DRAFT_ID,
            title: 'Materials list for the workshop',
            filedTo: [
              {
                recordItemId: 'record:Commitment/commitment:materials',
                title: 'Send Noor the materials list',
              },
              {
                recordItemId: 'record:Person/person:noor',
                title: 'Noor Rahman',
              },
            ],
            sent: false,
          },
        },
      }),
    },
  }
  const { container } = await part({ proposal: draftProposal() })
  await click(button(container, 'Approve'))
  await waitFor(() =>
    container.textContent.includes(
      'Saved the draft \u201cMaterials list for the workshop\u201d and filed it to Send Noor the materials list and Noor Rahman. Nothing was sent.',
    ),
  )
  const open = [...container.querySelectorAll('a')].find(
    (a) => a.textContent === 'Open the draft',
  )!
  expect(decodeURIComponent(open.getAttribute('href')!)).toBe(
    `/index?item=${DRAFT_ID}`,
  )
})

test('a refused draft approval says no draft was saved', async () => {
  current = {
    proposal: draftProposal({
      status: 'refused',
      decision: {
        decision: 'approve',
        decided_at_ms: 5,
        before_revision: 9,
        after_revision: 10,
        refusal: {
          code: 'draft_no_longer_linked',
          detail: 'the commitment no longer names this draft',
        },
      },
    }),
  }
  const { container } = await part({ proposal: draftProposal() })
  await waitFor(() =>
    container.textContent.includes(
      'No draft was saved: the commitment no longer names this draft',
    ),
  )
})

test('a draft proposal decodes its draft and an approval the saved draft', () => {
  const decoded = decodeProposalPart({ proposal: draftProposal() })!
  expect(decoded.draft).toEqual({
    subject: 'Materials list for the workshop',
    body: 'Hi Noor,\n\nHere is the materials list: clay, glazes and kiln times.',
    to: { recordId: 'person:noor', title: 'Noor Rahman' },
    documentId: DRAFT_ID,
  })
  expect(decoded.task).toBeUndefined()
  expect(decodeProposalPart({ proposal: proposal() })!.draft).toBeUndefined()
  expect(
    decodeProposalPart({ proposal: taskProposal() })!.draft,
  ).toBeUndefined()
})

test("an approval makes the record's CRM and Records copies stale, so they are read again", async () => {
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
  const { container, client } = await part({ proposal: proposal() })
  const id = 'commitment:materials'
  const keys = [
    crmKeys.record(id),
    crmKeys.changes(id),
    crmKeys.records('type:commitment'),
    ['theorem', 'records', 'rows', 'Commitment'],
    ['theorem', 'records', 'record', id],
  ]
  for (const key of keys) client.setQueryData(key, { old: true })
  const stale = () =>
    keys.map((key) => client.getQueryState(key)!.isInvalidated)
  expect(stale()).toEqual(keys.map(() => false))

  await click(button(container, 'Approve'))
  await waitFor(() => container.textContent.includes('Saved at revision 10'))
  expect(stale()).toEqual(keys.map(() => true))
})
