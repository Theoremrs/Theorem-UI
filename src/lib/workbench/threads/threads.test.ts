// SOURCING: none — bun:test over ./threads with the real owner over a stub of the SDK calls and of the organization read, injected as dependencies
import { describe, expect, test } from 'bun:test'
import type { OrganizationRead, ThreadEntry } from '../../theorem/organization'
import { createThreads } from './threads'
import type { ThreadsClient } from './threads'

const entry = (
  over: Partial<ThreadEntry> & { threadId: string },
): ThreadEntry => ({
  title: `Thread ${over.threadId}`,
  homeProjectId: 'p1',
  revision: 3,
  createdAtMs: 100,
  memberships: [],
  attention: { reasons: [], running: false },
  ...over,
})

function setup(
  threads: ThreadEntry[],
  archived: Record<string, unknown[]> = {},
  open?: { projectId: string; threadId: string },
) {
  const calls: string[] = []
  const written: Record<string, unknown>[] = []
  const organization = {
    projects: [
      { projectId: 'p1', title: 'Atlas' },
      { projectId: 'p2', title: 'Harbor' },
    ],
    threads,
  } as unknown as OrganizationRead
  const client = {
    chat: {
      threads: {
        list: async ({ projectId }: { projectId: string }) => {
          calls.push(`list:${projectId}`)
          return { items: archived[projectId] ?? [] }
        },
        get: async ({ threadId }: { threadId: string }) => {
          calls.push(`get:${threadId}`)
          return {
            thread: {
              title: 'Exported',
              activeRunId: threadId === 't-run' ? 'run-1' : undefined,
            },
            messages: [],
          }
        },
        create: async (request: Record<string, unknown>) => {
          written.push({ create: request })
          return { record: { threadId: 'new-1' } }
        },
        update: async (request: Record<string, unknown>) => {
          written.push({ update: request })
          return {}
        },
        delete: async (request: Record<string, unknown>) => {
          written.push({ delete: request })
          return {}
        },
      },
      runs: {
        delegations: async ({ runId }: { runId: string }) => {
          calls.push(`delegations:${runId}`)
          return {
            delegations: [
              { delegationId: 'd1', roleLabel: 'Reviewer', objective: 'x' },
            ],
          }
        },
      },
    },
  } as unknown as ThreadsClient
  const owner = createThreads({
    client,
    organization: async () => organization,
    mutate: (run) => run({ 'X-CSRF-Token': 'c', 'Idempotency-Key': 'i' }),
    mutateThread: (_id, run) =>
      run({ 'X-CSRF-Token': 'c', 'Idempotency-Key': 'i', 'If-Match': '3' }),
    open: () => open,
    now: () => 42,
  })
  return { owner, calls, written }
}

