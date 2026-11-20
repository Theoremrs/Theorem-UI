// SOURCING: none — a document dblclick listener under React's effects; nothing upstream closes a non-modal drawer on a double-click outside it
import { useEffect, useLayoutEffect, useRef } from 'react'

/**
 * Closes a drawer when the person double-clicks anywhere outside every
 * terminal drawer, while it is open.
 */
export function useCloseOnOutsideDoubleClick(open: boolean, close: () => void) {
  const latest = useRef(close)
  useLayoutEffect(() => {
    latest.current = close
  })
  useEffect(() => {
    if (!open) return
    const onDoubleClick = (event: MouseEvent) => {
      if (
        event.target instanceof Element &&
        event.target.closest('[data-terminal-drawer]')
      )
        return
      latest.current()
    }
    document.addEventListener('dblclick', onDoubleClick)
    return () => document.removeEventListener('dblclick', onDoubleClick)
  }, [open])
}
