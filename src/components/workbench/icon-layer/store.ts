// SOURCING: hand-roll over the generated wire types (src/lib/workbench/wire PlacedIcon) and React's useSyncExternalStore: nothing models the Rust core's icon list (terminal/crates/workbench-core/src/icons.rs, `PlacedIcon[]` JSON); this is the small store that keeps the last frame's list, drops what is not an icon of the page's set, and holds one array until the frame's icons change.
import { CONTROL_LAYERS } from '@/assets/icons/streamline/control/layers'
import type { PlacedIcon } from '@/lib/workbench/wire'

/**
 * An icon a frame placed. The agent terminal also sends `ink`, the colour of the glyph the icon
 * stands for (its prompt pointer in the accent, a fold's arrow in the quiet text); without it the
 * icon is painted in the layer's own ink.
 */
export type FrameIcon = PlacedIcon & { ink?: string }

export interface IconStore {
  /** The frame's icons: the same array until a frame changes them. */
  getSnapshot: () => readonly FrameIcon[]
  subscribe: (listener: () => void) => () => void
  /** Takes a frame's icons (`PlacedIcon[]` JSON); returns whether they changed. */
  set: (json: string) => boolean
}

const NONE: readonly FrameIcon[] = []

const isCell = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0

const isInk = (value: unknown): value is string =>
  typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value)

/**
 * The icons of a frame's JSON. An entry that is not a cell position with a name from the page's own
 * set (`CONTROL_LAYERS`) is dropped, so a core newer than the page shows what it can and nothing
 * else; an `ink` that is not a `#rrggbb` colour is left off; JSON that is not a list is no icons.
 */
export function parseIcons(json: string): FrameIcon[] {
  let value: unknown
  try {
    value = JSON.parse(json)
  } catch {
    return []
  }
  if (!Array.isArray(value)) return []
  const icons: FrameIcon[] = []
  for (const entry of value as unknown[]) {
    if (typeof entry !== 'object' || entry === null) continue
    const { x, y, icon, ink } = entry as Partial<Record<keyof FrameIcon, unknown>>
    if (
      isCell(x) &&
      isCell(y) &&
      typeof icon === 'string' &&
      Object.hasOwn(CONTROL_LAYERS, icon)
    )
      icons.push({
        x,
        y,
        icon: icon as PlacedIcon['icon'],
        ...(isInk(ink) && { ink }),
      })
  }
  return icons
}

export function createIconStore(): IconStore {
  let snapshot = NONE
  let last = '[]'
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    set(json) {
      if (json === last) return false
      last = json
      const icons = parseIcons(json)
      snapshot = icons.length > 0 ? icons : NONE
      for (const listener of listeners) listener()
      return true
    },
  }
}
