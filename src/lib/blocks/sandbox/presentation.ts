// SOURCING: none: where the page shows this frame and the room it has, as the
// page sends it (`presentation.changed`). It is written on the root as
// `data-theorem-presentation` and `--theorem-available-width/height` for CSS,
// and told to listeners, so an App fits its picture to the room it is given
// instead of to the size the host first gave its frame. The App keeps
// running across a change: nothing here reloads it.
import type { Presentation } from './protocol'

/** Dispatched on window after each change, for code that does not use `onChange`. */
export const PRESENTATION_EVENT = 'theorem:presentation'

let current: Presentation | undefined
const listeners = new Set<(presentation: Presentation) => void>()

export function applyPresentation(presentation: Presentation): void {
  current = presentation
  const root = document.documentElement
  root.dataset.theoremPresentation = presentation.mode
  root.style.setProperty('--theorem-available-width', `${presentation.width}px`)
  root.style.setProperty('--theorem-available-height', `${presentation.height}px`)
  for (const listener of listeners) listener(presentation)
  window.dispatchEvent(new Event(PRESENTATION_EVENT))
}

/** The presentation now, once the page has sent one. */
export const presentationNow = (): Presentation | undefined => current

/** Calls `listener` with the presentation now, if there is one, and after each change. */
export function onPresentation(listener: (presentation: Presentation) => void): () => void {
  listeners.add(listener)
  if (current) listener(current)
  return () => listeners.delete(listener)
}
