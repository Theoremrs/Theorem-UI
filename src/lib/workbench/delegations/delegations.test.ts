// SOURCING: none — bun:test over ./delegations with a stub of the two SDK calls it makes (a plain object, no mock.module)
import { describe, expect, test } from 'bun:test'
import {
  createDelegations,
  MAX_CACHED_BLOBS,
  MAX_TEXT_BYTES,
} from './delegations'
import type { DelegationsClient } from './delegations'

type Change = {
  path: string
  change: 'add' | 'modify' | 'delete'
  binary: boolean
  beforeRef?: string
  afterRef?: string
}
const bytes = (text: string | Uint8Array) =>
  typeof text === 'string' ? new TextEncoder().encode(text) : text
const httpError = (statusCode: number, message = 'nope') =>
  Object.assign(new Error(message), { statusCode })

function setup(
  changes: Change[] = [
    {
      path: 'a.ts',
      change: 'modify',
      binary: false,
      beforeRef: 'b1',
      afterRef: 'a1',
    },
    { path: 'new.ts', change: 'add', binary: false, afterRef: 'a2' },
    { path: 'old.ts', change: 'delete', binary: false, beforeRef: 'b3' },
    {
      path: 'img.png',
      change: 'modify',
      binary: true,
      beforeRef: 'b4',
      afterRef: 'a4',
    },
    {
      path: 'gone.ts',
      change: 'modify',
      binary: false,
      beforeRef: 'b5',
      afterRef: 'a5',
    },
  ],
  state = 'reviewed',
) {
  const calls: string[] = []
  const blobs = new Map<string, Uint8Array | Error>([
    ['b1', bytes('before')],
    ['a1', bytes('after')],
    ['a2', bytes('new file')],
    ['b3', bytes('old file')],
    ['b5', httpError(404)],
    ['a5', bytes('x')],
  ])
  const gates = new Map<string, Promise<void>>()
  const world = { state, changes }
  const client: DelegationsClient = {
    chat: {
      runs: {
        delegations: async ({ runId }) => {
          calls.push(`list:${runId}`)
          return {
            delegations: [
              {
                delegationId: 'd1',
                state: world.state,
                receipt: { changes: world.changes },
              },
            ],
          } as never
        },
        delegationContent: async ({ ref }) => {
          calls.push(`blob:${ref}`)
          await gates.get(ref)
          const blob = blobs.get(ref)
          if (blob instanceof Error) throw blob
          if (!blob) throw httpError(404)
          return {
            arrayBuffer: async () =>
              blob.buffer.slice(
                blob.byteOffset,
                blob.byteOffset + blob.byteLength,
              ) as ArrayBuffer,
          }
        },
      },
    },
  }
  let switched: (() => void) | undefined
  const owner = createDelegations({
    workspaceId: 'w1',
    client,
    onAccountChange: (listener) => (
      (switched = listener),
      () => (switched = undefined)
    ),
  })
  return {
    owner,
    calls,
    blobs,
    gates,
    world,
    switchAccount: () => switched?.(),
  }
}
const req = { runId: 'r1', delegationId: 'd1' }
const text = (path: string, side: 'before' | 'after') => ({
  ...req,
  path,
  side,
})

describe('delegation changes', () => {
  test('lists each change with what it has, and never a ref', async () => {
    const { owner } = setup()
    const done = await owner.changes(req)
    expect(done).toMatchObject({ outcome: 'accepted', workspaceId: 'w1' })
    if (done.outcome !== 'accepted') return
    expect(done.value[0]).toEqual({
      path: 'a.ts',
      change: 'modify',
      binary: false,
      hasBefore: true,
      hasAfter: true,
    })
    expect(done.value[1]).toMatchObject({
      change: 'add',
      hasBefore: false,
      hasAfter: true,
    })
    expect(JSON.stringify(done.value)).not.toMatch(/b1|a1/)
  })

  test('a delegation the run does not have is refused', async () => {
    const { owner } = setup()
    expect(await owner.changes({ ...req, delegationId: 'nope' })).toMatchObject(
      {
        outcome: 'refused',
        code: 'no_such_delegation',
      },
    )
  })

  test('a settled delegation is listed once; a live one is read again each time', async () => {
    const settled = setup()
    await settled.owner.changes(req)
    await settled.owner.changes(req)
    expect(settled.calls.filter((c) => c.startsWith('list'))).toHaveLength(1)

    const live = setup(undefined, 'started')
    await live.owner.changes(req)
    live.world.changes = [
      ...live.world.changes,
      { path: 'late.ts', change: 'add', binary: false, afterRef: 'a9' },
    ]
    const again = await live.owner.changes(req)
    expect(live.calls.filter((c) => c.startsWith('list'))).toHaveLength(2)
    expect(
      again.outcome === 'accepted' && again.value.map((c) => c.path),
    ).toContain('late.ts')
  })

  test('a list that fails is failed, with the SDK text redacted', async () => {
    const owner = createDelegations({
      workspaceId: 'w1',
      client: {
        chat: {
          runs: {
            delegations: async () => {
              throw new Error('connection reset Bearer abcdefghij1234567890')
            },
            delegationContent: async () => {
              throw new Error('unused')
            },
          },
        },
      },
    })
    const done = await owner.changes(req)
    expect(done.outcome).toBe('failed')
    expect(JSON.stringify(done)).not.toContain('abcdefghij1234567890')
  })
})

