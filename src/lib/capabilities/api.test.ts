// SOURCING: bun:test over the typed client, with window.fetch stood in for a Theorem that serves
// /api/capabilities/v1 (the same shape as components/work/api.test.ts). What is proven here is the
// client's own rules: which headers a write carries, that an invocation key is chosen once and reused,
// that cursors are followed until the answer names none, and that a problem+json code reaches the
// state the UI shows. The routes themselves belong to Theorem; nothing here reaches it.
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
  author,
  describe as describeInstance,
  discover,
  isPermissionDenial,
  isRecordMissing,
  isReloadConflict,
  invoke,
  query,
  queryPages,
  readRecord,
  readRecordAnywhere,
  readReceipt,
  refusalCode,
  refusalMessage,
} from './api'
import { codes } from './contract'
import type { QueryResult } from './contract'
import {
  completedReceipt,
  describeResult,
  discoverResult,
  queryResult,
  row,
  trackerDefinition,
} from '@/components/capabilities/fixture'

const page = (
  window as unknown as { happyDOM: { setURL: (url: string) => void } }
).happyDOM
beforeAll(() => page.setURL('http://localhost:3000/'))
afterAll(() => page.setURL('about:blank'))

type Call = { method: string; path: string; headers: Headers; body?: string }
let calls: Call[]
let bootstraps: number
/** The tokens this file's bootstrap route handed out, in order. */
let served: string[]
/** The next invoke attempt answers a stale CSRF token, once. */
let staleCsrf: boolean
/** When set, `people` answers in pages of one filler row, and holds person-1 on the page at this cursor number. */
let longPeopleAt: number | undefined
const realFetch = window.fetch

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

const problem = (status: number, code: string, detail: string) =>
  new Response(
    JSON.stringify({
      type: 'about:blank',
      title: 'Refused',
      status,
      code,
      detail,
    }),
    { status, headers: { 'content-type': 'application/problem+json' } },
  )

const pages: QueryResult[] = [
  queryResult([row('rec-1', { title: 'Write the plan' }, 6)], {
    nextCursor: 'c2',
    total: 3,
    filtered: true,
  }),
  queryResult([row('rec-2', { title: 'Sketch the page' }, 3)], { total: 3 }),
]

/** What each collection's rows are, for an ad-hoc query (a locate-walk). */
const collectionRows: Record<string, QueryResult['records']> = {
  tasks: pages.flatMap((one) => one.records),
  people: [row('person-1', { name: 'Travis' }, 1)],
}

/** The record route's answer, by id. A record its context policy withholds is
 * refused exactly like one that was never there, so the fake has no other shape. */
const heldRows: Record<string, QueryResult['records'][number]> = {
  'rec-1': pages[0]!.records[0]!,
  'rec-2': pages[1]!.records[0]!,
  'person-1': collectionRows.people![0]!,
}

const bodyOf = (call: Call) =>
  JSON.parse(call.body ?? '{}') as Record<string, unknown>

