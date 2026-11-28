import { expect, test } from 'bun:test'
import { TheoremClient, TheoremError } from '@theoremharness/sdk'
import { createTheoremChatAdapter } from '@theoremharness/sdk/assistant-ui'
import type { ChatModelRunOptions } from '@assistant-ui/react'
import { RefusedSend, createSendRecovery } from './send-recovery'

function storageFixture() {
  const values = new Map<string, string>()
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value)
    },
    removeItem: (key: string) => {
      values.delete(key)
    },
    values,
  }
}

const options = {
  messages: [
    {
      id: 'local-user',
      role: 'user',
      content: [{ type: 'text', text: 'Hello' }],
      attachments: [],
    },
  ],
  abortSignal: new AbortController().signal,
  runConfig: {},
} as unknown as ChatModelRunOptions

test('the real SDK adapter keeps a partial send replayable after reload', async () => {
  const storage = storageFixture()
  const requests: Request[] = []
  let failStart = true
  const transport = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      const path = new URL(request.url).pathname
      if (path.endsWith('/bootstrap'))
        return Response.json({ csrfToken: 'old-csrf' })
      if (path.endsWith('/threads/thread-1'))
        return Response.json({
          thread: { selectedBranchId: 'branch-1', revision: 1 },
          messages: [],
        })
      requests.push(request.clone())
      return failStart
        ? Response.json(
            {
              code: 'chat_run_start_pending',
              detail: 'temporarily unavailable',
            },
            { status: 503 },
          )
        : Response.json({ run: { runId: 'run-1' } }, { status: 201 })
    },
    { preconnect: fetch.preconnect },
  )
  const recovery = createSendRecovery(storage, transport)
  const client = new TheoremClient({
    baseUrl: 'https://example.test',
    auth: false,
    fetch: recovery.fetch,
    maxRetries: 0,
  })
  const adapter = createTheoremChatAdapter({ client, threadId: 'thread-1' })
  const consume = async () => {
    const result = adapter.run(options)
    if (!(Symbol.asyncIterator in result)) {
      await result
      return
    }
    for await (const _ of result) {
      /* consume */
    }
  }
  await expect(consume()).rejects.toThrow()
  expect(requests).toHaveLength(1)
  expect(recovery.has('thread-1')).toBe(true)
  expect([...storage.values.values()].join()).not.toContain('old-csrf')

  // A fresh recovery owner represents a browser reload. Keep the original
  // body, key and precondition, while refreshing only the session's CSRF.
  failStart = false
  const reloaded = createSendRecovery(storage, transport)
  expect(
    await reloaded.resume('thread-1', 'https://example.test', 'new-csrf'),
  ).toBe('run-1')
  expect(await requests[1]!.text()).toBe(await requests[0]!.text())
  expect(requests[1]!.headers.get('Idempotency-Key')).toBe(
    requests[0]!.headers.get('Idempotency-Key'),
  )
  expect(requests[1]!.headers.get('If-Match')).toBe('1')
  expect(requests[1]!.headers.get('X-CSRF-Token')).toBe('new-csrf')
  expect(reloaded.has('thread-1')).toBe(false)
})

test('recovery survives expired auth and refuses replacement text', async () => {
  const storage = storageFixture()
  let status = 503
  const transport = Object.assign(
    async () =>
      Response.json(
        {
          code:
            status === 503
              ? 'chat_run_start_pending'
              : 'authentication_required',
        },
        { status },
      ),
    { preconnect: fetch.preconnect },
  )
  const recovery = createSendRecovery(storage, transport)
  await recovery.fetch(
    'https://example.test/api/chat/v1/threads/thread-1/messages',
    {
      method: 'POST',
      headers: { 'Idempotency-Key': 'stable-key', 'If-Match': '1' },
      body: JSON.stringify({ text: 'Hello', branchId: 'branch-1' }),
    },
  )
  status = 401
  await expect(
    recovery.resume('thread-1', 'https://example.test', 'csrf'),
  ).rejects.toThrow()
  expect(recovery.has('thread-1')).toBe(true)
  await expect(
    recovery.resume('thread-1', 'https://example.test', 'csrf', 'Different'),
  ).rejects.toThrow('previous message')
})

