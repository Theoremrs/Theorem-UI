// SOURCING: none — bun:test over ./side-chat-model with Theorem's client and thread origins replaced by recorders
import { afterAll, describe, expect, mock, test } from 'bun:test'

const actualClient = await import('@/lib/theorem/client')
const actualOrigin = await import('@/lib/theorem/thread-origin')

const created: Record<string, unknown>[] = []
const origins: unknown[] = []
void mock.module('@/lib/theorem/client', () => ({
  ...actualClient,
  mutate: async (run: (headers: object) => Promise<unknown>) => run({}),
  theorem: () => ({
    chat: {
      threads: {
        create: async (request: Record<string, unknown>) => {
          created.push(request)
          return { record: { threadId: `thread-${created.length}` } }
        },
      },
    },
  }),
}))
void mock.module('@/lib/theorem/thread-origin', () => ({
  ...actualOrigin,
  threadOriginFor: async (from: unknown) => {
    origins.push(from)
    return {
      projectId: 'source-project',
      origin: { kind: 'continued', threadId: 'main-thread' },
      title: undefined,
    }
  },
}))
const { createSideChatModel, detaching } = await import('./side-chat-model')

afterAll(() => {
  void mock.module('@/lib/theorem/client', () => actualClient)
  void mock.module('@/lib/theorem/thread-origin', () => actualOrigin)
})

describe('detaching', () => {
  test('a detach ends the read at once and keeps a later abort from reaching the run', async () => {
    const d = detaching()
    const outer = new AbortController()
    const signal = d.signal(outer.signal)
    let finished = false
    async function* run() {
      try {
        yield 1
        await new Promise(() => undefined)
        yield 2
      } finally {
        finished = true
      }
    }
    const seen: number[] = []
    const reading = (async () => {
      for await (const step of d.read(run())) seen.push(step)
    })()
    await Promise.resolve()
    d.detach()
    await reading
    outer.abort()
    expect(seen).toEqual([1])
    expect(signal.aborted).toBe(false)
    void finished
  })

  test('before a detach, a stop reaches the run', () => {
    const d = detaching()
    const outer = new AbortController()
    const signal = d.signal(outer.signal)
    outer.abort()
    expect(signal.aborted).toBe(true)
  })

  test('a reopened side chat makes no thread and names its own', async () => {
    created.length = 0
    const model = await createSideChatModel('p1', {
      scope: 'forked',
      from: 'main-thread',
      reopen: 'side-thread',
    })
    expect(created).toEqual([])
    expect(model.threadId()).toBe('side-thread')
  })
})

describe('side chat model', () => {
  test('a fresh side chat makes no thread until its first turn', async () => {
    created.length = 0
    const model = await createSideChatModel('p1', { scope: 'fresh' })
    expect(model.threadId()).toBeUndefined()
    expect(created).toEqual([])
    expect(origins).toEqual([])
  })

  test('a continued or forked side chat makes its thread now, from the main thread and with that origin', async () => {
    created.length = 0
    origins.length = 0
    const model = await createSideChatModel('p1', {
      scope: 'forked',
      from: 'main-thread',
    })
    expect(origins).toEqual([{ kind: 'forked', threadId: 'main-thread' }])
    expect(created).toHaveLength(1)
    expect(created[0]).toMatchObject({
      projectId: 'source-project',
      origin: { kind: 'continued', threadId: 'main-thread' },
    })
    expect(model.threadId()).toBe('thread-1')
  })
})
