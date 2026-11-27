import { afterEach, expect, test } from 'bun:test'
import { hasStatus } from './client'
import type { ModelRequestList, ModelRequestSummary } from './model-requests'
import {
  capturedJson,
  modelRequestsQuery,
  readModelRequest,
  readModelRequests,
  requestSections,
} from './model-requests'

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

const summary: ModelRequestSummary = {
  requestId: 'request-1',
  sequence: 27,
  provider: 'deepseek',
  model: 'deepseek-chat',
  capturedAtMs: 1_000,
  bodyBytes: 300,
  capturedBytes: 250,
  bodyHash: 'sha256:original',
  completeness: 'redacted',
  capturePoint: 'before_send',
  exclusions: [
    {
      path: '/messages/1/reasoning_content',
      reason: 'opaque provider continuation',
    },
  ],
  messageCount: 2,
  toolCount: 1,
}

function answer(body: unknown, status = 200) {
  const paths: string[] = []
  globalThis.fetch = ((input: RequestInfo | URL) => {
    paths.push(String(input))
    return Promise.resolve(Response.json(body, { status }))
  }) as typeof fetch
  return paths
}

const list: ModelRequestList = {
  schema: 'theorem.chat.model-requests/v1',
  runId: 'run-1',
  terminal: true,
  captureStatus: 'recorded',
  notRecordedReason: null,
  requests: [summary],
  nextAfterSeq: 27,
  hasMore: false,
}

test('request metadata uses the owner-authorized native chat route and preserves exclusions', async () => {
  const paths = answer({ ...list, runId: 'run/1' })
  const found = await readModelRequests('run/1', 20)
  expect(paths).toEqual([
    '/api/chat/v1/runs/run%2F1/model-requests?afterSeq=20&limit=100',
  ])
  expect(found.requests[0]?.sequence).toBe(27)
  expect(found.requests[0]?.completeness).toBe('redacted')
  expect(found.requests[0]?.exclusions).toEqual([...summary.exclusions])
})

test('request bodies are fetched separately and keep unknown provider fields', async () => {
  const body = {
    input: [{ role: 'user', content: 'Hello' }],
    custom_field: { enabled: true },
  }
  const paths = answer({
    schema: 'theorem.chat.model-request/v1',
    runId: 'run-1',
    request: { ...summary, requestId: 'request/1' },
    body,
  })
  expect((await readModelRequest('run-1', 'request/1')).body).toEqual(body)
  expect(paths).toEqual(['/api/chat/v1/runs/run-1/model-requests/request%2F1'])
})

test('an older run remains explicitly unrecorded', async () => {
  answer({
    ...list,
    captureStatus: 'not_recorded',
    requests: [],
    notRecordedReason: 'This turn predates capture.',
  })
  const found = await readModelRequests('run-1')
  expect(found.captureStatus).toBe('not_recorded')
  expect(found.requests).toEqual([])
  expect(found.notRecordedReason).toBe('This turn predates capture.')
})

test('denial and an incompatible response are errors rather than empty capture lists', async () => {
  answer({ error: { message: 'Forbidden' } }, 403)
  try {
    await readModelRequests('run-1')
    throw new Error('expected refusal')
  } catch (error) {
    expect(hasStatus(error, 403)).toBe(true)
  }
  answer({ requests: [] })
  await expect(readModelRequests('run-1')).rejects.toThrow(
    'unreadable request capture',
  )
})

test('pagination uses event position without interpreting it as call number', () => {
  const options = modelRequestsQuery('run-1')
  expect(options.initialPageParam).toBe(0)
  const next = options.getNextPageParam
  expect(
    next(
      { ...list, requests: [], hasMore: true, nextAfterSeq: 391 },
      [],
      0,
      [],
    ),
  ).toBe(391)
  expect(next({ ...list, hasMore: false }, [], 0, [])).toBeUndefined()
})

test('readable sections preserve all body fields and raw JSON preserves their values', () => {
  const body = {
    model: 'deepseek-chat',
    messages: [{ role: 'system', content: 'One\nTwo' }],
    tools: [{ type: 'function', function: { name: 'read' } }],
    system: 'Shared',
    response_format: { type: 'json' },
  }
  const sections = requestSections(body)
  expect(sections.map((section) => section.name)).toEqual([
    'System',
    'Messages',
    'Tool declarations',
    'Request settings and other fields',
  ])
  expect(sections.at(-1)?.value).toEqual({
    model: 'deepseek-chat',
    response_format: { type: 'json' },
  })
  expect(JSON.parse(capturedJson(body))).toEqual(body)
  expect(requestSections('raw')).toEqual([
    { name: 'Request body', value: 'raw', kind: 'json' },
  ])
})

test('missing bodies, mismatched identities and nonadvancing pages cannot appear as captures', async () => {
  answer({
    schema: 'theorem.chat.model-request/v1',
    runId: 'run-1',
    request: summary,
  })
  await expect(readModelRequest('run-1', 'request-1')).rejects.toThrow(
    'unreadable request capture',
  )
  answer({
    schema: 'theorem.chat.model-request/v1',
    runId: 'run-2',
    request: summary,
    body: {},
  })
  await expect(readModelRequest('run-1', 'request-1')).rejects.toThrow(
    'different request',
  )
  answer({ ...list, runId: 'run-2' })
  await expect(readModelRequests('run-1')).rejects.toThrow('different turn')
  answer({ ...list, hasMore: true, nextAfterSeq: 27 })
  await expect(readModelRequests('run-1', 27)).rejects.toThrow(
    'without a forward cursor',
  )
})
