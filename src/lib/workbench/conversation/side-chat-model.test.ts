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
const { createSideChatModel } = await import('./side-chat-model')

afterAll(() => {
  void mock.module('@/lib/theorem/client', () => actualClient)
  void mock.module('@/lib/theorem/thread-origin', () => actualOrigin)
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
