// SOURCING: none — pure logic over the person's placement choice, the delivery switch and the shell mode; no upstream component applies.
import type { ShellMode } from '@/components/shell/modes'

/** Where the workbench is drawn: over the whole sheet, docked beside the sheet, or docked under it. */
export type Placement = 'full' | 'side' | 'bottom'

/** The placements that leave the conversation and its composer on screen. */
export type Companion = Exclude<Placement, 'full'>

/** What the person last chose: a placement, or closed. */
export type PlacementChoice = Placement | 'closed'

/**
 * Where the workbench is drawn now, or `undefined` when it is not. With no
 * choice made, the delivery switch (ARCHITECTURE section 1) puts it full screen
 * in chat mode. Full screen replaces only the conversation, so in another mode
 * it is not drawn; side and bottom sit beside whichever mode is showing.
 */
export function placementOf(
  choice: PlacementChoice | undefined,
  switchOn: boolean,
  mode: ShellMode,
): Placement | undefined {
  const wanted = choice ?? (switchOn ? 'full' : 'closed')
  if (wanted === 'closed') return undefined
  if (wanted === 'full') return mode === 'chat' ? 'full' : undefined
  return wanted
}

/**
 * What a toggle chooses: the companion asked for (or the one last used) when
 * the workbench is elsewhere, and closed when it is already there.
 */
export function toggledPlacement(
  current: Placement | undefined,
  last: Companion,
  wanted: Companion = last,
): PlacementChoice {
  return current === wanted ? 'closed' : wanted
}
