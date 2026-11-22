// SOURCING: bun:test over the typed client's slice-2 calls, with window.fetch stood in for a Theorem
// that serves the run and module routes the plan pins (the same harness shape as api.test.ts). What
// is proven here is the client's own rules: reads carry no CSRF, writes carry it, a manual run names
// its Idempotency-Key once and reuses it after a stale session, and a slice-2 refusal code reaches
// the line the UI shows.
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
  listRuns,
  readModule,
  readRun,
  registerModule,
  retryRun,
  ruleRefusalMessage,
  runRuleNow,
} from './api'
import { codes, ruleCodes } from './contract'
import type { CapabilityModule, RuleRun } from './contract'

const page = (
  window as unknown as { happyDOM: { setURL: (url: string) => void } }
).happyDOM
beforeAll(() => page.setURL('http://localhost:3000/'))
afterAll(() => page.setURL('about:blank'))

type Call = {
  method: string
  path: string
  search: string
  headers: Headers
  body?: string
}
let calls: Call[]
let staleOnce: boolean
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

const run = (overrides: Partial<RuleRun> = {}): RuleRun =>
  ({
    runId: 'caprun:1',
    instanceId: 'tracker/main',
    ruleKey: 'nightly',
    definitionId: 'capdef:abc',
    trigger: { kind: 'manual', invocationKey: 'k-1' },
    runAs: 'user:travis',
    cause: { depth: 0, chain: [] },
    status: 'pending',
    attempts: [],
    nextAttemptAtMs: 0,
    createdAtMs: 10,
    ...overrides,
  }) as RuleRun

const moduleRecord: CapabilityModule = {
  moduleId: 'capmod:abc',
  language: 'wasm',
  source: { kind: 'wat', text: '(module)' },
  exports: ['score'],
}

beforeEach(() => {
  calls = []
  staleOnce = false
  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : undefined
    const url = new URL(
      request ? request.url : String(input),
      'http://localhost:3000',
    )
    const method = (init?.method ?? request?.method ?? 'GET').toUpperCase()
    const headers = new Headers(init?.headers ?? request?.headers)
    const body =
      typeof init?.body === 'string'
        ? init.body
        : request
          ? await request.clone().text()
          : undefined
    if (url.pathname === '/api/chat/v1/bootstrap')
      return json({ schema: 'theorem.chat.bootstrap.v1', csrfToken: 'csrf' })
    calls.push({
      method,
      path: url.pathname,
      search: url.search,
      headers,
      body,
    })
    const rest = url.pathname.slice(CAPABILITIES.length + 1).split('/')
    if (rest[0] === 'library' && rest[1] === 'modules') {
      if (method === 'POST') return json({ moduleId: 'capmod:abc' })
      if (decodeURIComponent(rest[2] ?? '') === 'capmod:abc')
        return json(moduleRecord)
      return problem(404, ruleCodes.MODULE_NOT_FOUND, 'no such module')
    }
    const instanceId = decodeURIComponent(rest[1] ?? '')
    if (rest[2] === 'runs' && rest.length === 3)
      return json({ runs: [run()], nextCursor: 'c2' })
    if (rest[2] === 'runs' && rest[4] === 'retry') {
      if (decodeURIComponent(rest[3] ?? '') === 'caprun:ok')
        return problem(409, ruleCodes.RUN_NOT_RETRYABLE, 'it succeeded')
      return json(run({ runId: decodeURIComponent(rest[3] ?? '') }))
    }
    if (rest[2] === 'runs')
      return json(run({ runId: decodeURIComponent(rest[3] ?? ''), instanceId }))
    if (rest[2] === 'rules' && rest[4] === 'run') {
      if (staleOnce) {
        staleOnce = false
        return problem(403, 'csrf_invalid', 'stale token')
      }
      const key = headers.get('Idempotency-Key') ?? ''
      return json(
        run({
          ruleKey: decodeURIComponent(rest[3] ?? ''),
          trigger: { kind: 'manual', invocationKey: key },
        }),
        202,
      )
    }
    return problem(404, codes.NOT_FOUND, 'not here')
  }) as typeof fetch
})

afterEach(() => {
  window.fetch = realFetch
})

