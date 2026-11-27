// SOURCING: zustand with its persist middleware (the person's arrangement
// outlives a reload and an update, OWN-01), as components/shell/shell-state
// is, over layout-envelope (the versioned wrapper around Dockview's state).
// Keeping an unreadable or newer envelope aside rather than replacing it is
// the spec's HOST-01 / HOST-03; no library models it.
import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import { decodeLayout, encodeLayout } from './layout-envelope'
import type {
  LayoutDevice,
  LayoutEnvelope,
  VendorLayout,
} from './layout-envelope'

export const LAYOUT_STORE_KEY = 'theorem.layouts/1'
const PRESERVED_LIMIT = 40

export type PreservedReason = 'newer' | 'unreadable' | 'reset'

/** A layout set aside, whole and unchanged, so nothing is lost by moving on. */
export interface PreservedLayout {
  id: string
  projectId: string
  device: string
  reason: PreservedReason
  at: string
  raw: unknown
}

interface LayoutStore {
  /** Bumped by every save and reset, so a reset can check what it saw. */
  revision: number
  /** The raw stored value per project and device: an envelope, or whatever was there. */
  slots: Readonly<Record<string, Readonly<Record<string, unknown>>>>
  preserved: ReadonlyArray<PreservedLayout>
}

export const useLayoutStore = create<LayoutStore>()(
  persist((): LayoutStore => ({ revision: 0, slots: {}, preserved: [] }), {
    name: LAYOUT_STORE_KEY,
    version: 1,
    storage: createJSONStorage(() => localStorage),
    partialize: ({ revision, slots, preserved }) => ({
      revision,
      slots,
      preserved,
    }),
  }),
)

let counter = 0
const preservedId = () =>
  `${Date.now().toString(36)}-${(counter++).toString(36)}`

const keep = (
  list: ReadonlyArray<PreservedLayout>,
  added: ReadonlyArray<PreservedLayout>,
) => [...list, ...added].slice(-PRESERVED_LIMIT)

export type LoadedLayout =
  | { status: 'none' }
  | {
      status: 'ok'
      vendor: VendorLayout
      threadId: string | undefined
    }
  /** A newer or unreadable envelope: start from the default, keep this aside. */
  | { status: 'foreign'; reason: PreservedReason }

/**
 * The layout to restore for a project on a device. `legacy` is the dock saved
 * before envelopes existed (components/shell/shell-state `layouts`), read for
 * the desktop until the first envelope replaces it.
 */
export function loadLayout(
  projectId: string,
  device: LayoutDevice,
  legacy?: { threadId: string | undefined; dock: unknown },
): LoadedLayout {
  const raw = useLayoutStore.getState().slots[projectId]?.[device]
  if (raw === undefined) {
    if (device === 'desktop' && legacy)
      return {
        status: 'ok',
        vendor: legacy.dock as never,
        threadId: legacy.threadId,
      }
    return { status: 'none' }
  }
  const decoded = decodeLayout(raw)
  if (decoded.status === 'ok')
    return {
      status: 'ok',
      vendor: decoded.vendor,
      threadId: decoded.envelope.threadId,
    }
  return { status: 'foreign', reason: decoded.status }
}

/**
 * Saves a project's layout for a device. A newer or unreadable envelope
 * already there is kept aside first, so saving never overwrites it. Other
 * devices' slots are never touched.
 */
export function saveLayout(
  projectId: string,
  device: LayoutDevice,
  layout: { vendor: VendorLayout; threadId?: string },
) {
  const envelope: LayoutEnvelope = encodeLayout(layout.vendor, {
    device,
    threadId: layout.threadId,
  })
  useLayoutStore.setState((state) => {
    const held = state.slots[projectId]?.[device]
    const foreign =
      held !== undefined && decodeLayout(held).status !== 'ok'
        ? [
            {
              id: preservedId(),
              projectId,
              device,
              reason: (decodeLayout(held).status === 'newer'
                ? 'newer'
                : 'unreadable') as PreservedReason,
              at: new Date().toISOString(),
              raw: held,
            },
          ]
        : []
    return {
      revision: state.revision + 1,
      slots: {
        ...state.slots,
        [projectId]: { ...state.slots[projectId], [device]: envelope },
      },
      preserved: foreign.length
        ? keep(state.preserved, foreign)
        : state.preserved,
    }
  })
}

/**
 * Sets every stored layout aside as a preserved copy and clears the slots, so
 * each project starts from the shipped layout. Refused when `revision` is not
 * the current one: a layout was saved since the caller looked.
 */
export function resetLayouts(
  revision: number,
  legacy: Readonly<Record<string, unknown>> = {},
): { ok: true; preserved: number } | { ok: false } {
  const state = useLayoutStore.getState()
  if (state.revision !== revision) return { ok: false }
  const at = new Date().toISOString()
  const aside: PreservedLayout[] = []
  for (const [projectId, devices] of Object.entries(state.slots))
    for (const [device, raw] of Object.entries(devices))
      aside.push({
        id: preservedId(),
        projectId,
        device,
        reason: 'reset',
        at,
        raw,
      })
  for (const [projectId, raw] of Object.entries(legacy))
    aside.push({
      id: preservedId(),
      projectId,
      device: 'desktop',
      reason: 'reset',
      at,
      raw,
    })
  useLayoutStore.setState({
    revision: state.revision + 1,
    slots: {},
    preserved: keep(state.preserved, aside),
  })
  return { ok: true, preserved: aside.length }
}

export const resetLayoutStoreForTest = () =>
  useLayoutStore.setState({ revision: 0, slots: {}, preserved: [] })