test('definitive initial rejection clears the journal, network ambiguity retains it', async () => {
  const storage = storageFixture()
  let unavailable = false
  const transport = Object.assign(
    async () => {
      if (unavailable) throw new TypeError('Network disconnected')
      return Response.json({ code: 'chat_scope_required' }, { status: 403 })
    },
    { preconnect: fetch.preconnect },
  )
  const recovery = createSendRecovery(storage, transport)
  const send = () =>
    recovery.fetch(
      'https://example.test/api/chat/v1/threads/thread-1/messages',
      {
        method: 'POST',
        headers: { 'Idempotency-Key': 'stable-key', 'If-Match': '1' },
        body: JSON.stringify({ text: 'Hello', branchId: 'branch-1' }),
      },
    )
  await send()
  expect(recovery.has('thread-1')).toBe(false)
  unavailable = true
  await expect(send()).rejects.toThrow('Network disconnected')
  expect(recovery.has('thread-1')).toBe(true)
})

test('known precommit 503 allows a corrected send', async () => {
  const storage = storageFixture()
  const transport = Object.assign(
    async () =>
      Response.json({ code: 'chat_model_credential_missing' }, { status: 503 }),
    { preconnect: fetch.preconnect },
  )
  const recovery = createSendRecovery(storage, transport)
  await recovery.fetch(
    'https://example.test/api/chat/v1/threads/thread-1/messages',
    {
      method: 'POST',
      headers: { 'Idempotency-Key': 'stable-key', 'If-Match': '1' },
      body: JSON.stringify({ text: 'Hello', branchId: 'branch-1' }),
    },
  )
  expect(recovery.has('thread-1')).toBe(false)
})

test('aborting recovery preserves its identity for the next reload', async () => {
  const storage = storageFixture()
  let hang = false
  const transport = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      if (!hang)
        return Response.json(
          { code: 'chat_run_start_pending' },
          { status: 503 },
        )
      return new Promise<Response>((_, reject) => {
        request.signal.addEventListener(
          'abort',
          () => reject(request.signal.reason),
          { once: true },
        )
      })
    },
    { preconnect: fetch.preconnect },
  )
  const recovery = createSendRecovery(storage, transport)
  await recovery.fetch(
    'https://example.test/api/chat/v1/threads/thread-1/messages',
    {
      method: 'POST',
      headers: { 'Idempotency-Key': 'stable-key', 'If-Match': '1' },
      body: JSON.stringify({ text: 'Hello', branchId: 'branch-1' }),
    },
  )
  hang = true
  const controller = new AbortController()
  const pending = recovery.resume(
    'thread-1',
    'https://example.test',
    'csrf',
    undefined,
    controller.signal,
  )
  await new Promise((resolve) => setTimeout(resolve, 10))
  controller.abort()
  await expect(pending).rejects.toThrow()
  expect(recovery.has('thread-1')).toBe(true)
})

const sendHello = (recovery: ReturnType<typeof createSendRecovery>) =>
  recovery.fetch('https://example.test/api/chat/v1/threads/thread-1/messages', {
    method: 'POST',
    headers: { 'Idempotency-Key': 'stable-key', 'If-Match': '1' },
    body: JSON.stringify({ text: 'Hello', branchId: 'branch-1' }),
  })

const otherOperations = [
  ...Array.from({ length: 9 }, (_, index) => `kit.action${index}`),
  'app.check',
  'app.control',
  'workbench.read',
  'workbench.act',
  'ui.present',
  'ui.view',
].map((name) => ({ name }))
const faceOperations = ['face.read', 'face.perform', 'face.define'].map(
  (name) => ({ name }),
)
const capabilityTurn = {
  text: 'Ask about the selected record',
  branchId: 'branch-1',
  contextReferences: [{ location: { resource: { kind: 'capability' } } }],
  clientSurface: { revision: 7, capabilities: ['component:Chart'] },
  clientOperations: [...otherOperations, ...faceOperations],
}

const sendCapabilityTurn = (
  recovery: ReturnType<typeof createSendRecovery>,
  body = capabilityTurn,
) =>
  recovery.fetch('https://example.test/api/chat/v1/threads/thread-1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': 'stable-key',
      'If-Match': '1',
      'X-CSRF-Token': 'old-csrf',
    },
    body: JSON.stringify(body),
  })

