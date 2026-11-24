// SOURCING: ResizeObserver; the page's end of `presentation.changed`
// (sandbox/presentation.ts). A frame is told where it is shown and the room
// it has once it connects and whenever either changes, so an App sizes its
// picture to the room and is never reloaded to fit.
import { createContext } from 'react'
import type { FrameConnection } from './executor'
import { call } from './sandbox/protocol'
import type { Presentation, PresentationMode, SandboxMethods } from './sandbox/protocol'

/** Where the frames inside are shown; a reply's are `inline` unless a surface says otherwise. */
export const FramePresentation = createContext<PresentationMode>('inline')

/** The attribute on the element whose height a panel's or an expanded frame's room is. */
export const PRESENTATION_ROOM = 'data-presentation-room'

/** The height an inline frame may fill: the same bounds as a filling frame's (FILL_HEIGHT). */
const inlineHeight = () => Math.round(Math.min(720, Math.max(360, window.innerHeight * 0.7)))

function measure(element: HTMLElement, mode: PresentationMode): Presentation {
  const room = element.closest<HTMLElement>(`[${PRESENTATION_ROOM}]`)
  const height = mode === 'inline' || !room ? inlineHeight() : room.clientHeight
  return { mode, width: Math.round(element.clientWidth), height }
}

/**
 * Sends `connection`'s frame its presentation, measured on `element`, now and
 * after each change of size or of `mode()`. Returns `update`, to call when the
 * mode changes, and `stop`.
 */
export function followPresentation(
  connection: FrameConnection,
  element: HTMLElement,
  mode: () => PresentationMode,
): { update: () => void; stop: () => void } {
  let sent = ''
  let send = () => {}
  let active = true
  const observer = new ResizeObserver(() => send())
  void connection.connected.then(
    (rpc) => {
      if (!active) return
      send = () => {
        const presentation = measure(element, mode())
        const key = JSON.stringify(presentation)
        if (key === sent) return
        sent = key
        // A frame without the App bridge (a cell's) does not serve it.
        void call<SandboxMethods, 'presentation.changed'>(rpc, 'presentation.changed', presentation).catch(() => {})
      }
      send()
      observer.observe(element)
      const room = element.closest<HTMLElement>(`[${PRESENTATION_ROOM}]`)
      if (room) observer.observe(room)
      window.addEventListener('resize', send)
    },
    () => {},
  )
  return {
    update: () => send(),
    stop: () => {
      active = false
      observer.disconnect()
      window.removeEventListener('resize', send)
    },
  }
}
