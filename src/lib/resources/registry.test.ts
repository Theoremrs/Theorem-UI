// SOURCING: bun:test over the provider registry and its facade (./registry) with in-memory providers, and the first-slice provider factories (./providers) with fake clients. No network.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  registerContribution,
  useContributions,
} from '@/lib/contributions/registry'
import { installBackend } from './backend'
import { ProviderError } from './provider'
import type { ResourceProvider, SearchPage } from './provider'
import { recordsProvider, threadsProvider, workProvider } from './providers'
import {
  canonicalKey,
  coverageOf,
  listProviders,
  open,
  preview,
  references,
  registerOpenHost,
  registerProvider,
  resolve,
  sameResource,
  search,
  searchMore,
  useResourceProviders,
} from './registry'
import { publicState, stateOfError } from './state'
import type { ResourceRef } from './types'

const reset = () => {
  useResourceProviders.setState({ providers: new Map() })
  useContributions.setState({ contributions: new Map(), conflicts: [] })
}
beforeEach(reset)
afterEach(reset)

const doc = (documentId: string): ResourceRef => ({
  resource: { kind: 'document', documentId },
})

const page = (
  titles: string[],
  extra: Partial<SearchPage> = {},
): SearchPage => ({
  hits: titles.map((title) => ({
    ref: doc(title),
    title,
    typeLabel: 'Document',
  })),
  ...extra,
})

const fake = (
  id: string,
  serves: string[],
  over: Partial<ResourceProvider> = {},
): ResourceProvider => ({ id, label: id, serves, support: {}, ...over })

describe('provider registry', () => {
  test('refuses a provider whose declared support disagrees with what it supplies', () => {
    expect(() =>
      registerProvider(fake('acme.a', ['x.y'], { support: { search: true } })),
    ).toThrow(ProviderError)
    expect(() =>
      registerProvider(
        fake('acme.b', ['x.y'], { search: async () => page([]) }),
      ),
    ).toThrow(ProviderError)
  })

  test('refuses an id another provider holds and removes only its own registration', () => {
    const first = registerProvider(fake('acme.one', ['acme.thing']))
    expect(() => registerProvider(fake('acme.one', ['acme.other']))).toThrow()
    expect(listProviders()).toHaveLength(1)
    first()
    expect(listProviders()).toHaveLength(0)
  })

  test('an unsupported operation is explicit, never filled from another provider', async () => {
    registerProvider(
      fake('acme.docs', ['document'], {
        support: { resolve: true },
        resolve: async () => ({
          state: 'ready',
          meta: { title: 'A', typeLabel: 'Doc', actions: [] },
        }),
      }),
    )
    expect(await preview(doc('a'))).toEqual({
      state: 'unsupported',
      operation: 'preview',
    })
    expect(await references(doc('a'), { direction: 'incoming' })).toEqual({
      state: 'unsupported',
      operation: 'references',
    })
    // No provider serves a thread, and no backend route is installed.
    expect(
      await resolve({ resource: { kind: 'thread', threadId: 't' } }),
    ).toMatchObject({ state: 'unsupported' })
  })

  test('the backend adapter answers where a route is installed', async () => {
    const remove = installBackend({
      resolve: async () => ({
        state: 'ready',
        meta: { title: 'From backend', typeLabel: 'Thread', actions: [] },
      }),
    })
    const answer = await resolve({
      resource: { kind: 'thread', threadId: 't' },
    })
    expect(answer).toMatchObject({ state: 'ready' })
    remove()
    expect(
      await resolve({ resource: { kind: 'thread', threadId: 't' } }),
    ).toMatchObject({ state: 'unsupported' })
  })

  test('owner failures become distinct states, and none reads as ready', async () => {
    const failing = (status?: number, offline = false) =>
      registerProvider(
        fake(
          `acme.f${status ?? 'x'}${offline ? 'o' : ''}`,
          [`acme.k${status ?? 'x'}${offline ? 'o' : ''}`],
          {
            support: { resolve: true },
            resolve: async () => {
              throw offline
                ? new TypeError('Failed to fetch')
                : Object.assign(new Error('no'), { status })
            },
          },
        ),
      )
    const ext = (kind: string) => ({
      resource: { kind: 'extension' as const, extensionKind: kind, id: '1' },
    })
    failing(403)
    failing(410)
    failing(404)
    failing(501)
    failing(undefined, true)
    expect((await resolve(ext('acme.k403'))).state).toBe('inaccessible')
    expect((await resolve(ext('acme.k410'))).state).toBe('deleted')
    expect((await resolve(ext('acme.k404'))).state).toBe('unavailable')
    expect((await resolve(ext('acme.k501'))).state).toBe('unsupported')
    expect((await resolve(ext('acme.kxo'))).state).toBe('offline')
  })

  test('public responses collapse inaccessible and an unproven deletion into unavailable', () => {
    expect(publicState('inaccessible')).toBe('unavailable')
    expect(publicState('deleted')).toBe('unavailable')
    expect(
      publicState('deleted', { tombstone: { kindLabel: 'Conversation' } }),
    ).toBe('deleted')
    expect(stateOfError({ statusCode: 403 })).toBe('inaccessible')
  })

  test('canonical identity is the owner supplied key, never a label', () => {
    registerProvider(
      fake('theorem.docs', ['document', 'graph-object'], {
        canonicalize: (r) =>
          r.kind === 'graph-object'
            ? `document:${r.objectId}`
            : r.kind === 'document'
              ? `document:${r.documentId}`
              : undefined,
      }),
    )
    expect(
      sameResource(
        { kind: 'document', documentId: 'd1' },
        { kind: 'graph-object', objectId: 'd1' },
      ),
    ).toBe(true)
    expect(
      sameResource(
        { kind: 'document', documentId: 'd1' },
        { kind: 'document', documentId: 'd2' },
      ),
    ).toBe(false)
    expect(canonicalKey({ kind: 'thread', threadId: 'x' })).toBe('thread:x')
  })
})