beforeEach(() => {
  calls = []
  bootstraps = 0
  served = []
  staleCsrf = false
  longPeopleAt = undefined
  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : undefined
    const url = new URL(request ? request.url : String(input))
    const headers = new Headers(
      init?.headers ?? (request ? request.headers : undefined),
    )
    const method = init?.method ?? (request ? request.method : 'GET')
    const raw =
      init?.body ?? (request ? await request.clone().text() : undefined)
    calls.push({
      method,
      path: url.pathname,
      headers,
      body: typeof raw === 'string' ? raw : undefined,
    })

    if (url.pathname === '/api/chat/v1/bootstrap') {
      bootstraps++
      const token = `csrf-${bootstraps}`
      served.push(token)
      return json({
        schema: 'theorem.chat.bootstrap.v1',
        csrfToken: token,
      })
    }
    if (!url.pathname.startsWith(CAPABILITIES)) return json({}, 404)

    const segments = url.pathname.slice(CAPABILITIES.length + 1).split('/')
    if (segments[0] !== 'instances') return json({}, 404)
    const instanceId =
      segments[1] === undefined ? '' : decodeURIComponent(segments[1])
    const tail = segments[2]
    const sent = calls[calls.length - 1]!

    // The list route, and creating an instance.
    if (segments.length === 1)
      return method === 'GET'
        ? json(discoverResult())
        : json({ definitionId: 'capdef:new', instance: { instanceId } })
    // One instance: describe.
    if (segments.length === 2) return json(describeResult())

    switch (tail) {
      case 'query': {
        const asked = bodyOf(sent).cursor
        // An ad-hoc query over one collection: the page a locate-walk reads, by
        // collection. One page, no cursor: a collection that holds the record is
        // named by its rows, not by a walk of many pages.
        const collection = bodyOf(sent).query as
          { collectionKey?: string } | undefined
        if (
          collection?.collectionKey === 'people' &&
          longPeopleAt !== undefined
        ) {
          const at = asked ? Number(String(asked).slice(1)) : 0
          const held =
            at === longPeopleAt
              ? collectionRows.people!
              : [row(`filler-${at}`, { name: 'Someone' }, 1)]
          return json(
            queryResult(held, {
              nextCursor: at === longPeopleAt ? undefined : `p${at + 1}`,
            }),
          )
        }
        if (collection) {
          const held = collectionRows[collection.collectionKey ?? ''] ?? []
          return json(queryResult(held, { total: held.length }))
        }
        // A server that answers the same cursor it was given: the walk must stop
        // rather than read the same page for ever.
        if (bodyOf(sent).viewKey === 'echo')
          return json({ ...pages[0]!, nextCursor: asked ?? 'c2' })
        const at = asked === 'c2' ? 1 : 0
        return json(pages[at]!)
      }
      case 'records': {
        // One record, read by id. Absent, and a record its context policy
        // withholds from this caller, are the same refusal: the route never
        // discloses which.
        const wanted = decodeURIComponent(segments[3] ?? '')
        const found = heldRows[wanted]
        // Absent and withheld are the same refusal: the route never discloses
        // which it was.
        if (!found)
          return problem(404, codes.RECORD_NOT_FOUND, 'No such record.')
        return json(found)
      }
      case 'invoke': {
        if (staleCsrf) {
          staleCsrf = false
          return problem(
            403,
            'csrf_token_invalid',
            'The session token was stale.',
          )
        }
        const body = bodyOf(sent)
        return json({
          ...completedReceipt(String(body.actionKey), [
            { id: String(body.recordId ?? 'rec-new'), revision: 7 },
          ]),
          invocationKey: body.invocationKey,
          instanceId,
        })
      }
      case 'invocations':
        return json(
          completedReceipt('complete', [{ id: 'rec-1', revision: 7 }]),
        )
      case 'author': {
        const body = bodyOf(sent)
        if (body.expectedDefinitionId === 'capdef:denied')
          return problem(
            403,
            codes.AUTHOR_DENIED,
            'This caller may not author it.',
          )
        if (body.expectedDefinitionId !== 'capdef:abc')
          return problem(
            409,
            codes.DEFINITION_CONFLICT,
            'A newer definition is pinned.',
          )
        return json({
          definitionId: 'capdef:def',
          instance: { instanceId, definitionId: 'capdef:def' },
        })
      }
      case 'repin':
        return json({ definitionId: 'capdef:abc', instance: { instanceId } })
      default:
        return json({}, 404)
    }
  }) as typeof fetch
})

afterEach(() => {
  window.fetch = realFetch
})

test('discover and describe are reads of the instance routes', async () => {
  const found = await discover()
  expect(found.instances[0]?.instanceId).toBe('tracker/main')
  const described = await describeInstance('tracker/main')
  expect(described.definition.name).toBe('Project tracker')
  expect(described.callerGrant.author).toBe(true)
  expect(described.collectionSchemas.map((one) => one.collectionKey)).toEqual([
    'tasks',
    'people',
  ])
  expect(calls.map((call) => [call.method, call.path])).toEqual([
    ['GET', `${CAPABILITIES}/instances`],
    // The id carries a slash, and the route names it as one segment.
    ['GET', `${CAPABILITIES}/instances/tracker%2Fmain`],
  ])
})

test('a query is a POST that carries CSRF and omits its absent options', async () => {
  const answer = await query({ instanceId: 'tracker/main', viewKey: 'next' })
  expect(answer.records.map((one) => one.id)).toEqual(['rec-1'])
  expect(answer.filtered).toBe(true)
  const sent = calls.filter((call) => call.path.endsWith('/query'))[0]!
  expect(sent.method).toBe('POST')
  // A token is on the write; where it came from is the stale-session test's
  // business, and the memo may have been seeded by another file's bootstrap.
  expect(sent.headers.get('X-CSRF-Token')).toBeTruthy()
  expect(sent.headers.get('Idempotency-Key')).toBeTruthy()
  expect(JSON.parse(sent.body!)).toEqual({
    instanceId: 'tracker/main',
    viewKey: 'next',
  })
})