describe('delegation content', () => {
  test('a text side is accepted as text', async () => {
    const { owner } = setup()
    expect(await owner.content(text('a.ts', 'before'))).toMatchObject({
      outcome: 'accepted',
      value: { text: 'before' },
    })
    expect(await owner.content(text('a.ts', 'after'))).toMatchObject({
      outcome: 'accepted',
      value: { text: 'after' },
    })
  })

  test('a binary change is skipped without reading it', async () => {
    const { owner, calls } = setup()
    expect(await owner.content(text('img.png', 'after'))).toMatchObject({
      outcome: 'refused',
      code: 'binary_skipped',
    })
    expect(calls.some((c) => c.startsWith('blob'))).toBe(false)
  })

  test('the before of an added file and the after of a deleted one have no such side', async () => {
    const { owner, calls } = setup()
    expect(await owner.content(text('new.ts', 'before'))).toMatchObject({
      code: 'no_such_side',
    })
    expect(await owner.content(text('old.ts', 'after'))).toMatchObject({
      code: 'no_such_side',
    })
    expect(calls.some((c) => c.startsWith('blob'))).toBe(false)
  })

  test('a 404 is no longer stored', async () => {
    const { owner } = setup()
    expect(await owner.content(text('gone.ts', 'before'))).toMatchObject({
      outcome: 'refused',
      code: 'no_longer_stored',
    })
  })

  test('a file over the bound is refused, one at the bound is read', async () => {
    const { owner, blobs } = setup()
    blobs.set('a1', new Uint8Array(MAX_TEXT_BYTES + 1).fill(97))
    blobs.set('b1', new Uint8Array(MAX_TEXT_BYTES).fill(97))
    expect(await owner.content(text('a.ts', 'after'))).toMatchObject({
      code: 'too_large',
    })
    expect((await owner.content(text('a.ts', 'before'))).outcome).toBe(
      'accepted',
    )
  })

  test('bytes that are not UTF-8 are not text', async () => {
    const { owner, blobs } = setup()
    blobs.set('a1', new Uint8Array([0xff, 0xfe, 0x00, 0x80]))
    expect(await owner.content(text('a.ts', 'after'))).toMatchObject({
      outcome: 'refused',
      code: 'not_text',
    })
  })

  test('a path not in the change list is refused without another call once the list is held', async () => {
    const { owner, calls } = setup()
    await owner.changes(req)
    const before = calls.length
    expect(await owner.content(text('other.ts', 'after'))).toMatchObject({
      code: 'no_such_change',
    })
    expect(calls).toHaveLength(before)
  })

  test('two reads of one ref at once make one call, and a later read makes none', async () => {
    const { owner, calls, gates } = setup()
    await owner.changes(req)
    let open!: () => void
    gates.set('a1', new Promise<void>((resolve) => (open = resolve)))
    const first = owner.content(text('a.ts', 'after'))
    const second = owner.content(text('a.ts', 'after'))
    await Promise.resolve()
    open()
    expect((await Promise.all([first, second])).map((d) => d.outcome)).toEqual([
      'accepted',
      'accepted',
    ])
    await owner.content(text('a.ts', 'after'))
    expect(calls.filter((c) => c === 'blob:a1')).toHaveLength(1)
  })

  test('the blob cache holds no more than its bound', async () => {
    const many = Array.from({ length: MAX_CACHED_BLOBS + 10 }, (_, i) => ({
      path: `f${i}.ts`,
      change: 'add' as const,
      binary: false,
      afterRef: `r${i}`,
    }))
    const { owner, blobs } = setup(many)
    for (const { afterRef } of many) blobs.set(afterRef, bytes('x'))
    for (const { path } of many) await owner.content(text(path, 'after'))
    expect(owner.cached().blobs).toBe(MAX_CACHED_BLOBS)
  })

  test('a failed read is failed, redacted, and not cached', async () => {
    const { owner, blobs, calls } = setup()
    blobs.set(
      'a1',
      Object.assign(new Error('boom token=supersecretvalue'), {
        statusCode: 500,
      }),
    )
    const done = await owner.content(text('a.ts', 'after'))
    expect(done.outcome).toBe('failed')
    expect(JSON.stringify(done)).not.toContain('supersecretvalue')
    blobs.set('a1', bytes('fixed'))
    expect(await owner.content(text('a.ts', 'after'))).toMatchObject({
      outcome: 'accepted',
      value: { text: 'fixed' },
    })
    expect(calls.filter((c) => c === 'blob:a1')).toHaveLength(2)
  })

  test('an account switch drops the cache, and an answer still in flight is refused', async () => {
    const { owner, calls, gates, switchAccount } = setup()
    await owner.content(text('a.ts', 'after'))
    expect(owner.cached().blobs).toBe(1)
    switchAccount()
    expect(owner.cached().blobs).toBe(0)
    await owner.content(text('a.ts', 'after'))
    expect(calls.filter((c) => c === 'list:r1')).toHaveLength(2)

    let open!: () => void
    gates.set('b1', new Promise<void>((resolve) => (open = resolve)))
    const inFlight = owner.content(text('a.ts', 'before'))
    await new Promise((r) => setTimeout(r, 0))
    switchAccount()
    open()
    expect(await inFlight).toMatchObject({
      outcome: 'refused',
      code: 'stale_account',
    })
    expect(owner.cached().blobs).toBe(0)
  })
})
