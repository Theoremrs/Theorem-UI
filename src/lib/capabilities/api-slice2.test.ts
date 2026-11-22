// SOURCING: bun:test over the slice-2 calls of the typed client, with window.fetch stood in for a
// Theorem that serves /api/capabilities/v1 the way api.test.ts stands one in. What is proven here is
// the client's side of the pinned wire (docs/plans/user-authored-capabilities/README.md, "Slice 2"):
// which route each call reaches, which headers a write carries, the body it sends, and that a
// multi-target call names every record at the revision on screen and nothing else.
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from 'bun:test'
import {
  CAPABILITIES,
  history,
  instantiateTemplate,
  invokeTargets,
  listTemplates,
  readTemplate,
  refusalMessage,
  repin,
  saveTemplate,
} from './api'
import { INVOKE_TARGETS_MAX, codes } from './contract'
import type {
  CapabilityTemplate,
  DefinitionHistory,
  InvocationReceipt,
  PatchOp,
} from './contract'
import {
  instance,
  row,
  trackerDefinition,
} from '@/components/capabilities/fixture'

const page = (
  window as unknown as { happyDOM: { setURL: (url: string) => void } }
).happyDOM
beforeAll(() => page.setURL('http://localhost:3000/'))
afterAll(() => page.setURL('about:blank'))

type Call = { method: string; url: URL; headers: Headers; body?: unknown }
let calls: Call[]
const realFetch = window.fetch

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

const template: CapabilityTemplate = {
  templateId: 'captpl:abc',
  name: 'Tracker',
  description: 'Tasks with a lifecycle',
  definition: trackerDefinition,
  declareTypes: [],
  sourceDefinitionId: 'capdef:abc',
  requirements: { modules: [] },
  savedBy: 'user:travis',
  savedAtMs: 10,
}

const historyAnswer: DefinitionHistory = {
  instanceId: 'tracker/main',
  currentDefinitionId: 'capdef:new',
  entries: [
    {
      seq: 2,
      definitionId: 'capdef:new',
      previousDefinitionId: 'capdef:abc',
      reason: 'authored',
      principal: 'user:travis',
      atMs: 20,
      ops: ['add_field'],
    },
    {
      seq: 1,
      definitionId: 'capdef:abc',
      reason: 'created',
      principal: 'user:travis',
      atMs: 10,
      ops: [],
    },
  ],
  nextCursor: 'h2',
}

beforeEach(() => {
  calls = []
  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : undefined
    const url = new URL(request ? request.url : String(input))
    const headers = new Headers(
      init?.headers ?? (request ? request.headers : undefined),
    )
    const method = init?.method ?? (request ? request.method : 'GET')
    const raw =
      init?.body ?? (request ? await request.clone().text() : undefined)
    const body = raw ? (JSON.parse(String(raw)) as unknown) : undefined
    calls.push({ method, url, headers, body })
    if (url.pathname === '/api/chat/v1/bootstrap')
      return json({ schema: 'theorem.chat.bootstrap.v1', csrfToken: 'csrf' })
    const tail = url.pathname.slice(CAPABILITIES.length + 1)
    if (tail.endsWith('/history')) return json(historyAnswer)
    if (tail === 'library/templates' && method === 'GET')
      return json({ templates: [template] })
    if (tail === 'library/templates') return json(template, 201)
    if (tail === `library/templates/${encodeURIComponent('captpl:abc')}`)
      return json(template)
    if (tail.endsWith('/instantiate'))
      return json(
        { definitionId: 'capdef:copy', instance: instance('capdef:copy') },
        201,
      )
    if (tail.endsWith('/repin'))
      return json({ definitionId: 'capdef:abc', instance: instance() })
    if (tail.endsWith('/invoke'))
      return json({
        recordId: 'capop:many',
        invocationKey: (body as { invocationKey: string }).invocationKey,
        instanceId: 'tracker/main',
        actionKey: 'complete',
        definitionId: 'capdef:abc',
        requestDigest: 'sha256:abc',
        startedAtMs: 1,
        status: 'finished',
        outcome: {
          outcome: 'completed',
          affected: [
            { id: 'rec-1', revision: 7 },
            { id: 'rec-2', revision: 4 },
          ],
          fields: {},
          records: [
            { id: 'rec-1', fields: { status: 'done' } },
            { id: 'rec-2', fields: { status: 'done' } },
          ],
        },
        finishedAtMs: 2,
      } satisfies InvocationReceipt)
    return json({}, 404)
  }) as typeof fetch
})

afterEach(() => {
  window.fetch = realFetch
})

const writes = () => calls.filter((call) => call.method === 'POST')

test('definition history is a read of the instance route, its cursor and limit in the query', async () => {
  const answer = await history('tracker/main', { cursor: 'h1', limit: 20 })
  expect(answer).toEqual(historyAnswer)
  const [call] = calls
  expect(call!.method).toBe('GET')
  expect(call!.url.pathname).toBe(
    `${CAPABILITIES}/instances/${encodeURIComponent('tracker/main')}/history`,
  )
  expect(call!.url.searchParams.get('cursor')).toBe('h1')
  expect(call!.url.searchParams.get('limit')).toBe('20')
  // A read carries no CSRF token and no idempotency key.
  expect(call!.headers.get('X-CSRF-Token')).toBeNull()

  // With nothing asked for, the query names nothing.
  await history('tracker/main')
  expect(calls.at(-1)!.url.search).toBe('')
})

