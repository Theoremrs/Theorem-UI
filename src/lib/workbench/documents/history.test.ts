// SOURCING: none — bun:test over ./history with a stub client in the shape of client.ide.history and the environment's stub host
import { describe, expect, test } from 'bun:test'
import { accepted, refused } from '../environment/result'
import type { Completion } from '../environment/result'
import {
  FakeLive,
  HttpError,
  op,
  stubHost,
  testEnvironment,
} from '../environment/test-host'
import { createHistory, HISTORY_LIMIT } from './history'

const ALL = ['history.list', 'history.preview', 'history.restore'].map((name) =>
  op(name),
)

async function setup(operations = ALL) {
  const host = stubHost(operations)
  /** Everything the host and the flush saw, in order. */
  const calls: string[] = []
  const requests: Record<string, unknown>[] = []
  const options: unknown[] = []
  const handlers = new Map<
    string,
    (request: Record<string, unknown>) => unknown
  >()
  const method =
    (name: string) =>
    async (request: Record<string, unknown>, extra?: unknown) => {
      calls.push(name)
      requests.push(request)
      options.push(extra)
      return handlers.get(name)?.(request) ?? {}
    }
  host.client = {
    ...host.client,
    ide: {
      workspace: host.client.ide.workspace,
      history: {
        list: method('history.list'),
        preview: method('history.preview'),
        restore: method('history.restore'),
      },
    },
  } as never
  const { environment } = testEnvironment(host, new FakeLive())
  await environment.settled()
  let flushAnswer: () => Completion<unknown> = () =>
    accepted({ workspaceId: 'w1', requestId: 'r' }, {})
  const history = createHistory(environment as never, {
    flush: async (document, { requestId }) => {
      calls.push(`flush:${document}`)
      return { ...flushAnswer(), requestId }
    },
  })
  return {
    history,
    calls,
    requests,
    options,
    on: (
      name: string,
      handler: (request: Record<string, unknown>) => unknown,
    ) => void handlers.set(name, handler),
    flushWith: (answer: () => Completion<unknown>) => (flushAnswer = answer),
  }
}

describe('history list', () => {
  test('lists the journal newest first, one entry per operation, as points', async () => {
    const { history, on, requests } = await setup()
    on('history.list', () => ({
      entries: [
        { operation_id: 'a', revision: 1 },
        { operation_id: 'c', revision: 3 },
        { operation_id: 'b', revision: 2 },
        { operation_id: 'a', revision: 4 },
      ],
    }))
    const done = await history.list('src/a.ts', { requestId: 'r1' })
    expect(done).toMatchObject({
      outcome: 'accepted',
      requestId: 'r1',
      value: {
        entries: [
          { point: 'a', revision: 4 },
          { point: 'c', revision: 3 },
          { point: 'b', revision: 2 },
        ],
      },
    })
    expect(requests[0]).toMatchObject({
      workspaceId: 'w1',
      'Idempotency-Key': 'r1',
      body: { resource_id: 'src/a.ts' },
    })
  })

  test('shows no more than the newest 50', async () => {
    const { history, on } = await setup()
    on('history.list', () => ({
      entries: Array.from({ length: HISTORY_LIMIT + 20 }, (_, i) => ({
        operation_id: `op${i}`,
        revision: i,
      })),
    }))
    const done = await history.list('a.ts')
    expect(done.outcome === 'accepted' && done.value.entries).toHaveLength(
      HISTORY_LIMIT,
    )
    expect(done.outcome === 'accepted' && done.value.entries[0]?.revision).toBe(
      HISTORY_LIMIT + 19,
    )
  })

  test('a file the journal does not know is the empty state, whether the host answers an empty list or a 404', async () => {
    const { history, on } = await setup()
    on('history.list', () => ({ entries: [] }))
    expect(await history.list('new.ts')).toMatchObject({
      outcome: 'accepted',
      value: { entries: [] },
    })
    on('history.list', () => {
      throw new HttpError(404, { code: 'unknown_resource' })
    })
    expect(await history.list('new.ts')).toMatchObject({
      outcome: 'accepted',
      value: { entries: [] },
    })
  })

  test('a host that fails is failed, not an empty list', async () => {
    const { history, on } = await setup()
    on('history.list', () => {
      throw new HttpError(500)
    })
    expect((await history.list('a.ts')).outcome).toBe('failed')
  })

  test('a document outside the workspace is refused without a call', async () => {
    const { history, calls } = await setup()
    expect(await history.list('../x')).toMatchObject({
      outcome: 'refused',
      code: 'outside_workspace',
    })
    expect(calls).toEqual([])
  })
})

