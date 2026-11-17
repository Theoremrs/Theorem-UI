// SOURCING: none — bun:test over ./port with a stub owner injected as the dependency
import { describe, expect, test } from 'bun:test'
import { createThreadsPort } from './port'

const listing = {
  projects: [],
  threads: [],
  asOfMs: 1,
}

function setup() {
  const calls: unknown[][] = []
  let push: ((next: typeof listing) => void) | undefined
  const done = <T>(value: T) => ({
    workspaceId: 'account',
    requestId: 'r',
    outcome: 'accepted' as const,
    value,
  })
  const port = createThreadsPort({
    list: async () => done(listing),
    create: async (...args) => {
      calls.push(['create', ...args])
      return done({ projectId: 'p', threadId: 'n' })
    },
    rename: async (...args) => {
      calls.push(['rename', ...args])
      return done(null)
    },
    archive: async (...args) => {
      calls.push(['archive', ...args])
      return done(null)
    },
    delete: async (...args) => {
      calls.push(['delete', ...args])
      return done(null)
    },
    markdown: async () => done({ text: '# T\n' }),
    subscribe: (listener) => {
      push = listener
      return () => {
        push = undefined
      }
    },
  })
  const perform = (kind: string, payload: unknown) =>
    port.perform(
      { id: 1, resource: { type: 'none' }, kind, payload } as never,
      'req',
    )
  return { perform, calls, port, push: (next: typeof listing) => push?.(next) }
}

describe('threads through the port', () => {
  test('each effect makes one owner call and answers with its data', async () => {
    const t = setup()
    expect(await t.perform('threadsList', {})).toEqual({
      outcome: 'accepted',
      value: { type: 'threads', ...listing },
    })
    expect(await t.perform('threadsCreate', { projectId: 'p' })).toEqual({
      outcome: 'accepted',
      value: { type: 'threadCreated', projectId: 'p', threadId: 'n' },
    })
    await t.perform('threadsRename', { threadId: 't', title: 'N' })
    await t.perform('threadsArchive', { threadId: 't', archived: true })
    await t.perform('threadsDelete', { threadId: 't' })
    expect(t.calls).toEqual([
      ['create', 'p'],
      ['rename', 't', 'N'],
      ['archive', 't', true],
      ['delete', 't'],
    ])
    expect(await t.perform('threadsMarkdown', { threadId: 't' })).toEqual({
      outcome: 'accepted',
      value: { type: 'threadMarkdown', text: '# T\n' },
    })
  })

  test('pin, tag, unread and retitle are refused as unsupported', async () => {
    const t = setup()
    for (const kind of [
      'threadsPin',
      'threadsTag',
      'threadsUnread',
      'threadsRetitle',
    ]) {
      expect(await t.perform(kind, { threadId: 't' })).toMatchObject({
        outcome: 'refused',
        code: 'unsupported',
      })
    }
    expect(t.calls).toEqual([])
  })

  test('the owner’s listing arrives as a threadsChanged message', () => {
    const t = setup()
    const heard: unknown[] = []
    const stop = t.port.subscribe!((message) => heard.push(message))
    t.push(listing)
    expect(heard).toEqual([{ type: 'threadsChanged', listing }])
    stop()
  })
})
