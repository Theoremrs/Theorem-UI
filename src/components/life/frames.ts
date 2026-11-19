// SOURCING: a plain listener set. Both fields keep their pixels between frames (textmode.js creates its context with preserveDrawingBuffer; the 2D field is a 2D canvas), so a reader can sample the canvas whenever it likes; this says when there is something new to sample, and replays the last frame to a reader that subscribes after it was drawn (a paused field draws only once). Liquid glass (components/glass/liquid-glass) is the reader. Visibility uses the platform's ResizeObserver, IntersectionObserver, MutationObserver and visibilitychange rather than a polling loop.

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

/** Whether the document and the element can currently show pixels. */
export function isVisible(element: Element): boolean {
  return (
    element.isConnected &&
    document.visibilityState === 'visible' &&
    element.checkVisibility({
      visibilityProperty: true,
      opacityProperty: true,
      contentVisibilityAuto: true,
    })
  )
}

/** Calls `onChange` when the element or document becomes visible or hidden. */
export function observeVisibility(
  element: Element,
  onChange: () => void,
): () => void {
  let visible = isVisible(element)
  const sync = () => {
    const next = isVisible(element)
    if (next === visible) return
    visible = next
    onChange()
  }
  const resize = new ResizeObserver(sync)
  resize.observe(element)
  const intersection = new IntersectionObserver(sync)
  intersection.observe(element)
  const mutation = new MutationObserver(sync)
  const targets = new Set<Element>([document.documentElement])
  for (let node: Element | null = element; node; node = node.parentElement)
    targets.add(node)
  for (const target of targets)
    mutation.observe(target, {
      attributes: true,
      attributeFilter: ['class', 'style', 'hidden'],
    })
  document.addEventListener('visibilitychange', sync)
  window.addEventListener('resize', sync)
  return () => {
    resize.disconnect()
    intersection.disconnect()
    mutation.disconnect()
    document.removeEventListener('visibilitychange', sync)
    window.removeEventListener('resize', sync)
  }
}
