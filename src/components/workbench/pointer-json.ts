// SOURCING: none — the DOM mouse, pointer and wheel events as the JSON the Rust workbench's PointerInput reads; the field names are serde's (terminal/src/workbench.rs)
type PointerLike = {
  button?: number
  clientX: number
  clientY: number
  deltaX?: number
  deltaY?: number
  deltaMode?: number
  /** The press count: the DOM puts it on `mousedown`, and leaves it 0 on `pointerdown`. */
  detail: number
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  metaKey: boolean
}

export type PointerType = 'down' | 'up' | 'move' | 'wheel'

export function pointerJson(type: PointerType, event: PointerLike): string {
  const button = event.button ?? 0
  return JSON.stringify({
    type,
    button: ['left', 'middle', 'right'][
      button >= 0 && button <= 2 ? button : 0
    ],
    clientX: event.clientX,
    clientY: event.clientY,
    deltaX: event.deltaX ?? 0,
    deltaY: event.deltaY ?? 0,
    deltaMode: event.deltaMode ?? 0,
    // A single press when the event carries no count.
    detail: event.detail || 1,
    ctrlKey: event.ctrlKey,
    altKey: event.altKey,
    shiftKey: event.shiftKey,
    metaKey: event.metaKey,
  })
}
