// SOURCING: none — pure logic over two browser reads (the query string and localStorage); no upstream component applies.

/** The delivery switch of ARCHITECTURE section 1: removed with the classic chat interior at Gate 6. */
export const WORKBENCH_STORAGE_KEY = 'theorem-ui:workbench'

/**
 * Whether this browser opted in to the workbench: `?workbench=1` in the URL, or
 * `localStorage['theorem-ui:workbench'] === '1'`. Storage may be absent or throw
 * (a private window, blocked site data); the switch is then off.
 */
export function workbenchEnabled(
  search: string,
  storage: Pick<Storage, 'getItem'> | undefined,
): boolean {
  if (new URLSearchParams(search).get('workbench') === '1') return true
  try {
    return storage?.getItem(WORKBENCH_STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

/** The switch as this page reads it. False on the server, where there is no page to opt in. */
export function readWorkbenchSwitch(): boolean {
  if (typeof window === 'undefined') return false
  let storage: Storage | undefined
  try {
    storage = window.localStorage
  } catch {
    storage = undefined
  }
  return workbenchEnabled(window.location.search, storage)
}