test('a legacy surface refusal retries the same turn and persists its retry body', async () => {
  const storage = storageFixture()
  const received: Array<{ headers: Headers; body: unknown }> = []
  const transport = Object.assign(
    async (input: RequestInfo | URL) => {
      const request = new Request(input)
      received.push({ headers: request.headers, body: await request.json() })
      if (received.length === 1) {
        return Response.json(
          {
            code: 'invalid_chat_request',
            detail: 'unknown field `capabilities`, expected `revision`',
          },
          { status: 422 },
        )
      }
      if (received.length === 2) throw new TypeError('Network disconnected')
      return Response.json({ run: { runId: 'run-1' } }, { status: 201 })
    },
    { preconnect: fetch.preconnect },
  )
  await expect(
    sendCapabilityTurn(createSendRecovery(storage, transport)),
  ).rejects.toThrow('Network disconnected')

  const reloaded = createSendRecovery(storage, transport)
  expect(
    await reloaded.resume('thread-1', 'https://example.test', 'new-csrf'),
  ).toBe('run-1')
  const compatible = {
    ...capabilityTurn,
    clientSurface: { revision: 7 },
    clientOperations: otherOperations,
  }
  expect(received.map(({ body }) => body)).toEqual([
    capabilityTurn,
    compatible,
    compatible,
  ])
  expect(received.map(({ headers }) => headers.get('Idempotency-Key'))).toEqual(
    ['stable-key', 'stable-key', 'stable-key'],
  )
  expect(received.map(({ headers }) => headers.get('If-Match'))).toEqual([
    '1',
    '1',
    '1',
  ])
  expect(received.map(({ headers }) => headers.get('X-CSRF-Token'))).toEqual([
    'old-csrf',
    'old-csrf',
    'new-csrf',
  ])
  expect(reloaded.has('thread-1')).toBe(false)
})

test.each([
  [201, undefined],
  [422, 'unknown field `extra`, expected `revision`'],
])(
  'a %i turn without the legacy surface refusal is sent once',
  async (status, detail) => {
    const bodies: unknown[] = []
    const transport = Object.assign(
      async (input: RequestInfo | URL) => {
        bodies.push(await new Request(input).json())
        return status === 201
          ? Response.json({ run: { runId: 'run-1' } }, { status })
          : Response.json({ code: 'invalid_chat_request', detail }, { status })
      },
      { preconnect: fetch.preconnect },
    )
    const recovery = createSendRecovery(storageFixture(), transport)
    expect((await sendCapabilityTurn(recovery)).status).toBe(status)
    expect(bodies).toEqual([capabilityTurn])
    expect(recovery.has('thread-1')).toBe(false)
  },
)

test('a legacy refusal on replay does not rewrite an ambiguous original send', async () => {
  const bodies: unknown[] = []
  const transport = Object.assign(
    async (input: RequestInfo | URL) => {
      bodies.push(await new Request(input).json())
      if (bodies.length === 1) throw new TypeError('Network disconnected')
      return Response.json(
        {
          code: 'invalid_chat_request',
          detail: 'unknown field `capabilities`, expected `revision`',
        },
        { status: 422 },
      )
    },
    { preconnect: fetch.preconnect },
  )
  const recovery = createSendRecovery(storageFixture(), transport)
  await expect(sendCapabilityTurn(recovery)).rejects.toThrow(
    'Network disconnected',
  )
  await expect(
    recovery.resume('thread-1', 'https://example.test', 'csrf'),
  ).rejects.toBeInstanceOf(RefusedSend)
  expect(bodies).toEqual([capabilityTurn, capabilityTurn])
})

test.each([
  [
    'the complete face group fits when removed',
    [...otherOperations, ...faceOperations],
    true,
  ],
  [
    'only part of the face group is present',
    [...otherOperations, ...faceOperations.slice(1)],
    false,
  ],
  [
    'the remaining operations still exceed the limit',
    [
      ...otherOperations,
      ...faceOperations,
      { name: 'one.more' },
      { name: 'one.last' },
    ],
    false,
  ],
] as const)(
  'an operation limit refusal retries only when %s',
  async (_, operations, retry) => {
    const bodies: unknown[] = []
    const transport = Object.assign(
      async (input: RequestInfo | URL) => {
        bodies.push(await new Request(input).json())
        if (bodies.length > 1)
          return Response.json({ run: { runId: 'run-1' } }, { status: 201 })
        return Response.json(
          {
            code: 'client_operations_invalid',
            detail: 'at most 16 client operations may be declared',
          },
          { status: 422 },
        )
      },
      { preconnect: fetch.preconnect },
    )
    const recovery = createSendRecovery(storageFixture(), transport)
    const turn = { ...capabilityTurn, clientOperations: [...operations] }
    expect((await sendCapabilityTurn(recovery, turn)).status).toBe(
      retry ? 201 : 422,
    )
    expect(bodies).toEqual(
      retry ? [turn, { ...turn, clientOperations: otherOperations }] : [turn],
    )
  },
)

