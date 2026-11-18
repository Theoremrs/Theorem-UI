// SOURCING: React's useSyncExternalStore, reading the anchor store. For a
// component that changes with its subject (a control that appears when the
// part is in view); notes themselves are moved by the layer without a render.
import { useSyncExternalStore } from 'react'
import type { Anchor, Anchors } from './anchors'

/**
 * What `select` makes of an anchor, re-read after each commit. Return a
 * primitive (whether it is visible, which side of the view it is on) so the
 * component renders only when that changes, not every frame.
 */
export function useAnchor<T>(anchors: Anchors, id: string, select: (anchor: Anchor | undefined) => T): T {
  return useSyncExternalStore(anchors.subscribe, () => select(anchors.get(id)), () => select(undefined))
}
