// SOURCING: @theoremharness/sdk `session.bootstrap` names the signed-in account (`tenantId`,
// `principalId`); the caller supplies `identify` over it, so this file never talks to an endpoint.
// BroadcastChannel is the platform's own way to tell the other tabs of the origin, as
// @rustyreddb/browser's shared database does; the session cookie is shared by every tab, so a sign-out
// or switch in one tab is a change in all of them, and each tab confirms it by asking `identify` again
// rather than trusting a message.

import { statusOf } from './environment/result'

/** What the session says about who is signed in. `session.bootstrap` returns these two among others. */
export interface AccountIdentity {
  tenantId: string
  principalId: string
}

/** The key that scopes everything kept on this device: one tenant's one principal. */
export const accountKey = ({
  tenantId,
  principalId,
}: AccountIdentity): string => `${tenantId}:${principalId}`

export type AccountState =
  | { state: 'signed_in'; account: string }
  | { state: 'signed_out'; reason: string }
  /** The session could not be read (offline, host error): nothing is concluded and nothing changes. */
  | { state: 'unknown'; reason: string }

export interface AccountChange {
  /** Who is signed in now; `undefined` after a sign-out. */
  account: string | undefined
  previous: string | undefined
  reason: string
}

export interface AccountWatch {
  /** Who was signed in the last time the session was read. */
  readonly current: string | undefined
  /**
   * Reads the session again: after any 401, when the tab gains focus, or when another tab says the
   * session moved. Listeners hear a change once per change, however many callers asked.
   */
  refresh: () => Promise<AccountState>
  onChange: (listener: (change: AccountChange) => void) => () => void
  dispose: () => void
}

/** What the watch needs of a `BroadcastChannel`. */
export type AccountChannel = Pick<
  BroadcastChannel,
  'postMessage' | 'close' | 'addEventListener' | 'removeEventListener'
>

export interface AccountWatchOptions {
  identify: () => Promise<AccountIdentity>
  /** The account the page was built for, so a first `refresh` that finds another account is a change. */
  initial?: AccountIdentity
  /** Defaults to a `BroadcastChannel` on the origin when the platform has one. */
  channel?: AccountChannel | null
}

const CHANNEL = 'theorem-workbench:account'

export function createAccountWatch(options: AccountWatchOptions): AccountWatch {
  const listeners = new Set<(change: AccountChange) => void>()
  let current = options.initial ? accountKey(options.initial) : undefined
  let reading: Promise<AccountState> | undefined
  let disposed = false
  const channel =
    options.channel === undefined
      ? typeof BroadcastChannel === 'undefined'
        ? null
        : new BroadcastChannel(CHANNEL)
      : options.channel

  function apply(next: string | undefined, reason: string) {
    if (next === current) return
    const change: AccountChange = { account: next, previous: current, reason }
    current = next
    for (const listener of [...listeners]) {
      try {
        listener(change)
      } catch (error) {
        console.warn('An account listener failed', error)
      }
    }
    channel?.postMessage({ account: next })
  }

  async function read(): Promise<AccountState> {
    try {
      const account = accountKey(await options.identify())
      if (!disposed) {
        apply(
          account,
          current === undefined
            ? 'Signed in'
            : 'Another account is signed in on this device',
        )
      }
      return { state: 'signed_in', account }
    } catch (error) {
      if (statusOf(error) === 401) {
        const reason = 'The session ended: sign in again'
        if (!disposed) apply(undefined, reason)
        return { state: 'signed_out', reason }
      }
      return {
        state: 'unknown',
        reason: error instanceof Error ? error.message : String(error),
      }
    }
  }

  const heard = () => void refresh()
  channel?.addEventListener('message', heard)

  function refresh() {
    reading ??= read().finally(() => {
      reading = undefined
    })
    return reading
  }

  return {
    get current() {
      return current
    },
    refresh,
    onChange(listener) {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    dispose() {
      disposed = true
      listeners.clear()
      channel?.removeEventListener('message', heard)
      channel?.close()
    },
  }
}