/** A send whose run did not start, so it stays saved; `answer` answers its replay. */
async function savedSend(answer: () => Response) {
  let reply = () =>
    Response.json({ code: 'chat_run_start_pending' }, { status: 503 })
  const recovery = createSendRecovery(
    storageFixture(),
    Object.assign(async () => reply(), { preconnect: fetch.preconnect }),
  )
  await sendHello(recovery)
  expect(recovery.has('thread-1')).toBe(true)
  reply = answer
  return recovery
}

const replayed = (recovery: ReturnType<typeof createSendRecovery>) =>
  recovery
    .resume('thread-1', 'https://example.test', 'csrf')
    .catch((error: unknown) => error)

test.each([
  [409, 'chat_revision_conflict'],
  [409, 'chat_idempotency_conflict'],
  [409, 'chat_turn_superseded'],
  [404, 'chat_resource_not_found'],
  [410, 'chat_retention_expired'],
  [422, 'invalid_chat_field'],
  [503, 'chat_model_credential_missing'],
])('a replay refused with %i %s ends the send', async (status, code) => {
  const recovery = await savedSend(() => Response.json({ code }, { status }))

  const error = await replayed(recovery)

  expect(error).toBeInstanceOf(RefusedSend)
  expect((error as RefusedSend).text).toBe('Hello')
  expect(recovery.has('thread-1')).toBe(false)
})

test.each([
  [401, 'authentication_required'],
  [403, 'csrf_token_refused'],
  [408, 'request_timeout'],
  [425, 'too_early'],
  [429, 'rate_limited'],
  [500, 'internal_error'],
  [422, 'chat_run_start_pending'],
  [503, 'chat_run_start_pending'],
])('a replay answered %i %s stays saved', async (status, code) => {
  const recovery = await savedSend(() => Response.json({ code }, { status }))

  const error = await replayed(recovery)

  expect(error).toBeInstanceOf(TheoremError)
  expect(error).not.toBeInstanceOf(RefusedSend)
  expect(recovery.has('thread-1')).toBe(true)
})

test('a 4xx that is not a Theorem problem says nothing about the send', async () => {
  const recovery = await savedSend(
    () => new Response('<h1>Not found</h1>', { status: 404 }),
  )

  const error = await replayed(recovery)

  expect(error).toBeInstanceOf(TheoremError)
  expect(error).not.toBeInstanceOf(RefusedSend)
  expect((error as TheoremError).statusCode).toBe(404)
  expect(recovery.has('thread-1')).toBe(true)
})

const modelCannotStart = () =>
  Response.json(
    {
      code: 'chat_run_start_pending',
      detail: 'chat_model_credential_missing: no key for this model',
    },
    { status: 503 },
  )

test('a replay whose model cannot start ends the send, whose message went in', async () => {
  const recovery = await savedSend(modelCannotStart)

  const error = await replayed(recovery)

  expect(error).toBeInstanceOf(TheoremError)
  expect(error).not.toBeInstanceOf(RefusedSend)
  expect(recovery.has('thread-1')).toBe(false)
})

test('a first send whose model cannot start leaves nothing saved', async () => {
  const recovery = createSendRecovery(
    storageFixture(),
    Object.assign(async () => modelCannotStart(), {
      preconnect: fetch.preconnect,
    }),
  )

  await sendHello(recovery)

  expect(recovery.has('thread-1')).toBe(false)
})

test('a refused text outlives a reload and is given back once', () => {
  const storage = storageFixture()
  const transport = Object.assign(async () => new Response(), {
    preconnect: fetch.preconnect,
  })
  createSendRecovery(storage, transport).holdRefused('thread-1', 'Hello')

  const reloaded = createSendRecovery(storage, transport)

  expect(reloaded.takeRefused('thread-2')).toBeUndefined()
  expect(reloaded.takeRefused('thread-1')).toBe('Hello')
  expect(reloaded.takeRefused('thread-1')).toBeUndefined()
})

test('two refused texts held for one thread are both kept', () => {
  const recovery = createSendRecovery(
    storageFixture(),
    Object.assign(async () => new Response(), { preconnect: fetch.preconnect }),
  )

  recovery.holdRefused('thread-1', 'First')
  recovery.holdRefused('thread-1', 'Second')

  expect(recovery.takeRefused('thread-1')).toBe('First\n\nSecond')
})