test('a re-pin names the older definition and nothing about records', async () => {
  await repin('tracker/main', { definitionId: 'capdef:abc' })
  const [sent] = writes()
  expect(sent!.url.pathname).toBe(
    `${CAPABILITIES}/instances/${encodeURIComponent('tracker/main')}/repin`,
  )
  expect(sent!.body).toEqual({ definitionId: 'capdef:abc' })
  expect(sent!.headers.get('X-CSRF-Token')).toBe('csrf')
})

test('templates are library objects: save, list, read and instantiate', async () => {
  const saved = await saveTemplate({
    instanceId: 'tracker/main',
    name: 'Tracker',
    description: 'Tasks with a lifecycle',
  })
  expect(saved.templateId).toBe('captpl:abc')
  const save = writes()[0]!
  expect(save.url.pathname).toBe(`${CAPABILITIES}/library/templates`)
  // The request names the instance and the words, never records or grants.
  expect(save.body).toEqual({
    instanceId: 'tracker/main',
    name: 'Tracker',
    description: 'Tasks with a lifecycle',
  })
  expect(save.headers.get('Idempotency-Key')).toBeTruthy()

  expect((await listTemplates()).templates.map((one) => one.templateId)).toEqual(
    ['captpl:abc'],
  )
  expect((await readTemplate('captpl:abc')).name).toBe('Tracker')

  const made = await instantiateTemplate('captpl:abc', {
    instanceId: 'tracker/copy',
  })
  expect(made.definitionId).toBe('capdef:copy')
  const instantiate = writes().at(-1)!
  expect(instantiate.url.pathname).toBe(
    `${CAPABILITIES}/library/templates/${encodeURIComponent('captpl:abc')}/instantiate`,
  )
  expect(instantiate.body).toEqual({ instanceId: 'tracker/copy' })
  expect(instantiate.headers.get('X-CSRF-Token')).toBe('csrf')
})

test('a multi-target call names every record at its revision, and no single record', async () => {
  const receipt = await invokeTargets({
    instanceId: 'tracker/main',
    actionKey: 'complete',
    rows: [row('rec-1', {}, 6), row('rec-2', {}, 3)],
    inputs: {},
  })
  const sent = writes()[0]!
  expect(sent.body).toEqual({
    instanceId: 'tracker/main',
    actionKey: 'complete',
    invocationKey: expect.any(String),
    targets: [
      { recordId: 'rec-1', expectedRevision: 6 },
      { recordId: 'rec-2', expectedRevision: 3 },
    ],
    inputs: {},
  })
  // The key rides as the header too, so one click is one invocation.
  expect(sent.headers.get('Idempotency-Key')).toBe(
    (sent.body as { invocationKey: string }).invocationKey,
  )
  expect(receipt.status === 'finished' && receipt.outcome).toMatchObject({
    outcome: 'completed',
    records: [
      { id: 'rec-1', fields: { status: 'done' } },
      { id: 'rec-2', fields: { status: 'done' } },
    ],
  })
})

test('more targets than one call may name are refused before anything is sent', async () => {
  const many = Array.from({ length: INVOKE_TARGETS_MAX + 1 }, (_, at) =>
    row(`rec-${at}`, {}, 1),
  )
  await expect(
    invokeTargets({
      instanceId: 'tracker/main',
      actionKey: 'complete',
      rows: many,
      inputs: {},
    }),
  ).rejects.toThrow(`at most ${INVOKE_TARGETS_MAX}`)
  await expect(
    invokeTargets({
      instanceId: 'tracker/main',
      actionKey: 'complete',
      rows: [],
      inputs: {},
    }),
  ).rejects.toThrow('at least one')
  expect(writes().length).toBe(0)
})

test('the slice-2 patch ops are tagged in snake_case with camelCase fields', () => {
  const ops: PatchOp[] = [
    { op: 'remove_view', viewKey: 'next' },
    {
      op: 'add_enum_variant',
      collectionKey: 'tasks',
      fieldKey: 'status',
      variant: 'blocked',
    },
    { op: 'set_lifecycle', collectionKey: 'tasks', lifecycle: null },
    { op: 'set_agent', agent: { discoverable: false, description: '' } },
  ]
  expect(JSON.parse(JSON.stringify(ops))).toEqual([
    { op: 'remove_view', viewKey: 'next' },
    {
      op: 'add_enum_variant',
      collectionKey: 'tasks',
      fieldKey: 'status',
      variant: 'blocked',
    },
    // A clear is an explicit null, which the Rust reads as None.
    { op: 'set_lifecycle', collectionKey: 'tasks', lifecycle: null },
    { op: 'set_agent', agent: { discoverable: false, description: '' } },
  ])
})

test('a missing template says so', () => {
  const error = { body: { code: codes.TEMPLATE_NOT_FOUND } }
  expect(refusalMessage(error, 'The template')).toBe(
    'That template is not there: it was never saved, or it is not yours to read.',
  )
})
