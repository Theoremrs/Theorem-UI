// SOURCING: none — bun:test over ./search and ./port with a stub client in the shape of client.ide.search
import { describe, expect, test } from 'bun:test'
import {
  FakeLive,
  HttpError,
  op,
  stubHost,
  testEnvironment,
} from '../environment/test-host'
import type { Effect } from '../wire'
import { createSearchPort } from './port'
import { createSearch } from './search'
import type { SearchPage } from './search'

const ALL = ['search.query', 'search.cancel'].map((name) => op(name))

const row = (
  path: string,
  text = 'let x',
  ranges = [{ start: 4, end: 5 }],
) => ({
  kind: 'text',
  path,
  line: 3,
  text,
  ranges,
})

const request = {
  requestId: 'r1',
  query: 'x',
  regex: false,
  caseSensitive: true,
  wholeWord: false,
  limit: 50,
}

async function setup(operations = ALL) {
  const host = stubHost(operations)
  const calls: {
    name: string
    request: Record<string, unknown>
    options?: unknown
  }[] = []
  const handlers = new Map<
    string,
    (request: Record<string, unknown>) => unknown
  >()
  const search: Record<string, unknown> = {}
  for (const name of ['query', 'cancel']) {
    search[name] = async (body: Record<string, unknown>, options?: unknown) => {
      calls.push({ name, request: body, options })
      return handlers.get(name)?.(body) ?? {}
    }
  }
  host.client = {
    ...host.client,
    ide: { workspace: host.client.ide.workspace, search },
  } as never
  const { environment } = testEnvironment(host, new FakeLive())
  await environment.settled()
  const tasks: (() => void)[] = []
  const owner = createSearch(environment as never, {
    schedule: (task) => void tasks.push(task),
  })
  const pages: SearchPage[] = []
  owner.onPage((page) => void pages.push(page))
  return {
    host,
    environment,
    owner,
    pages,
    calls,
    count: (name: string) => calls.filter((call) => call.name === name).length,
    on: (
      name: string,
      handler: (request: Record<string, unknown>) => unknown,
    ) => void handlers.set(name, handler),
    /** Runs what the owner scheduled, then lets its reads settle. */
    async drain() {
      while (tasks.length > 0) tasks.shift()!()
      await new Promise((resolve) => setTimeout(resolve, 0))
    },
  }
}

describe('query', () => {
  test('sends the options as the host reads them and answers the id before any page', async () => {
    const { owner, calls, pages, on } = await setup()
    on('query', () => ({ id: 's1', complete: true, results: [row('a.ts')] }))
    const done = await owner.query({
      ...request,
      include: ['src/**', 'lib/**'],
      exclude: ['dist/**'],
    })
    expect(done).toMatchObject({ outcome: 'accepted', value: { id: 's1' } })
    expect(pages).toHaveLength(0)
    expect(calls[0]?.request).toMatchObject({
      'Idempotency-Key': 'r1',
      body: {
        query: 'x',
        view: 'text',
        regex: false,
        case_sensitive: true,
        whole_word: false,
        include: ['src/**', 'lib/**'],
        exclude: ['dist/**'],
        limit: 50,
      },
    })
  })

  test('delivers the rows with UTF-16 offsets, skips rows it does not read, and labels where they were read', async () => {
    const { owner, pages, drain, on } = await setup()
    on('query', () => ({
      id: 's1',
      complete: true,
      results: [
        row('a.ts', '😀 x', [{ start: 2, end: 3 }]),
        { kind: 'file', path: 'b.ts' },
      ],
    }))
    await owner.query(request)
    await drain()
    expect(pages).toEqual([
      {
        id: 's1',
        rows: [
          {
            path: 'a.ts',
            line: 3,
            text: '😀 x',
            matches: [{ start: 3, end: 4 }],
          },
        ],
        skipped: 1,
        state: 'complete',
        readAt: {
          workspaceId: 'w1',
          version: '1.2.3',
          epoch: 'e1',
          generation: 0,
        },
      },
    ])
  })

  test('an empty query, a bad limit and a missing capability are refused without a call', async () => {
    const { owner, calls } = await setup()
    expect(await owner.query({ ...request, query: '' })).toMatchObject({
      outcome: 'refused',
      code: 'empty_query',
    })
    expect(await owner.query({ ...request, limit: 0 })).toMatchObject({
      outcome: 'refused',
      code: 'bad_limit',
    })
    expect(calls).toHaveLength(0)
    const none = await setup([])
    expect(await none.owner.query(request)).toMatchObject({
      outcome: 'refused',
      code: 'missing_capability',
      reason: expect.stringContaining('search.query'),
    })
    expect(none.calls).toHaveLength(0)
  })

  test('a failed query is a failure and is asked once', async () => {
    const { owner, count, on } = await setup()
    on('query', () => {
      throw new HttpError(undefined)
    })
    expect((await owner.query(request)).outcome).toBe('failed')
    expect(count('query')).toBe(1)
  })
})