describe('the threads owner', () => {
  test('lists the account threads with their project, state and revision, and never claims a pin, tag or unread mark', async () => {
    const t = setup([
      entry({
        threadId: 't-a',
        memberships: [
          { projectId: 'p2', by: 'user', pinned: false, why: '', atMs: 1 },
        ],
        attention: {
          reasons: [{ kind: 'failed', runId: 'r', atMs: 1 }],
          running: false,
        },
      }),
      entry({
        threadId: 't-b',
        origin: { kind: 'forked', threadId: 't-a' } as never,
      }),
    ])
    const done = await t.owner.list()
    if (done.outcome !== 'accepted') throw new Error('not accepted')
    expect(done.value.asOfMs).toBe(42)
    expect(done.value.projects).toEqual([
      { id: 'p1', name: 'Atlas' },
      { id: 'p2', name: 'Harbor' },
    ])
    const [a, b] = done.value.threads
    expect(a).toMatchObject({
      id: 't-a',
      projectIds: ['p2', 'p1'],
      archived: false,
      pinned: false,
      unread: false,
      revision: '3',
    })
    expect(a!.needsYou).toBeString()
    expect(b).toMatchObject({ origin: 't-a' })
    expect(a).not.toHaveProperty('tag')
  })

  test('merges the archived threads each project lists, and reads delegations only for running and open threads', async () => {
    const t = setup(
      [
        entry({
          threadId: 't-run',
          attention: { reasons: [], running: true },
        }),
        entry({ threadId: 't-idle' }),
      ],
      {
        p2: [
          {
            threadId: 't-old',
            projectId: 'p2',
            title: 'Old',
            status: 'archived',
            createdAtMs: 1,
            revision: 7,
          },
          {
            threadId: 't-idle',
            projectId: 'p1',
            title: 'dup',
            status: 'archived',
            createdAtMs: 1,
            revision: 1,
          },
          {
            threadId: 't-live',
            projectId: 'p2',
            title: 'Live',
            status: 'active',
            createdAtMs: 1,
            revision: 1,
          },
        ],
      },
    )
    const done = await t.owner.list()
    if (done.outcome !== 'accepted') throw new Error('not accepted')
    const ids = done.value.threads.map(({ id }) => id)
    expect(ids).toEqual(['t-run', 't-idle', 't-old'])
    expect(done.value.threads[2]).toMatchObject({
      archived: true,
      projectIds: ['p2'],
      revision: '7',
    })
    expect(done.value.threads[0]!.delegations).toEqual([
      { id: 'd1', label: 'Reviewer', runId: 'run-1' },
    ])
    expect(t.calls.filter((c) => c.startsWith('get:'))).toEqual(['get:t-run'])
  })

  test('reads the open thread’s delegations and reports it as open', async () => {
    const t = setup(
      [entry({ threadId: 't-run' })],
      {},
      {
        projectId: 'p1',
        threadId: 't-run',
      },
    )
    const done = await t.owner.list()
    if (done.outcome !== 'accepted') throw new Error('not accepted')
    expect(done.value.open).toEqual({ projectId: 'p1', threadId: 't-run' })
    expect(done.value.threads[0]!.delegations).toHaveLength(1)
  })

  test('writes carry the revisioned headers, and each lists again for the listeners', async () => {
    const t = setup([entry({ threadId: 't-a' })])
    const heard: number[] = []
    const stop = t.owner.subscribe((listing) =>
      heard.push(listing.threads.length),
    )
    await Promise.resolve()
    expect(await t.owner.create('p1')).toMatchObject({
      outcome: 'accepted',
      value: { projectId: 'p1', threadId: 'new-1' },
    })
    expect(await t.owner.rename('t-a', 'New name')).toMatchObject({
      outcome: 'accepted',
    })
    expect(await t.owner.archive('t-a', true)).toMatchObject({
      outcome: 'accepted',
    })
    expect(await t.owner.delete('t-a')).toMatchObject({ outcome: 'accepted' })
    expect(t.written).toEqual([
      {
        create: {
          projectId: 'p1',
          'X-CSRF-Token': 'c',
          'Idempotency-Key': 'i',
        },
      },
      {
        update: {
          threadId: 't-a',
          title: 'New name',
          'X-CSRF-Token': 'c',
          'Idempotency-Key': 'i',
          'If-Match': '3',
        },
      },
      {
        update: {
          threadId: 't-a',
          archived: true,
          'X-CSRF-Token': 'c',
          'Idempotency-Key': 'i',
          'If-Match': '3',
        },
      },
      {
        delete: {
          threadId: 't-a',
          'X-CSRF-Token': 'c',
          'Idempotency-Key': 'i',
          'If-Match': '3',
        },
      },
    ])
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(heard.length).toBeGreaterThan(1)
    stop()
  })

  test('a write that lands while a read is out is followed by another read', async () => {
    let title = 'Old'
    let gate: Promise<void> | undefined
    let release = () => {}
    const owner = createThreads({
      client: {
        chat: {
          threads: {
            list: async () => ({ items: [] }),
            update: async () => {
              title = 'New'
              return {}
            },
          },
        },
      } as unknown as ThreadsClient,
      organization: async () => {
        const seen = title
        await gate
        return {
          projects: [{ projectId: 'p1', title: 'Atlas' }],
          threads: [entry({ threadId: 't-a', title: seen })],
        } as unknown as OrganizationRead
      },
      mutate: (run) => run({ 'X-CSRF-Token': 'c', 'Idempotency-Key': 'i' }),
      mutateThread: (_id, run) =>
        run({ 'X-CSRF-Token': 'c', 'Idempotency-Key': 'i', 'If-Match': '3' }),
      open: () => undefined,
    })
    const heard: string[] = []
    const stop = owner.subscribe((listing) =>
      heard.push(listing.threads[0]?.title ?? ''),
    )
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(heard).toEqual(['Old'])
    // A read that saw the old title is still out when the rename is answered.
    gate = new Promise((resolve) => (release = resolve))
    owner.refresh()
    await owner.rename('t-a', 'New')
    gate = undefined
    release()
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(heard.at(-1)).toBe('New')
    stop()
  })

  test('a refused write is data, and a dropped one is uncertain', async () => {
    const make = (error: unknown) =>
      createThreads({
        client: {
          chat: {
            threads: {
              update: async () => {
                throw error
              },
            },
          },
        } as unknown as ThreadsClient,
        organization: async () =>
          ({ projects: [], threads: [] }) as unknown as OrganizationRead,
        mutate: (run) => run({ 'X-CSRF-Token': 'c', 'Idempotency-Key': 'i' }),
        mutateThread: (_id, run) =>
          run({ 'X-CSRF-Token': 'c', 'Idempotency-Key': 'i', 'If-Match': '1' }),
        open: () => undefined,
      })
    expect(await make({ statusCode: 412 }).rename('t', 'x')).toMatchObject({
      outcome: 'refused',
      code: 'http_412',
    })
    expect(
      await make(new Error('socket closed')).rename('t', 'x'),
    ).toMatchObject({ outcome: 'uncertain' })
  })

  test('a failed read of the account is a failed list', async () => {
    const owner = createThreads({
      client: {} as ThreadsClient,
      organization: async () => {
        throw new Error('down')
      },
      mutate: (run) => run({ 'X-CSRF-Token': '', 'Idempotency-Key': '' }),
      mutateThread: (_id, run) =>
        run({ 'X-CSRF-Token': '', 'Idempotency-Key': '', 'If-Match': '' }),
      open: () => undefined,
    })
    expect((await owner.list()).outcome).toBe('failed')
  })

  test('the Markdown export is headed by the title', async () => {
    const t = setup([])
    const done = await t.owner.markdown('t-a')
    if (done.outcome !== 'accepted') throw new Error('not accepted')
    expect(done.value.text.startsWith('# Exported')).toBe(true)
  })
})