describe('history preview', () => {
  test('answers the text at a point', async () => {
    const { history, on, requests } = await setup()
    on('history.preview', () => ({ text: 'old text' }))
    expect(await history.preview('a.ts', 'p1')).toMatchObject({
      outcome: 'accepted',
      value: { text: 'old text' },
    })
    expect(requests[0]?.body).toEqual({ point: 'p1', resource_id: 'a.ts' })
  })

  test('a point with no text is refused no_text', async () => {
    const { history, on } = await setup()
    on('history.preview', () => ({ text: null }))
    expect(await history.preview('a.ts', 'p1')).toMatchObject({
      outcome: 'refused',
      code: 'no_text',
    })
  })
})

describe('history restore', () => {
  test('flushes the document first, then sends the restore once with retries off', async () => {
    const { history, calls, requests, options } = await setup()
    const done = await history.restore('a.ts', 'p1', { requestId: 'r9' })
    expect(done).toMatchObject({
      outcome: 'accepted',
      requestId: 'r9',
      value: { point: 'p1' },
    })
    expect(calls).toEqual(['flush:a.ts', 'history.restore'])
    expect(requests[0]).toMatchObject({
      'Idempotency-Key': 'r9',
      body: { point: 'p1', resource_id: 'a.ts', workspace_id: 'w1' },
    })
    expect(options[0]).toEqual({ maxRetries: 0 })
  })

  for (const [name, answer] of [
    [
      'refused',
      () => refused({ workspaceId: 'w1', requestId: 'r' }, 'conflict', 'x'),
    ],
    [
      'uncertain',
      () =>
        ({
          workspaceId: 'w1',
          requestId: 'r',
          outcome: 'uncertain',
          reason: 'x',
        }) as Completion<never>,
    ],
    [
      'failed',
      () =>
        ({
          workspaceId: 'w1',
          requestId: 'r',
          outcome: 'failed',
          reason: 'x',
        }) as Completion<never>,
    ],
  ] as const) {
    test(`a flush that is ${name} refuses the restore as pending_edits and sends nothing`, async () => {
      const { history, calls, flushWith } = await setup()
      flushWith(answer)
      expect(
        await history.restore('a.ts', 'p1', { requestId: 'r9' }),
      ).toMatchObject({
        outcome: 'refused',
        code: 'pending_edits',
      })
      expect(calls).toEqual(['flush:a.ts'])
    })
  }

  test('a restore whose answer is lost is uncertain and is not sent again', async () => {
    const { history, calls, on } = await setup()
    on('history.restore', () => {
      throw new Error('socket closed')
    })
    const done = await history.restore('a.ts', 'p1', { requestId: 'r9' })
    expect(done.outcome).toBe('uncertain')
    expect(calls.filter((c) => c === 'history.restore')).toHaveLength(1)
  })

  test('a host that refuses the restore is refused with its code', async () => {
    const { history, on } = await setup()
    on('history.restore', () => {
      throw new HttpError(409, { code: 'point_unknown' })
    })
    expect(
      await history.restore('a.ts', 'p1', { requestId: 'r9' }),
    ).toMatchObject({
      outcome: 'refused',
      code: 'point_unknown',
    })
  })

  test('a host that does not list the history operations is refused unavailable, with no flush and no call', async () => {
    const { history, calls } = await setup([op('history.list')])
    expect(
      await history.restore('a.ts', 'p1', { requestId: 'r9' }),
    ).toMatchObject({
      outcome: 'refused',
      code: 'unavailable',
    })
    expect(await history.preview('a.ts', 'p1')).toMatchObject({
      code: 'unavailable',
    })
    expect(calls).toEqual([])
  })

  test('an operation listed as not usable is unavailable too', async () => {
    const { history, calls } = await setup([
      ...ALL.slice(0, 2),
      op('history.restore', { granted: false, reason: 'No grant' }),
    ])
    expect(
      await history.restore('a.ts', 'p1', { requestId: 'r9' }),
    ).toMatchObject({ code: 'unavailable' })
    expect(calls).toEqual([])
  })
})
