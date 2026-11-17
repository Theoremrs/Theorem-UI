// SOURCING: a plain listener set. Both fields keep their pixels between frames (textmode.js creates its context with preserveDrawingBuffer; the 2D field is a 2D canvas), so a reader can sample the canvas whenever it likes; this says when there is something new to sample, and replays the last frame to a reader that subscribes after it was drawn (a paused field draws only once). Liquid glass (components/glass/liquid-glass) is the reader.

type Listener = (canvas: HTMLCanvasElement) => void

const listeners = new Set<Listener>()
/** The canvas of the last frame drawn. A paused field draws once, at mount,
 *  so a reader that starts later hears that frame on subscribing. */
let last: HTMLCanvasElement | undefined

/** Hears each frame the Life field draws, with the canvas it drew on,
 *  starting with the last frame already drawn. */
export function onLifeFrame(listener: Listener): () => void {
  listeners.add(listener)
  if (last?.isConnected) listener(last)
  return () => {
    listeners.delete(listener)
  }
}

/** Called by a field at the end of each draw. */
export function publishLifeFrame(canvas: HTMLCanvasElement) {
  last = canvas
  for (const listener of listeners) listener(canvas)
}
