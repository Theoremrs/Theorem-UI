// SOURCING: none — bun:test over ./account with a stub `identify` and a pair of in-memory channels
import { describe, expect, test } from 'bun:test'
import { accountKey, createAccountWatch } from './account'
import type { AccountChange, AccountChannel } from './account'
import { HttpError } from './environment/test-host'

const ONE = { tenantId: 't1', principalId: 'p1' }
const TWO = { tenantId: 't2', principalId: 'p2' }

/** Two ends of one channel: a message posted on one is heard by the other, not by itself. */
function pair(): [AccountChannel, AccountChannel] {
  const ends: Set<(event: MessageEvent) => void>[] = [new Set(), new Set()]
  const end = (mine: number): AccountChannel => ({
    postMessage: (data: unknown) => {
      for (const listener of ends[1 - mine]!)
        queueMicrotask(() => listener({ data } as MessageEvent))
    },
    close: () => ends[mine]!.clear(),
    addEventListener: (_type: string, listener: unknown) =>
      void ends[mine]!.add(listener as (event: MessageEvent) => void),
    removeEventListener: (_type: string, listener: unknown) =>
      void ends[mine]!.delete(listener as (event: MessageEvent) => void),
  })
  return [end(0), end(1)]
}

describe('the account watch', () => {
  test('the key names tenant and principal', () => {
    expect(accountKey(ONE)).toBe('t1:p1')
    expect(accountKey(ONE)).not.toBe(accountKey({ ...ONE, principalId: 'p9' }))
  })

  test('the same account is no change; another one is, once, with who it was', async () => {
    let who = ONE
    const watch = createAccountWatch({
      identify: async () => who,
      initial: ONE,
      channel: null,
    })
    const changes: AccountChange[] = []
    watch.onChange((change) => changes.push(change))
    expect(await watch.refresh()).toEqual({
      state: 'signed_in',
      account: 't1:p1',
    })
    expect(changes).toEqual([])
    who = TWO
    await Promise.all([watch.refresh(), watch.refresh()])
    expect(changes).toHaveLength(1)
    expect(changes[0]).toMatchObject({ account: 't2:p2', previous: 't1:p1' })
    expect(watch.current).toBe('t2:p2')
  })

  test('a 401 is a sign-out; any other failure concludes nothing', async () => {
    let fail: unknown = new HttpError(401)
    const watch = createAccountWatch({
      identify: async () => {
        throw fail
      },
      initial: ONE,
      channel: null,
    })
    const changes: AccountChange[] = []
    watch.onChange((change) => changes.push(change))
    expect((await watch.refresh()).state).toBe('signed_out')
    expect(changes).toMatchObject([{ account: undefined, previous: 't1:p1' }])
    fail = new HttpError(503)
    const second = createAccountWatch({
      identify: async () => {
        throw fail
      },
      initial: ONE,
      channel: null,
    })
    expect((await second.refresh()).state).toBe('unknown')
    expect(second.current).toBe('t1:p1')
  })

  test('another tab that sees the session move tells this one, which confirms it itself', async () => {
    const [a, b] = pair()
    let who = ONE
    const first = createAccountWatch({
      identify: async () => who,
      initial: ONE,
      channel: a,
    })
    const second = createAccountWatch({
      identify: async () => who,
      initial: ONE,
      channel: b,
    })
    const heard: AccountChange[] = []
    second.onChange((change) => heard.push(change))
    who = TWO
    await first.refresh()
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(heard).toMatchObject([{ account: 't2:p2', previous: 't1:p1' }])
    first.dispose()
    second.dispose()
  })
})