describe('grouped search', () => {
  test('keeps one group per provider, reports a failed group and calls the whole partial', async () => {
    registerProvider(
      fake('acme.good', ['acme.good'], {
        support: { search: true },
        search: async () => page(['a', 'b']),
      }),
    )
    registerProvider(
      fake('acme.bad', ['acme.bad'], {
        support: { search: true },
        search: async () => {
          throw new Error('boom')
        },
      }),
    )
    registerProvider(fake('acme.none', ['acme.none']))
    const result = await search({ query: 'x' })
    expect(result.groups.map((g) => [g.providerId, g.status])).toEqual([
      ['acme.good', 'ok'],
      ['acme.bad', 'failed'],
    ])
    expect(result.coverage).toBe('partial')
    expect(result.groups[0]!.page!.hits).toHaveLength(2)
  })

  test('is complete only when every provider answered without a cursor or a bound', async () => {
    registerProvider(
      fake('acme.a', ['acme.a'], {
        support: { search: true },
        search: async () => page(['a']),
      }),
    )
    expect((await search({ query: 'x' })).coverage).toBe('complete')
    registerProvider(
      fake('acme.b', ['acme.b'], {
        support: { search: true },
        search: async () => page(['b'], { truncated: true }),
      }),
    )
    expect((await search({ query: 'x' })).coverage).toBe('partial')
  })

  test('a selected provider that cannot search is reported unsupported, and all failed is failed', async () => {
    registerProvider(fake('acme.none', ['acme.none']))
    const result = await search({ query: 'x', providerIds: ['acme.none'] })
    expect(result.groups[0]!.status).toBe('unsupported')
    expect(result.coverage).toBe('failed')
  })

  test('each group continues from its own cursor, and a failed page keeps the rows', async () => {
    const seen: Array<string | undefined> = []
    let fail = false
    registerProvider(
      fake('acme.paged', ['acme.paged'], {
        support: { search: true },
        search: async ({ cursor }) => {
          seen.push(cursor)
          if (fail) throw new Error('later page failed')
          return cursor ? page(['c']) : page(['a', 'b'], { next: 'cur-1' })
        },
      }),
    )
    const first = (await search({ query: 'q' })).groups[0]!
    fail = true
    const failed = await searchMore(first, { query: 'q' })
    expect(failed.page!.hits.map((h) => h.title)).toEqual(['a', 'b'])
    expect(failed.error).toBeDefined()
    fail = false
    const more = await searchMore(first, { query: 'q' })
    expect(more.page!.hits.map((h) => h.title)).toEqual(['a', 'b', 'c'])
    expect(more.page!.next).toBeUndefined()
    expect(seen).toEqual([undefined, 'cur-1', 'cur-1'])
  })

  test('a cancelled search rejects instead of returning stale groups', async () => {
    registerProvider(
      fake('acme.slow', ['acme.slow'], {
        support: { search: true },
        search: async (_r, { signal }) => {
          await new Promise((r) => setTimeout(r, 5))
          if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
          return page([])
        },
      }),
    )
    const controller = new AbortController()
    const pending = search({ query: 'x', signal: controller.signal })
    controller.abort()
    await expect(pending).rejects.toBeDefined()
  })

  test('coverageOf of no groups is complete, of unsupported groups is failed', () => {
    expect(coverageOf([])).toBe('complete')
    expect(
      coverageOf([{ providerId: 'a', label: 'a', status: 'unsupported' }]),
    ).toBe('failed')
  })
})

