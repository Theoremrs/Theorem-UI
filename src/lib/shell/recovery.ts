// SOURCING: zustand (the action list is a store, so a release manager that
// loads later still appears on a recovery page already open), the handler
// preference store, the layout store and the failure record. Recovery is the
// spec's EXEC-05; the actions never delete data (it moves or resets choices).
import { create } from 'zustand'
import { useHandlerPreferences } from '@/lib/contributions/registry'
import { useFailures } from './failures'
import { useShell } from '@/components/shell/shell-state'
import { resetLayouts, useLayoutStore } from './layout-store'

export interface RecoveryOutcome {
  ok: boolean
  message: string
}

export interface RecoveryAction {
  /** Namespaced and stable: `theorem.recovery.restore-shell`. */
  id: string
  label: string
  description: string
  /** Where it sits on the recovery page; the host's own come first. */
  order?: number
  run: () => RecoveryOutcome | Promise<RecoveryOutcome>
}

interface ActionStore {
  actions: ReadonlyArray<RecoveryAction>
}

const useRecoveryActions = create<ActionStore>()(() => ({ actions: [] }))
export { useRecoveryActions }

/**
 * Adds an action to the host-owned recovery page; the releases workstream
 * plugs "select the last working release" in here. A repeated id replaces the
 * earlier one. Returns a function that removes exactly this registration.
 */
export function registerRecoveryAction(action: RecoveryAction): () => void {
  useRecoveryActions.setState((state) => ({
    actions: [...state.actions.filter((one) => one.id !== action.id), action],
  }))
  return () =>
    useRecoveryActions.setState((state) => ({
      actions: state.actions.filter((one) => one !== action),
    }))
}

export const recoveryActions = (
  actions = useRecoveryActions.getState().actions,
) =>
  [...actions]
    .map((action, at) => ({ action, at }))
    .sort(
      (a, b) =>
        (a.action.order ?? 100) - (b.action.order ?? 100) || a.at - b.at,
    )
    .map(({ action }) => action)

/** The shipped shell is selected again; installed shells stay installed. */
export function restoreShippedShell(): RecoveryOutcome {
  const { shell } = useHandlerPreferences.getState()
  useHandlerPreferences.getState().selectShell(undefined)
  return {
    ok: true,
    message: shell
      ? `Back on the shipped shell. ${shell} is still installed.`
      : 'The shipped shell was already in use.',
  }
}

/** Default handlers go back to the shipped order; the shell choice is kept. */
export function resetDefaultHandlers(): RecoveryOutcome {
  useHandlerPreferences.setState({
    byResource: {},
    byServes: {},
    workspace: {},
    hidden: [],
  })
  return {
    ok: true,
    message: 'Default handlers are back to the shipped order. No data changed.',
  }
}

/**
 * Sets the stored layouts aside and starts from the shipped one. The
 * `revision` is the one the page was showing: if a layout was saved since, the
 * reset is refused so it does not discard an arrangement the person has not
 * seen. Reset layouts are kept as preserved copies, never deleted.
 */
export function resetLayoutChecked(revision: number): RecoveryOutcome {
  const legacy = useShell.getState().layouts
  const result = resetLayouts(revision, legacy)
  if (result.ok) useShell.setState({ layouts: {} })
  return result.ok
    ? {
        ok: true,
        message: `Layout reset. ${result.preserved} earlier arrangement${result.preserved === 1 ? '' : 's'} kept aside.`,
      }
    : {
        ok: false,
        message:
          'The layout changed while this page was open. Review it and try again.',
      }
}

export function clearFailures(): RecoveryOutcome {
  useFailures.getState().clear()
  return { ok: true, message: 'The failure record was cleared.' }
}

export const layoutRevision = () => useLayoutStore.getState().revision

/**
 * The host's own recovery actions. They read only host-owned stores, so they
 * work with every installed shell, handler and module broken. Resetting the
 * layout is offered by the recovery page itself, which holds the revision it
 * showed (resetLayoutChecked).
 */
registerRecoveryAction({
  id: 'theorem.recovery.restore-shell',
  label: 'Restore the shipped shell',
  description:
    'Selects the shipped navigation and tab chrome again. Installed shells stay installed.',
  order: 10,
  run: restoreShippedShell,
})
registerRecoveryAction({
  id: 'theorem.recovery.reset-handlers',
  label: 'Reset default handlers',
  description:
    'Clears your handler choices and hidden built-ins so the shipped handlers serve. No data changes.',
  order: 20,
  run: resetDefaultHandlers,
})
