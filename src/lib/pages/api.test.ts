// SOURCING: bun:test over the page client, with window.fetch stood in for a Theorem that serves
// /api/pages/v1 (the same stand-in as lib/capabilities/api.test.ts). What is proven is the client's
// own rules: the query a read sends, the headers a write carries, that the answer's page is parsed
// as a page file is, and how a refusal maps to "the vault moved on". The routes belong to Theorem.
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from 'bun:test'
import type { PageDocument } from '@/lib/modules/contract'
import {
  conflictRevision,
  pageHistory,
  pageOwner,
  patchPage,
  readPage,
  savePage,
} from './api'
import { PAGES, codes } from './contract'
import { fakeWorkspace } from '../../../test/workspace'
import { bootstrap } from '@/lib/theorem/client'

const happy = (
  window as unknown as { happyDOM: { setURL: (url: string) => void } }
).happyDOM
beforeAll(() => happy.setURL('http://localhost:3000/'))
afterAll(() => happy.setURL('about:blank'))

type Call = { method: string; url: URL; headers: Headers; body?: string }
let calls: Call[]
let answer: () => Response
const realFetch = window.fetch

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

const problem = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify({ type: 'about:blank', status, ...body }), {
    status,
    headers: { 'content-type': 'application/problem+json' },
  })

const page = (): PageDocument => ({
  schema: 'theorem.page/1',
  title: 'Desk',
  pinned: false,
  layout: {
    root: { props: {} },
    content: [{ type: 'theorem.text', props: { id: 'note', text: 'Hi' } }],
  },
})

const receipt = (revision: string) => ({
  path: 'Pages/Desk.page.json',
  entryId: 'vf_1',
  revision,
  page: page(),
  history: {
    path: 'Pages/Desk.page.json',
    revision,
    seq: 2,
    savedAtMs: 1,
    principal: 'user:owner',
    summary: 'patched',
    reason: 'patched',
  },
})

beforeEach(async () => {
  calls = []
  answer = () => json({})
  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : undefined
    const url = new URL(request ? request.url : String(input))
    const raw =
      init?.body ?? (request ? await request.clone().text() : undefined)
    calls.push({
      method: init?.method ?? request?.method ?? 'GET',
      url,
      headers: new Headers(init?.headers ?? request?.headers),
      body: typeof raw === 'string' ? raw : undefined,
    })
    if (url.pathname === '/api/chat/v1/bootstrap')
      return json({ schema: 'theorem.chat.bootstrap.v1', csrfToken: 'csrf' })
    return answer()
  }) as typeof fetch
  // The session is held across test files; this file's token is the one it serves.
  await bootstrap(true)
  calls = []
})
afterEach(() => {
  window.fetch = realFetch
})

test('a read names the page by its vault path and fills the document defaults', async () => {
  const { pinned: _pinned, ...stored } = page()
  answer = () =>
    json({
      path: 'Pages/A b.page.json',
      entryId: 'vf_1',
      revision: 'r1',
      page: stored,
    })
  const view = await readPage('Pages/A b.page.json')
  const sent = calls.at(-1)!
  expect(sent.method).toBe('GET')
  expect(sent.url.pathname).toBe(`${PAGES}/page`)
  expect(sent.url.searchParams.get('path')).toBe('Pages/A b.page.json')
  expect(sent.headers.has('X-CSRF-Token')).toBe(false)
  expect(view.revision).toBe('r1')
  expect(view.page.pinned).toBe(false)

  await pageHistory('Pages/A b.page.json', 7, 20).catch(() => undefined)
  const history = calls.at(-1)!.url
  expect(history.pathname).toBe(`${PAGES}/history`)
  expect(Object.fromEntries(history.searchParams)).toEqual({
    path: 'Pages/A b.page.json',
    cursor: '7',
    limit: '20',
  })
})

test('a write carries CSRF, an idempotency key and this page client id', async () => {
  answer = () => json(receipt('r2'))
  const stored = await patchPage({
    path: 'Pages/Desk.page.json',
    expectedRevision: 'r1',
    ops: [{ op: 'set_props', componentId: 'note', props: { text: 'Hello' } }],
  })
  const sent = calls.at(-1)!
  expect(sent.method).toBe('POST')
  expect(sent.url.pathname).toBe(`${PAGES}/patch`)
  expect(sent.headers.get('X-CSRF-Token')).toBe('csrf')
  expect(sent.headers.get('Idempotency-Key')).toBeTruthy()
  expect(sent.headers.get('X-Theorem-Client-Id')).toBeTruthy()
  expect(JSON.parse(sent.body!)).toEqual({
    path: 'Pages/Desk.page.json',
    expectedRevision: 'r1',
    ops: [{ op: 'set_props', componentId: 'note', props: { text: 'Hello' } }],
  })
  expect(stored.revision).toBe('r2')
})

test('a stale revision names the current one; a missing page is no revision', async () => {
  answer = () =>
    problem(409, { code: codes.REVISION_CONFLICT, currentRevision: 'r9' })
  const stale = await savePage({
    path: 'Pages/Desk.page.json',
    expectedRevision: 'r1',
    page: page(),
  }).catch((error: unknown) => error)
  expect(conflictRevision(stale)).toBe('r9')

  answer = () => problem(404, { code: codes.NOT_FOUND })
  const gone = await readPage('Pages/Desk.page.json').catch((e: unknown) => e)
  expect(conflictRevision(gone)).toBeNull()

  answer = () => problem(422, { code: codes.DOCUMENT_INVALID })
  const invalid = await readPage('Pages/Desk.page.json').catch(
    (e: unknown) => e,
  )
  expect(conflictRevision(invalid)).toBeUndefined()
})

test('only the Theorem vault has a page owner', () => {
  const desktop = fakeWorkspace({}).client
  expect(pageOwner(desktop)).toBeUndefined()
  const vault = {
    ...desktop,
    workspace: { ...desktop.workspace, id: 'theorem:owner' },
  }
  expect(pageOwner(vault)).toBeDefined()
})
