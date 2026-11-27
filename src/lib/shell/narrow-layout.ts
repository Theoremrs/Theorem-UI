// SOURCING: dockview-core's public DockviewApi (panels, groups, moveTo,
// addPanel) and the browser's matchMedia. The stacked single-pane
// presentation for narrow viewports is the spec's HOST-03; the rule that it
// never rewrites the stored desktop arrangement lives in layout-store, which
// keeps one slot per device.
import { useSyncExternalStore } from 'react'
import type { DockviewApi, IDockviewPanel } from 'dockview-react'

/** Below this width the desktop dock is not usable: panels stack as tabs. */
export const NARROW_QUERY = '(max-width: 639px)'

const narrowQuery = () =>
  typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(NARROW_QUERY)
    : undefined

export function useNarrowViewport(): boolean {
  return useSyncExternalStore(
    (notify) => {
      const query = narrowQuery()
      query?.addEventListener('change', notify)
      return () => query?.removeEventListener('change', notify)
    },
    () => narrowQuery()?.matches ?? false,
    () => false,
  )
}

/** What of a panel is needed to bring it back after the dock is rebuilt. */
export interface LivePanel {
  id: string
  component: string
  title: string
  params: Record<string, unknown>
}

export const liveOf = (panel: IDockviewPanel): LivePanel => ({
  id: panel.id,
  component: panel.view.contentComponent,
  title: panel.title ?? panel.id,
  params: panel.params ?? {},
})

/**
 * Panels of `live` a restored layout does not hold: opened while the dock was
 * stacked, so the desktop arrangement being restored never knew them.
 */
export const missingAfterRestore = (
  live: ReadonlyArray<LivePanel>,
  restoredIds: ReadonlySet<string>,
) => live.filter((panel) => !restoredIds.has(panel.id))

/**
 * Stacks every panel as a tab of `anchor`'s group: one pane at a time, the
 * rest a tap away. Nothing closes, and panels keep their state because they
 * are only moved. Returns the ids moved.
 */
export function stackPanels(api: DockviewApi, anchor: string): string[] {
  const home = api.getPanel(anchor)?.group ?? api.groups[0]
  if (!home) return []
  if (api.hasMaximizedGroup()) api.exitMaximizedGroup()
  const moved: string[] = []
  for (const panel of [...api.panels]) {
    if (panel.group.id === home.id) continue
    panel.api.moveTo({ group: home })
    moved.push(panel.id)
  }
  return moved
}
