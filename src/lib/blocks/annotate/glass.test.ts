import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mirror } from './glass'

/**
 * The mirror copies a canvas the browser composites, and redraws it every frame.
 * happy-dom has no 2d backend (`getContext('2d')` answers null), no layout (an
 * IntersectionObserver there never reports an intersection), and a MediaStream
 * with no tracks, so the four things a mirror runs on are driven by hand here:
 * the frame queue, the visibility observer, the 2d context, and the capture.
 * What the test decides is when a frame arrives and whether the canvas is in
 * view; what it counts is what the mirror does about it.
 */

const real = {
  requestAnimationFrame: globalThis.requestAnimationFrame,
  cancelAnimationFrame: globalThis.cancelAnimationFrame,
  getComputedStyle: globalThis.getComputedStyle,
  IntersectionObserver: globalThis.IntersectionObserver,
  getContext: HTMLCanvasElement.prototype.getContext,
  captureStream: HTMLCanvasElement.prototype.captureStream,
}

/** What the mirror runs on, driven by hand. */
function rig() {
  const queue = new Map<number, FrameRequestCallback>()
  let ids = 0
  const watchers: Watcher[] = []

  /** One observer, reporting only what the test says. */
  class Watcher {
    targets: Element[] = []
    disconnected = false
    constructor(private callback: IntersectionObserverCallback) {
      watchers.push(this)
    }
    observe(target: Element) {
      this.targets.push(target)
    }
    unobserve(target: Element) {
      this.targets = this.targets.filter((each) => each !== target)
    }
    disconnect() {
      this.disconnected = true
      this.targets = []
    }
    takeRecords() {
      return []
    }
    root = null
    rootMargin = ''
    thresholds: number[] = []
    /** Delivers `isIntersecting` as one batch of entries, oldest first. */
    report(target: Element, ...intersecting: boolean[]) {
      if (this.disconnected) return
      const entries = intersecting.map(
        (isIntersecting) => ({ target, isIntersecting }) as unknown as IntersectionObserverEntry,
      )
      this.callback(entries, this as unknown as IntersectionObserver)
    }
  }

  /** One copy per `drawImage` on the mirror's context: the canvas it copied. */
  const copies: unknown[] = []
  /** One entry per `fillRect`: the size the frame was laid out at. */
  const fills: [number, number][] = []
  const tracks: { stopped: boolean }[] = []
  let reads = 0

  const context = {
    fillStyle: undefined as unknown,
    fillRect: (_x: number, _y: number, width: number, height: number) => {
      fills.push([width, height])
    },
    drawImage: (source: unknown, _x: number, _y: number) => {
      copies.push(source)
    },
  }

  globalThis.requestAnimationFrame = (callback) => {
    const id = ++ids
    queue.set(id, callback)
    return id
  }
  globalThis.cancelAnimationFrame = (id) => {
    queue.delete(id)
  }
  globalThis.getComputedStyle = (element: Element) => {
    reads++
    return real.getComputedStyle(element)
  }
  globalThis.IntersectionObserver = Watcher as unknown as typeof IntersectionObserver
  HTMLCanvasElement.prototype.getContext = ((kind: string) => (kind === '2d' ? context : null)) as typeof HTMLCanvasElement.prototype.getContext
  // A real MediaStream, since a video refuses anything else; happy-dom's own has
  // no tracks to stop, so the mirror is given one it can.
  HTMLCanvasElement.prototype.captureStream = () => {
    const track = { stopped: false }
    tracks.push(track)
    const stream = new MediaStream()
    Object.defineProperty(stream, 'getTracks', { value: () => [{ stop: () => void (track.stopped = true) }] })
    return stream
  }

  return {
    copies,
    fills,
    tracks,
    /** Frames the mirror has asked for and the browser has not yet run. */
    queued: () => queue.size,
    /** Reads the page colour, which a mirror does once per frame it draws. */
    reads: () => reads,
    /** The observers made so far, and what each watches. */
    watchers: () => watchers,
    /** Runs the frames waiting, one browser frame at a time. */
    frame: () => {
      const due = [...queue.values()]
      queue.clear()
      for (const callback of due) callback(0)
    },
    /** Reports the canvas in or out of view, as a browser would. */
    report(target: Element, ...intersecting: boolean[]) {
      // A disconnected observer is owed no report, as in a browser; an observer
      // that was never made means the mirror copies whether or not it is in view.
      if (!watchers.length) throw new Error('no IntersectionObserver: the mirror copies the canvas whether or not it is in view')
      for (const watcher of watchers) if (watcher.targets.includes(target)) watcher.report(target, ...intersecting)
    },
    restore() {
      queue.clear()
      globalThis.requestAnimationFrame = real.requestAnimationFrame
      globalThis.cancelAnimationFrame = real.cancelAnimationFrame
      globalThis.getComputedStyle = real.getComputedStyle
      globalThis.IntersectionObserver = real.IntersectionObserver
      HTMLCanvasElement.prototype.getContext = real.getContext
      HTMLCanvasElement.prototype.captureStream = real.captureStream
    },
  }
}

