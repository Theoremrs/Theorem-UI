// SOURCING: none — pure logic over the person's placement choice, the delivery switch and the shell mode; no upstream component applies.
import type { ShellMode } from '@/components/shell/modes'
import { CONVERSATION_MIN_WIDTH, WORKBENCH_MIN_WIDTH } from './dock-geometry'

/** Where the workbench is drawn: over the whole sheet, docked beside the sheet, or docked under it. */
export type Placement = 'full' | 'side' | 'bottom'

/** The placements that leave the conversation and its composer on screen. */
export type Companion = Exclude<Placement, 'full'>

/** What the person last chose: a placement, or closed. */
export type PlacementChoice = Placement | 'closed'

/**
 * How the workbench sits beside or under the conversation, set in Settings: a
 * drawer over the screen that a double-click outside closes, or part of the
 * screen, docked, with the conversation giving up room for it.
 */
export type Attachment = 'drawer' | 'docked'

export function dockPresentation(
  placement: Placement | undefined,
  viewport: number,
): Placement | undefined {
  return placement === 'side' &&
    viewport < WORKBENCH_MIN_WIDTH + CONVERSATION_MIN_WIDTH
    ? 'bottom'
    : placement
}

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

/**
 * What showing the sheet asks of the workbench: full screen covers the sheet,
 * so it moves beside the conversation (the companion last used); anywhere else
 * the sheet already shows and nothing moves (`undefined`).
 */
export function sheetShown(
  current: Placement | undefined,
  last: Companion,
): Companion | undefined {
  return current === 'full' ? last : undefined
}