test('the run list is a read: rule, cursor and limit ride as query parameters, no CSRF', async () => {
  const list = await listRuns('tracker/main', {
    ruleKey: 'nightly',
    cursor: 'c1',
    limit: 25,
  })
  expect(list.runs.map((one) => one.runId)).toEqual(['caprun:1'])
  expect(list.nextCursor).toBe('c2')
  const [call] = calls
  expect(call?.method).toBe('GET')
  expect(call?.path).toBe(`${CAPABILITIES}/instances/tracker%2Fmain/runs`)
  expect(new URLSearchParams(call?.search).toString()).toBe(
    'ruleKey=nightly&cursor=c1&limit=25',
  )
  expect(call?.headers.get('X-CSRF-Token')).toBeNull()

  await listRuns('tracker/main')
  expect(calls[1]?.search).toBe('')
})

test('one run is read by id', async () => {
  const one = await readRun('tracker/main', 'caprun:7')
  expect(one.runId).toBe('caprun:7')
  expect(calls[0]?.path).toBe(
    `${CAPABILITIES}/instances/tracker%2Fmain/runs/caprun%3A7`,
  )
})

test('a manual run sends an empty body and names its key once, even across a stale session', async () => {
  staleOnce = true
  const started = await runRuleNow('tracker/main', 'nightly', {
    invocationKey: 'click-1',
  })
  expect(started.trigger).toEqual({ kind: 'manual', invocationKey: 'click-1' })
  const posts = calls.filter((call) => call.method === 'POST')
  expect(posts).toHaveLength(2)
  for (const post of posts) {
    expect(post.path).toBe(
      `${CAPABILITIES}/instances/tracker%2Fmain/rules/nightly/run`,
    )
    expect(post.headers.get('Idempotency-Key')).toBe('click-1')
    expect(post.headers.get('X-CSRF-Token')).toBe('csrf')
    expect(JSON.parse(post.body ?? 'null')).toEqual({})
  }

  // With no key given, one is chosen.
  const fresh = await runRuleNow('tracker/main', 'nightly')
  expect(fresh.trigger.kind).toBe('manual')
  if (fresh.trigger.kind !== 'manual') throw new Error('unreachable')
  expect(fresh.trigger.invocationKey).not.toBe('')
})

test('a retry is a write with an empty body; a run that cannot be retried says so', async () => {
  const again = await retryRun('tracker/main', 'caprun:3')
  expect(again.runId).toBe('caprun:3')
  const [post] = calls
  expect(post?.method).toBe('POST')
  expect(post?.path).toBe(
    `${CAPABILITIES}/instances/tracker%2Fmain/runs/caprun%3A3/retry`,
  )
  expect(post?.headers.get('X-CSRF-Token')).toBe('csrf')
  expect(JSON.parse(post?.body ?? 'null')).toEqual({})

  const refused = await retryRun('tracker/main', 'caprun:ok').catch(
    (error: unknown) => error,
  )
  expect(ruleRefusalMessage(refused, 'Retry')).toBe(
    'Only a run whose last attempt failed can be retried.',
  )
})

test('a module is registered as a write and read back by id', async () => {
  const registered = await registerModule({
    source: { kind: 'wat', text: '(module)' },
    exports: ['score'],
  })
  expect(registered).toEqual({ moduleId: 'capmod:abc' })
  expect(calls[0]?.path).toBe(`${CAPABILITIES}/library/modules`)
  expect(calls[0]?.headers.get('X-CSRF-Token')).toBe('csrf')
  expect(JSON.parse(calls[0]?.body ?? 'null')).toEqual({
    source: { kind: 'wat', text: '(module)' },
    exports: ['score'],
  })

  expect(await readModule('capmod:abc')).toEqual(moduleRecord)
  const missing = await readModule('capmod:zzz').catch(
    (error: unknown) => error,
  )
  expect(ruleRefusalMessage(missing, 'Reading the module')).toBe(
    'That module is not in the library.',
  )
})

test('slice-1 codes still read as before through the slice-2 message', () => {
  const refused = new Error('refused') as Error & { body: unknown }
  refused.body = { code: codes.GRANT_DENIED }
  expect(ruleRefusalMessage(refused, 'Run now')).toBe(
    'You do not have permission to use this capability in that way.',
  )
  const loop = new Error('loop') as Error & { body: unknown }
  loop.body = { code: ruleCodes.RULE_LOOP }
  expect(ruleRefusalMessage(loop, 'Run now')).toBe(
    'Skipped: this rule is already part of the chain that started it, or the chain is too deep.',
  )
})