describe('the glass mirror', () => {
  let canvas: HTMLCanvasElement
  let view: ReturnType<typeof rig>
  let undos: (() => void)[]

  beforeEach(() => {
    view = rig()
    undos = []
    canvas = document.createElement('canvas')
    // Larger than a default canvas, so a mirror has to fit its copy to it.
    canvas.width = 640
    canvas.height = 360
    document.body.append(canvas)
  })

  afterEach(() => {
    for (const undo of undos) undo()
    view.restore()
    canvas.remove()
  })

  /** Mirrors the canvas, and remembers how to unmirror it. */
  const mirrored = () => {
    const undo = mirror(canvas)
    undos.push(undo)
    return undo
  }

  test('copies every frame the browser offers, while the canvas is in view', () => {
    mirrored()
    // Gated the way the scene is: one IntersectionObserver, on the canvas itself.
    expect(view.watchers().length).toBe(1)
    expect(view.watchers()[0]?.targets).toEqual([canvas])
    view.report(canvas, true)
    for (let i = 0; i < 3; i++) view.frame()
    expect(view.copies.length).toBe(3)
    expect(view.copies[0]).toBe(canvas)
    // The copy is fitted to the canvas, three frames of it, over the page's colour.
    expect(view.fills).toEqual([
      [640, 360],
      [640, 360],
      [640, 360],
    ])
    expect(view.reads()).toBe(3)
    // Still armed for the next one.
    expect(view.queued()).toBe(1)
  })

  test('copies nothing, and asks for no frame, while the canvas is out of view', () => {
    mirrored()
    view.frame()
    expect(view.copies.length).toBe(1)
    view.report(canvas, false)
    // The frame waiting for it is dropped, so no more frames can arrive.
    expect(view.queued()).toBe(0)
    view.frame()
    view.frame()
    view.frame()
    expect(view.copies).toHaveLength(1)
    expect(view.reads()).toBe(1)
    expect(view.queued()).toBe(0)
  })

  test('back in view, it queues one frame and starts copying again', () => {
    mirrored()
    view.report(canvas, false)
    view.report(canvas, true)
    // Exactly one frame, however many times it was told it was visible.
    expect(view.queued()).toBe(1)
    view.frame()
    expect(view.copies.length).toBe(1)
    expect(view.queued()).toBe(1)
    view.report(canvas, true)
    expect(view.queued()).toBe(1)
    view.frame()
    expect(view.copies.length).toBe(2)
    view.report(canvas, false)
    view.report(canvas, false)
    expect(view.queued()).toBe(0)
  })

  test('a batch of reports is decided by the last one, as the scene reads them', () => {
    mirrored()
    view.report(canvas, false)
    expect(view.queued()).toBe(0)
    // Laid out in the frame it was observed: out of view, then in, in one call.
    view.report(canvas, false, true)
    expect(view.queued()).toBe(1)
    view.frame()
    expect(view.copies.length).toBe(1)
    view.report(canvas, true, false)
    expect(view.queued()).toBe(0)
    view.frame()
    expect(view.copies).toHaveLength(1)
  })

  test('a canvas resized out of view is refitted by the frame that returns', () => {
    mirrored()
    view.report(canvas, false)
    // The scene can redraw its canvas at another size while nobody is looking.
    Object.assign(canvas, { width: 800, height: 480 })
    view.report(canvas, true)
    view.frame()
    expect(view.fills).toEqual([[800, 480]])
    expect(view.copies.length).toBe(1)
    // And not twice: the refit is a per-frame check, not a second loop.
    view.frame()
    expect(view.fills).toEqual([
      [800, 480],
      [800, 480],
    ])
  })

  test('unmirroring stops the copy loop, the observer, and the capture', () => {
    const undo = mirrored()
    view.report(canvas, true)
    view.frame()
    undo()
    expect(view.queued()).toBe(0)
    expect(view.watchers()[0]?.disconnected).toBe(true)
    expect(view.tracks.map((track) => track.stopped)).toEqual([true])
    expect(canvas.getAttribute('data-liquid-ignore')).toBeNull()
    expect(document.querySelector('video.tn-glass-mirror')).toBeNull()
    expect(document.querySelector('span.tn-theme')).toBeNull()
    // Nothing restarts it: no frames, no report, no copy.
    view.frame()
    view.report(canvas, true)
    view.frame()
    expect(view.copies).toHaveLength(1)
    expect(view.queued()).toBe(0)
  })
})