test('an invoke names its idempotency key in the body and the header', async () => {
  const receipt = await invoke({
    instanceId: 'tracker/main',
    actionKey: 'complete',
    recordId: 'rec-1',
    expectedRevision: 6,
    inputs: {},
  })
  expect(receipt.status).toBe('finished')
  const sent = calls.filter((call) => call.path.endsWith('/invoke'))[0]!
  const body = JSON.parse(sent.body!) as Record<string, unknown>
  expect(sent.headers.get('Idempotency-Key')).toBe(body.invocationKey as string)
  expect(body).toEqual({
    instanceId: 'tracker/main',
    actionKey: 'complete',
    invocationKey: expect.any(String),
    recordId: 'rec-1',
    expectedRevision: 6,
    inputs: {},
  })
})

test('a caller-named key is reused, so a retried click stays one invocation', async () => {
  const call = {
    instanceId: 'tracker/main',
    actionKey: 'complete',
    recordId: 'rec-1',
    expectedRevision: 6,
    inputs: {},
    invocationKey: 'key-fixed',
  }
  await invoke(call)
  await invoke(call)
  const sent = calls.filter((one) => one.path.endsWith('/invoke'))
  expect(sent.length).toBe(2)
  expect(sent.map((one) => one.headers.get('Idempotency-Key'))).toEqual([
    'key-fixed',
    'key-fixed',
  ])
  expect(JSON.parse(sent[1]!.body!).invocationKey).toBe('key-fixed')
})

test('a stale session re-bootstraps and retries with the same key', async () => {
  staleCsrf = true
  const before = bootstraps
  const receipt = await invoke({
    instanceId: 'tracker/main',
    actionKey: 'complete',
    recordId: 'rec-1',
    expectedRevision: 6,
    inputs: {},
  })
  const sent = calls.filter((one) => one.path.endsWith('/invoke'))
  expect(sent.length).toBe(2)
  // One intended call: the same idempotency key on both attempts.
  expect(sent[0]!.headers.get('Idempotency-Key')).toBe(
    sent[1]!.headers.get('Idempotency-Key'),
  )
  // The retry went through a fresh session bootstrap, and carries a token that
  // bootstrap served. How many bootstraps this run needs depends on whether an
  // earlier call already seeded the module's memo, so the rule is "at least one
  // more, and one it served" rather than an exact count or token.
  expect(bootstraps).toBeGreaterThan(before)
  const retried = sent[1]!.headers.get('X-CSRF-Token')
  if (retried === null) throw new Error('the retry carried no CSRF token')
  expect(served).toContain(retried)
  expect(receipt.status).toBe('finished')
})

test('a stored receipt is read back by its journal id', async () => {
  const receipt = await readReceipt('tracker/main', 'capop:abc')
  expect(receipt.status).toBe('finished')
  // A stored receipt that has finished carries its outcome.
  if (receipt.status !== 'finished')
    throw new Error('expected a finished receipt')
  expect(receipt.outcome.outcome).toBe('completed')
  expect(calls[0]).toMatchObject({
    method: 'GET',
    path: `${CAPABILITIES}/instances/tracker%2Fmain/invocations/capop%3Aabc`,
  })
})

test('cursors are followed until the answer names none', async () => {
  const seen: string[][] = []
  for await (const answer of queryPages({
    instanceId: 'tracker/main',
    viewKey: 'next',
  }))
    seen.push(answer.records.map((one) => one.id))
  expect(seen).toEqual([['rec-1'], ['rec-2']])
  expect(
    calls
      .filter((one) => one.path.endsWith('/query'))
      .map((one) => JSON.parse(one.body!).cursor),
  ).toEqual([undefined, 'c2'])
})

test('a server that echoes its cursor is not walked in a loop', async () => {
  const seen: number[] = []
  for await (const answer of queryPages({
    instanceId: 'tracker/main',
    viewKey: 'echo',
  }))
    seen.push(answer.records.length)
  expect(seen).toEqual([1, 1])
})

test('one record is read by id, and named absent when it is not there', async () => {
  const found = await readRecord('tracker/main', 'rec-2')
  expect(found.revision).toBe(3)
  const sent = calls.filter((one) => one.path.endsWith('/records/rec-2'))[0]!
  expect(sent.method).toBe('GET')
  // The instance id carries a slash and the record id is one segment: both are
  // encoded, and the route is a read (no CSRF, no idempotency key).
  expect(sent.path).toBe(
    `${CAPABILITIES}/instances/tracker%2Fmain/records/rec-2`,
  )
  expect(sent.headers.get('X-CSRF-Token')).toBeNull()
  // A direct read asks for nothing else: no page of the collection is walked.
  expect(calls.filter((one) => one.path.endsWith('/query')).length).toBe(0)

  const missing = await readRecordAnywhere(
    'tracker/main',
    trackerDefinition,
    'rec-nope',
    'tasks',
  )
  expect(missing).toBeUndefined()
})

