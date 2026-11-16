// SOURCING: React's useSyncExternalStore over localStorage and the window's storage event, so a setting changed in Settings, Appearance changes every open record table at once, and another tab's change is taken up; storage that cannot be read or written leaves the setting held for this visit only
import { useSyncExternalStore } from 'react'

/** Per browser: whether record tables show the Calculate row under their records. */
export const CALCULATIONS_KEY = 'theorem.crm.calculations'

const listeners = new Set<() => void>()
// What was last set here, used only when storage cannot be read.
let held = false

function read() {
  try {
    return window.localStorage.getItem(CALCULATIONS_KEY) === 'on'
  } catch {
    return held
  }
}

export function setCalculationsShown(on: boolean) {
  held = on
  try {
    window.localStorage.setItem(CALCULATIONS_KEY, on ? 'on' : 'off')
  } catch {
    // Kept for this visit only.
  }
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === CALCULATIONS_KEY) listener()
  }
  window.addEventListener('storage', onStorage)
  return () => {
    listeners.delete(listener)
    window.removeEventListener('storage', onStorage)
  }
}

/** Whether calculations show under record tables. Off until turned on. */
export function useCalculationsShown() {
  return useSyncExternalStore(subscribe, read, () => false)
}
