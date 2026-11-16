// SOURCING: none — reads the shell's zustand state, the route's mode and the delivery switch through React's useSyncExternalStore; the rules are placement.ts.
import { useEffect, useEffectEvent, useSyncExternalStore } from 'react'
import { useShellMode } from '@/components/shell/modes'
import { useShell } from '@/components/shell/shell-state'
import { placementOf, toggledPlacement } from './placement'
import type { Companion, Placement } from './placement'
import { readWorkbenchSwitch } from './workbench-switch'

/**
 * Where the workbench is drawn on this page, and a toggle that opens it beside
 * the conversation (the companion asked for, or the one last used) or closes it
 * when it is already there.
 */
export function useWorkbenchPlacement(): {
  placement: Placement | undefined
  toggle: (wanted?: Companion) => void
} {
  const mode = useShellMode()
  // The opt-in delivery switch (ARCHITECTURE section 1); off on the server.
  const switchOn = useSyncExternalStore(
    () => () => {},
    readWorkbenchSwitch,
    () => false,
  )
  const choice = useShell((s) => s.workbench)
  const placement = placementOf(choice, switchOn, mode)
  const toggle = (wanted?: Companion) => {
    const shell = useShell.getState()
    shell.setWorkbench(toggledPlacement(placement, shell.lastCompanion, wanted))
  }
  return { placement, toggle }
}

/** ctrl+` toggles the workbench under the conversation. */
export function useWorkbenchShortcut(toggle: (wanted?: Companion) => void) {
  const toggleBottom = useEffectEvent(() => toggle('bottom'))
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.key === '`') {
        event.preventDefault()
        toggleBottom()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}
