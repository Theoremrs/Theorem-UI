// SOURCING: none: a small store a renderer writes each frame (where each
// thing it draws is on screen) and annotations read. React's
// useSyncExternalStore is the usual reader; the annotation layer reads it
// directly so a moving camera never re-renders a note.

/** A rectangle in the layer, CSS pixels from its top left. */
export interface Box {
  x: number
  y: number
  width: number
  height: number
}

/** Where a thing an annotation points at is now. */
export interface Anchor {
  /** Its outline on screen; a point is a box of no size. */
  box: Box
  /** In front of the eye and inside the view. */
  visible: boolean
  /** Something drawn stands between the eye and it. */
  occluded?: boolean
}

export interface Anchors {
  get: (id: string) => Anchor | undefined
  /** Calls `listener` after each commit. */
  subscribe: (listener: () => void) => () => void
}

export interface AnchorStore extends Anchors {
  set: (id: string, anchor: Anchor | undefined) => void
  /** Tells readers that this frame's anchors are written. */
  commit: () => void
}

/** A store a renderer fills: `set` each anchor, then `commit` once a frame. */
export function anchorStore(): AnchorStore {
  const anchors = new Map<string, Anchor>()
  const listeners = new Set<() => void>()
  return {
    get: (id) => anchors.get(id),
    set: (id, anchor) => {
      if (anchor) anchors.set(id, anchor)
      else anchors.delete(id)
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    commit: () => {
      for (const listener of listeners) listener()
    },
  }
}

/** The smallest box holding every point. */
export function boxAround(points: Iterable<readonly [number, number]>): Box {
  let left = Infinity
  let top = Infinity
  let right = -Infinity
  let bottom = -Infinity
  for (const [x, y] of points) {
    left = Math.min(left, x)
    top = Math.min(top, y)
    right = Math.max(right, x)
    bottom = Math.max(bottom, y)
  }
  return left === Infinity
    ? { x: 0, y: 0, width: 0, height: 0 }
    : { x: left, y: top, width: right - left, height: bottom - top }
}