describe('open', () => {
  const serving = () =>
    registerProvider(
      fake('acme.t', ['acme.ticket'], {
        support: { resolve: true, open: true },
        resolve: async () => ({
          state: 'ready',
          meta: { title: 'T', typeLabel: 'Ticket', actions: ['open'] },
        }),
      }),
    )
  const ticket: ResourceRef = {
    resource: { kind: 'extension', extensionKind: 'acme.ticket', id: '9' },
  }

  test('resolves the handler in the shipped order and hands the request to the host', async () => {
    serving()
    registerContribution({
      kind: 'open-handler',
      id: 'theorem.open.ticket',
      label: 'Open',
      serves: ['acme.ticket'],
    })
    const requests: string[] = []
    const remove = registerOpenHost(
      (r) => void requests.push(`${r.intent}:${r.handlerId}`),
    )
    expect(await open(ticket, 'beside')).toEqual({
      opened: true,
      handlerId: 'theorem.open.ticket',
    })
    expect(requests).toEqual(['beside:theorem.open.ticket'])
    remove()
  })

  test('does not open what the destination says it cannot show', async () => {
    registerProvider(
      fake('acme.gone', ['acme.gone'], {
        support: { resolve: true, open: true },
        resolve: async () => ({ state: 'inaccessible' }),
      }),
    )
    const opened: string[] = []
    registerOpenHost((r) => void opened.push(r.handlerId ?? ''))
    const result = await open({
      resource: { kind: 'extension', extensionKind: 'acme.gone', id: '1' },
    })
    expect(result).toEqual({ opened: false, state: 'inaccessible' })
    expect(opened).toEqual([])
  })

  test('a host with nowhere to show it is not reported as opened', async () => {
    serving()
    registerOpenHost(() => {
      throw new Error('no route')
    })
    expect(await open(ticket)).toEqual({ opened: false, state: 'unavailable' })
  })

  test('a kind with no provider that opens is unsupported', async () => {
    expect(await open({ resource: { kind: 'run', runId: 'r' } })).toEqual({
      opened: false,
      state: 'unsupported',
    })
  })
})