describe('paging', () => {
  test('follows the host page by page with the id and limit until it is complete', async () => {
    const { owner, pages, calls, drain, on } = await setup()
    let next = 0
    on('query', (body) => {
      if (!('id' in (body.body as object)))
        return { id: 's1', complete: false, results: [row('a.ts')] }
      next += 1
      return {
        id: 's1',
        complete: next === 2,
        results: [row(`p${next}.ts`)],
      }
    })
    await owner.query(request)
    await drain()
    expect(pages.map((page) => [page.rows[0]?.path, page.state])).toEqual([
      ['a.ts', 'more'],
      ['p1.ts', 'more'],
      ['p2.ts', 'complete'],
    ])
    expect(calls[1]?.request).toMatchObject({
      'Idempotency-Key': 'r1:1',
      body: { id: 's1', limit: 50 },
    })
  })

  test('a page the host fails to give ends the search with the reason', async () => {
    const { owner, pages, drain, on } = await setup()
    let first = true
    on('query', () => {
      if (first) {
        first = false
        return { id: 's1', complete: false, results: [] }
      }
      throw new HttpError(422, { code: 'bad_pattern' })
    })
    await owner.query(request)
    await drain()
    expect(pages.at(-1)).toMatchObject({
      state: 'ended',
      end: { outcome: 'refused', code: 'bad_pattern' },
    })
  })

  test('pages read after the workspace was reopened are dropped and counted', async () => {
    const { owner, pages, environment, host, drain, on } = await setup()
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    let first = true
    on('query', () => {
      if (first) {
        first = false
        return { id: 's1', complete: false, results: [row('a.ts')] }
      }
      return gate.then(() => ({
        id: 's1',
        complete: true,
        results: [row('b.ts')],
      }))
    })
    await owner.query(request)
    await drain()
    host.on('capabilities', () => ({
      schema: 'theorem-workspace-capabilities/1',
      workspace_id: 'w1',
      version: '1.2.3',
      epoch: 'e2',
      cursor: '0',
      granted_by: 'test-host',
      operations: ALL,
    }))
    await environment.reopen()
    release()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(pages.map((page) => page.rows[0]?.path)).toEqual(['a.ts'])
    expect(owner.dropped()).toBe(1)
  })
})

describe('cancel', () => {
  test('a cancelled search delivers nothing more, even for a page already on its way', async () => {
    const { owner, pages, calls, drain, on } = await setup()
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    let first = true
    on('query', () => {
      if (first) {
        first = false
        return { id: 's1', complete: false, results: [row('a.ts')] }
      }
      return gate.then(() => ({
        id: 's1',
        complete: true,
        results: [row('b.ts')],
      }))
    })
    await owner.query(request)
    await drain()
    expect(pages).toHaveLength(1)
    expect(await owner.cancel({ requestId: 'c1', id: 's1' })).toMatchObject({
      outcome: 'accepted',
      value: { id: 's1' },
    })
    release()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(pages).toHaveLength(1)
    expect(calls.find((call) => call.name === 'cancel')?.request).toMatchObject(
      {
        'Idempotency-Key': 'c1',
        body: { id: 's1' },
      },
    )
  })

  test('a search cancelled before its first page is delivered delivers none', async () => {
    const { owner, pages, drain, on } = await setup()
    on('query', () => ({ id: 's1', complete: true, results: [row('a.ts')] }))
    await owner.query(request)
    await owner.cancel({ requestId: 'c1', id: 's1' })
    await drain()
    expect(pages).toHaveLength(0)
  })

  test('without search.cancel the search still stops and the refusal names the operation', async () => {
    const { owner, pages, drain, calls, on } = await setup([op('search.query')])
    on('query', () => ({ id: 's1', complete: true, results: [row('a.ts')] }))
    await owner.query(request)
    expect(await owner.cancel({ requestId: 'c1', id: 's1' })).toMatchObject({
      outcome: 'refused',
      code: 'missing_capability',
      reason: expect.stringContaining('search.cancel'),
    })
    await drain()
    expect(pages).toHaveLength(0)
    expect(calls.map((call) => call.name)).toEqual(['query'])
  })

  test('a cancel with no answer is uncertain and is not sent again; one for a finished search is accepted without a call', async () => {
    const { owner, count, drain, on } = await setup()
    on('query', () => ({ id: 's1', complete: false, results: [] }))
    on('cancel', () => {
      throw new HttpError(undefined)
    })
    await owner.query(request)
    expect(await owner.cancel({ requestId: 'c1', id: 's1' })).toMatchObject({
      outcome: 'uncertain',
    })
    await drain()
    expect(count('cancel')).toBe(1)
    expect(await owner.cancel({ requestId: 'c2', id: 'gone' })).toMatchObject({
      outcome: 'accepted',
    })
    expect(count('cancel')).toBe(1)
  })
})

describe('the search port', () => {
  test('answers searchStarted and pushes pages as host messages', async () => {
    const { owner, drain, on } = await setup()
    on('query', () => ({ id: 's9', complete: true, results: [row('a.ts')] }))
    const port = createSearchPort(owner)
    const messages: unknown[] = []
    const stop = port.subscribe!((message) => void messages.push(message))
    const effect = {
      id: 1,
      resource: { type: 'workspace', workspace: 'w1' },
      kind: 'searchQuery',
      payload: {
        query: 'x',
        regex: false,
        caseSensitive: false,
        wholeWord: false,
        limit: 20,
      },
    } as unknown as Extract<Effect, { kind: 'searchQuery' }>
    expect(await port.perform(effect, 'q1')).toEqual({
      outcome: 'accepted',
      value: { type: 'searchStarted', id: 's9' },
    })
    await drain()
    expect(messages).toMatchObject([
      {
        type: 'searchPage',
        id: 's9',
        state: 'complete',
        readAt: { workspaceId: expect.any(String) },
      },
    ])
    stop()
  })

  test('searchCancel answers with no payload', async () => {
    const { owner } = await setup()
    const port = createSearchPort(owner)
    const effect = {
      id: 2,
      resource: { type: 'workspace', workspace: 'w1' },
      kind: 'searchCancel',
      payload: { id: 'nope' },
    } as unknown as Extract<Effect, { kind: 'searchCancel' }>
    expect(await port.perform(effect, 'q2')).toEqual({ outcome: 'accepted' })
  })
})