test('a record the context policy withholds is refused as absent, not as denied', async () => {
  // The route folds both into one code, so the caller cannot tell which it was.
  const refusal = await readRecord('tracker/main', 'rec-private').catch(
    (error: unknown) => error,
  )
  expect(refusalCode(refusal)).toBe(codes.RECORD_NOT_FOUND)
  expect(isRecordMissing(refusal)).toBe(true)
  expect(isPermissionDenial(refusal)).toBe(false)
  expect(refusalMessage(refusal, 'This record')).toContain(
    'not here for you to read',
  )
  // A module showing it says "not here" rather than treating it as a failure.
  const shown = await readRecordAnywhere(
    'tracker/main',
    trackerDefinition,
    'rec-private',
    'tasks',
  )
  expect(shown).toBeUndefined()
})

test('with no collection named, the record’s own collection is located first', async () => {
  const found = await readRecordAnywhere(
    'tracker/main',
    trackerDefinition,
    'person-1',
  )
  // The walk stops at the collection that holds it, and the row comes from the
  // record route on both paths.
  expect(found?.kind).toBe('found')
  if (found?.kind !== 'found') throw new Error('not found')
  expect(found.collectionKey).toBe('people')
  expect(found.row.fields).toEqual({ name: 'Travis' })
  const walked = calls
    .filter((one) => one.path.endsWith('/query'))
    .map(
      (one) =>
        (one.body ? bodyOf(one).query : undefined) as
          { collectionKey?: string } | undefined,
    )
  expect(walked.map((one) => one?.collectionKey)).toEqual(['tasks', 'people'])
  expect(calls.some((one) => one.path.endsWith('/records/person-1'))).toBe(true)
})

test('a walk the page bound cuts short is incomplete, and resumes where it stopped', async () => {
  longPeopleAt = 25
  const first = await readRecordAnywhere(
    'tracker/main',
    trackerDefinition,
    'person-1',
  )
  // Twenty pages of people did not reach it: that is "not looked at yet",
  // never "not there".
  expect(first).toEqual({
    kind: 'incomplete',
    row: collectionRows.people![0]!,
    resume: { people: 'p20' },
  })
  calls = []
  const resumed = await readRecordAnywhere(
    'tracker/main',
    trackerDefinition,
    'person-1',
    undefined,
    first?.kind === 'incomplete' ? first.resume : undefined,
  )
  expect(resumed).toMatchObject({ kind: 'found', collectionKey: 'people' })
  // The resumed walk reads only the collection that was cut, from its cursor.
  const walked = calls
    .filter((one) => one.path.endsWith('/query'))
    .map((one) => bodyOf(one))
  expect(walked[0]).toMatchObject({
    query: { collectionKey: 'people' },
    cursor: 'p20',
  })
  expect(walked.length).toBe(6)
})

test('a stale definition base is a reload-and-retry state, not a permission state', async () => {
  const refusal = await author('tracker/main', {
    expectedDefinitionId: 'capdef:old',
    ops: [],
  }).catch((error: unknown) => error)
  expect(refusalCode(refusal)).toBe(codes.DEFINITION_CONFLICT)
  expect(isReloadConflict(refusal)).toBe(true)
  expect(isPermissionDenial(refusal)).toBe(false)
  expect(refusalMessage(refusal, 'Authoring')).toContain(
    'check your change against the current one',
  )
})

test('a refusal the grant does not reach is a permission state', async () => {
  const refusal = await author('tracker/main', {
    expectedDefinitionId: 'capdef:denied',
    ops: [],
  }).catch((error: unknown) => error)
  expect(refusalCode(refusal)).toBe(codes.AUTHOR_DENIED)
  expect(isPermissionDenial(refusal)).toBe(true)
  expect(isReloadConflict(refusal)).toBe(false)
  expect(refusalMessage(refusal, 'Authoring')).toBe(
    "You do not have permission to change this capability's definition.",
  )
})

test('an author patch reaches the route with its ops tagged', async () => {
  const result = await author('tracker/main', {
    expectedDefinitionId: 'capdef:abc',
    ops: [
      {
        op: 'add_field',
        collectionKey: 'tasks',
        field: {
          key: 'notes',
          label: 'Notes',
          fieldType: { kind: 'text' },
          required: false,
        },
      },
    ],
  })
  expect(result.definitionId).toBe('capdef:def')
  const sent = calls.filter((one) => one.path.endsWith('/author'))[0]!
  expect(JSON.parse(sent.body!)).toEqual({
    expectedDefinitionId: 'capdef:abc',
    ops: [
      {
        op: 'add_field',
        collectionKey: 'tasks',
        field: {
          key: 'notes',
          label: 'Notes',
          fieldType: { kind: 'text' },
          required: false,
        },
      },
    ],
  })
  expect(sent.headers.get('X-CSRF-Token')).toBeTruthy()
})