describe('first-slice providers', () => {
  test('threads: a deleted thread keeps a tombstone and a missing message is unavailable', async () => {
    const provider = threadsProvider({
      thread: async (id) =>
        id === 'gone'
          ? { title: 'Old', deletedAtMs: 5, revision: 1, messages: [] }
          : {
              title: 'Plan',
              revision: 2,
              messages: [
                { messageId: 'm1', role: 'user', text: 'Hello there' },
              ],
            },
      list: async () => ({
        threads: [
          { threadId: 't1', title: 'Plan' },
          { threadId: 't2', title: 'Other' },
        ],
        complete: false,
      }),
    })
    registerProvider(provider)
    expect(
      await resolve({ resource: { kind: 'thread', threadId: 'gone' } }),
    ).toMatchObject({
      state: 'deleted',
      tombstone: { kindLabel: 'Conversation' },
    })
    expect(
      await resolve({
        resource: { kind: 'message', threadId: 't1', messageId: 'zzz' },
      }),
    ).toEqual({ state: 'unavailable' })
    expect(
      await resolve({
        resource: { kind: 'message', threadId: 't1', messageId: 'm1' },
      }),
    ).toMatchObject({ state: 'ready', meta: { typeLabel: 'Message' } })
    const result = await search({
      query: 'plan',
      providerIds: ['theorem.threads'],
    })
    expect(result.groups[0]!.page!.hits.map((h) => h.title)).toEqual(['Plan'])
    // The listing was one page: the group says so.
    expect(result.coverage).toBe('partial')
  })

  test('records: a type this sign-in cannot read is inaccessible, and search is always bounded', async () => {
    const type = (name: string) =>
      ({
        object_type_id: name,
        name_singular: name,
        label_singular: name,
        label_identifier_field: 'name',
        fields: [],
        retired: false,
      }) as never
    registerProvider(
      recordsProvider({
        types: async () => [type('company'), type('secret')],
        find: async (_t, id) => ({
          id,
          values: { name: `Row ${id}` },
          relations: {},
          version: 3,
        }),
        search: async (_t, _q, _l) => [
          { id: 'r1', values: { name: 'Kiln Co' }, relations: {} },
        ],
        canRead: async (t) => t.name_singular !== 'secret',
        title: (_t, row) => String(row.values.name ?? ''),
      }),
    )
    expect(
      await resolve({
        resource: { kind: 'record', objectType: 'secret', objectId: '1' },
      }),
    ).toEqual({ state: 'inaccessible' })
    expect(
      await resolve({
        resource: { kind: 'record', objectType: 'company', objectId: '1' },
      }),
    ).toMatchObject({ state: 'ready', meta: { title: 'Row 1', revision: 3 } })
    expect(
      await resolve({
        resource: { kind: 'record', objectType: 'nope', objectId: '1' },
      }),
    ).toEqual({ state: 'unavailable' })
    const result = await search({ query: 'kiln' })
    expect(result.groups[0]!.page!.hits).toHaveLength(1)
    expect(result.coverage).toBe('partial')
  })

  test('work: search passes the owner cursor through', async () => {
    const seen: Array<string | undefined> = []
    registerProvider(
      workProvider({
        item: async () => {
          throw new Error('unused')
        },
        project: async () => {
          throw new Error('unused')
        },
        query: async (q) => {
          seen.push(q.cursor)
          return {
            items: [],
            nextCursor: q.cursor ? undefined : 'n1',
            total: 40,
          }
        },
      }),
    )
    const first = (await search({ query: 'x', providerIds: ['theorem.work'] }))
      .groups[0]!
    expect(first.page!.next).toBe('n1')
    await searchMore(first, { query: 'x' })
    expect(seen).toEqual([undefined, 'n1'])
  })
})

test('a preview this provider cannot draw comes from the backend; one it can is its own', async () => {
  const served: string[] = []
  const uninstall = installBackend({
    preview: async (ref) => {
      served.push(canonicalKey(ref.resource))
      return {
        state: 'ready',
        preview: { title: 'From the owner', typeLabel: 'Document' },
      }
    },
  })
  try {
    registerProvider(fake('acme.docs', ['document']))
    expect(await preview(doc('d1'))).toMatchObject({
      state: 'ready',
      preview: { title: 'From the owner' },
    })
    expect(served).toHaveLength(1)
    reset()
    registerProvider(
      fake('acme.docs', ['document'], {
        support: { preview: true },
        preview: async () => ({
          state: 'ready',
          preview: { title: 'Drawn here', typeLabel: 'Document' },
        }),
      }),
    )
    expect(await preview(doc('d1'))).toMatchObject({
      preview: { title: 'Drawn here' },
    })
    expect(served).toHaveLength(1)
  } finally {
    uninstall()
  }
})
