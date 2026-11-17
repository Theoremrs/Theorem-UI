// SOURCING: hand-roll over the generated wire types (src/lib/workbench/wire PlacedIcon) and React's useSyncExternalStore: nothing models the Rust core's icon list (terminal/crates/workbench-core/src/icons.rs, `PlacedIcon[]` JSON); this is the small store that keeps the last frame's list, drops what is not an icon of the page's set, and holds one array until the frame's icons change.
import { CONTROL_LAYERS } from '@/assets/icons/streamline/control/layers'
import type { PlacedIcon } from '@/lib/workbench/wire'

export interface IconStore {
  /** The frame's icons: the same array until a frame changes them. */
  getSnapshot: () => readonly PlacedIcon[]
  subscribe: (listener: () => void) => () => void
  /** Takes a frame's icons (`PlacedIcon[]` JSON); returns whether they changed. */
  set: (json: string) => boolean
}

const NONE: readonly PlacedIcon[] = []

const isCell = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0

/**
 * The icons of a frame's JSON. An entry that is not a cell position with a name from the page's own
 * set (`CONTROL_LAYERS`) is dropped, so a core newer than the page shows what it can and nothing
 * else; JSON that is not a list is no icons.
 */
export function parseIcons(json: string): PlacedIcon[] {
  let value: unknown
  try {
    value = JSON.parse(json)
  } catch {
    return []
  }
  if (!Array.isArray(value)) return []
  const icons: PlacedIcon[] = []
  for (const entry of value as unknown[]) {
    if (typeof entry !== 'object' || entry === null) continue
    const { x, y, icon } = entry as Partial<PlacedIcon>
    if (
      isCell(x) &&
      isCell(y) &&
      typeof icon === 'string' &&
      Object.hasOwn(CONTROL_LAYERS, icon)
    )
      icons.push({ x, y, icon })
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
