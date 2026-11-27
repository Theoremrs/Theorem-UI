// SOURCING: zustand (safe mode is a store, so the shell, the pickers and the
// recovery page agree while it is on) and the URL's query string. Starting with
// user extensions off is the spec's EXEC-05 / A22; no library models it.
import { create } from 'zustand'
import type { CommandSource } from '@/lib/commands/registry'

/** `?safe=1` on any URL starts the workspace with user extensions disabled. */
export const SAFE_PARAM = 'safe'
const SESSION_KEY = 'theorem-ui:safe-mode'

export type SafeVia = 'query' | 'session' | 'recovery-route' | 'manual'

interface SafeState {
  active: boolean
  via: SafeVia | null
  enter: (via: SafeVia) => void
  leave: () => void
}

/** Whether a query string asks for safe mode. */
export const wantsSafeMode = (search: string) =>
  new URLSearchParams(search).get(SAFE_PARAM) === '1'

function remembered(): boolean {
  try {
    return sessionStorage.getItem(SESSION_KEY) === '1'
  } catch {
    return false
  }
}

function remember(on: boolean) {
  try {
    if (on) sessionStorage.setItem(SESSION_KEY, '1')
    else sessionStorage.removeItem(SESSION_KEY)
  } catch {
    // Private windows can refuse storage; safe mode then lasts the page load.
  }
}

function initial(): Pick<SafeState, 'active' | 'via'> {
  if (typeof window === 'undefined') return { active: false, via: null }
  if (wantsSafeMode(window.location.search))
    return { active: true, via: 'query' }
  if (remembered()) return { active: true, via: 'session' }
  return { active: false, via: null }
}

export const useSafeMode = create<SafeState>()((set) => ({
  ...initial(),
  enter: (via) => {
    // The recovery route turns it on only while it is shown.
    if (via !== 'recovery-route') remember(true)
    set({ active: true, via })
  },
  leave: () => {
    remember(false)
    set({ active: false, via: null })
  },
}))

export const isSafeMode = () => useSafeMode.getState().active

/**
 * Whether user code (a module's, an extension's, a custom shell) may run now.
 * Module loaders and extension hosts call this before admitting anything.
 */
export const userExtensionsEnabled = () => !isSafeMode()

/** In safe mode only the host's own contributions and commands are admitted. */
export const admitsSource = (
  source: CommandSource,
  safe = isSafeMode(),
): boolean => !safe || source.kind === 'builtin'

/** Leaves safe mode and drops `?safe=1` from the address, without a reload. */
export function leaveSafeMode() {
  useSafeMode.getState().leave()
  if (typeof window === 'undefined') return
  const url = new URL(window.location.href)
  if (!url.searchParams.has(SAFE_PARAM)) return
  url.searchParams.delete(SAFE_PARAM)
  window.history.replaceState(window.history.state, '', url)
}
