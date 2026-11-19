// SOURCING: liquidGL (`liquid-gl`, MIT) refracts what is behind a surface in
// WebGPU or WebGL, frosted and bevelled, with its own CSS backdrop-filter where
// neither runs. What is ours is fitting it to live chrome:
// - liquidGL hides the element it glasses and draws that element's content in
//   its canvas. A note's buttons and composer must stay live DOM, so each
//   surface gets an empty pane behind its content, and the pane is the lens
//   (`content: false`).
// - It refracts a snapshot it rasterises once, and video live. A canvas in the
//   scene (WebGL, redrawn every frame) is mirrored into a video for it, out of
//   sight, and kept out of the snapshot; the mirror is opaque, drawn over the
//   page's colour, since a capture mangles a transparent canvas's faint pixels.
// - Its tint only darkens (it multiplies), so how much of the surface colour
//   lies over the glass is a veil in CSS: `--tn-glass-veil`.
import liquidGL from 'liquid-gl'
import type { LiquidGLLens } from 'liquid-gl'
import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import type { CSSProperties, ReactNode } from 'react'

/** How a glass surface looks. */
export interface GlassOptions {
  /** How much of the surface colour lies over the glass, 0 to 1; the rest is what is behind it. */
  veil: number
  /** Blur of what is behind, in pixels. */
  frost: number
  /** Refraction across the pane, 0 to 1. */
  refraction: number
  /** Extra refraction at the edge, 0 to 1. */
  bevelDepth: number
  /** The edge's width, as a share of the shorter side. */
  bevelWidth: number
  /** Colour dispersion at the edge, 0 to 1. */
  aberration: number
  /** Light moving across the glass. */
  specular: boolean
}

/** The default: most of what is behind stays in sight, frosted enough to read over. */
export const GLASS: GlassOptions = {
  veil: 0.42,
  frost: 3,
  refraction: 0.01,
  bevelDepth: 0.052,
  bevelWidth: 0.211,
  aberration: 0,
  specular: true,
}

/** The stacking order of the glass: its canvas sits one below, the chrome above at 2. */
export const GLASS_Z = 2

interface Scope {
  /** Selects the element whose look the glass refracts. */
  snapshot: string
  options: GlassOptions
}

const ScopeContext = createContext<Scope | null>(null)
let counter = 0

/**
 * Where glass surfaces refract `snapshot`: the scene under the chrome. Its
 * canvases are mirrored into videos so the glass follows them as they redraw.
 * liquidGL draws in the nearest fixed or sticky ancestor of a surface (else the
 * body), at GLASS_Z - 1: chrome over the scene stacks at GLASS_Z there.
 */
export function GlassScope({ snapshot, options, children }: {
  snapshot: HTMLElement | null
  /** Over the default; `false` leaves the surfaces in CSS. */
  options?: Partial<GlassOptions> | false
  children?: ReactNode
}) {
  const id = useMemo(() => `g${++counter}`, [])
  // Layout effects run before any surface's lens is made in a passive one:
  // liquidGL finds the videos when it makes its renderer, with the first lens.
  useLayoutEffect(() => {
    if (!snapshot || options === false) return
    snapshot.dataset.glassSnapshot = id
    const canvases = [...snapshot.querySelectorAll('canvas')].filter((canvas) => !canvas.closest('[data-liquid-ignore]'))
    const mirrors = canvases.map(mirror)
    return () => {
      delete snapshot.dataset.glassSnapshot
      for (const undo of mirrors) undo()
    }
  }, [snapshot, id, options === false])
  const key = JSON.stringify(options)
  const scope = useMemo<Scope | null>(
    () => (snapshot && options !== false ? { snapshot: `[data-glass-snapshot="${id}"]`, options: { ...GLASS, ...options } } : null),
    // `key` stands for the options' contents.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [snapshot, id, key],
  )
  return <ScopeContext.Provider value={scope}>{children}</ScopeContext.Provider>
}

/**
 * A video of `canvas` under it, which liquidGL reads live; the canvas leaves
 * its snapshot. A WebGL canvas over the page is transparent, and its faint
 * pixels (a shadow, a glow) come out of a capture banded and bright, so the
 * video is of an opaque copy: each frame drawn over the page's colour, the
 * theme's `--color-background-body`, read again as the mode changes.
 *
 * A canvas is copied only while it is in sight, gated by an IntersectionObserver
 * as the scene's own loop is. A conversation mirrors every canvas in its
 * snapshot, and the ones scrolled past would else copy a full canvas every frame
 * nobody has a chance of seeing (PR 139 P2).
 *
 * Exported for `glass.test.ts`, which drives its frames by hand; `GlassScope`
 * is its only other caller.
 */
export function mirror(canvas: HTMLCanvasElement): () => void {
  const page = document.createElement('span')
  page.className = 'tn-theme'
  page.hidden = true
  page.style.backgroundColor = 'var(--color-background-body)'
  canvas.before(page)
  const flat = document.createElement('canvas')
  const context = flat.getContext('2d', { alpha: false })!
  // One frame in flight, and only while the canvas is in sight.
  let frame: number | null = null
  const draw = () => {
    if (flat.width !== canvas.width || flat.height !== canvas.height) Object.assign(flat, { width: canvas.width, height: canvas.height })
    context.fillStyle = getComputedStyle(page).backgroundColor
    context.fillRect(0, 0, flat.width, flat.height)
    context.drawImage(canvas, 0, 0)
    // With no copy, the capture sends no frame: the video idles by itself.
    frame = requestAnimationFrame(draw)
  }
  // Whether the canvas is in sight, said by whether a frame is owed. `start` is
  // called for every report that finds it in sight, however many of them there
  // are; it cannot stack a second frame on the one already owed.
  const start = () => {
    if (frame === null) frame = requestAnimationFrame(draw)
  }
  const stop = () => {
    if (frame !== null) cancelAnimationFrame(frame)
    frame = null
  }
  // A frame is owed from the first chance to draw, as the scene's is, before the
  // observer's own first report says whether that chance is anywhere in sight.
  start()
  const video = document.createElement('video')
  video.muted = true
  video.playsInline = true
  video.autoplay = true
  video.setAttribute('aria-hidden', 'true')
  video.className = 'tn-glass-mirror'
  // Laid where the canvas is, so liquidGL places its frames there; clipped to
  // nothing, so only the canvas is seen.
  const place = () =>
    Object.assign(video.style, { left: `${canvas.offsetLeft}px`, top: `${canvas.offsetTop}px`, width: `${canvas.offsetWidth}px`, height: `${canvas.offsetHeight}px` })
  video.style.cssText = 'position:absolute;clip-path:inset(50%);pointer-events:none'
  place()
  const stream = flat.captureStream()
  video.srcObject = stream
  canvas.before(video)
  void video.play().catch(() => {})
  const fit = new ResizeObserver(place)
  fit.observe(canvas)
  // The scene's own gate, and the same rule about its reports: entries arrive
  // batched, oldest first, so the last one holds.
  const watcher = new IntersectionObserver((entries) => {
    if (entries.at(-1)?.isIntersecting) start()
    else stop()
  })
  watcher.observe(canvas)
  canvas.setAttribute('data-liquid-ignore', '')
  return () => {
    stop()
    watcher.disconnect()
    fit.disconnect()
    for (const track of stream.getTracks()) track.stop()
    video.remove()
    page.remove()
    canvas.removeAttribute('data-liquid-ignore')
  }
}

/**
 * The glass behind a surface: put it first inside the surface, which must be
 * positioned. Inside a GlassScope it is a liquidGL lens and marks the surface
 * `data-glass="gl"`, or `"backdrop"` where liquidGL fell back to a CSS blur;
 * outside one the surface is `data-glass="css"` and blurs what is behind it.
 */
export function Glass() {
  const scope = useContext(ScopeContext)
  const pane = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    const element = pane.current
    const surface = element?.parentElement
    if (!element || !surface) return
    surface.style.setProperty('--tn-glass-veil', `${Math.round((scope?.options.veil ?? GLASS.veil) * 100)}%`)
    let lens: LiquidGLLens | undefined
    if (scope && liquidGL) {
      element.dataset.glassPane = `p${++counter}`
      const { veil: _veil, ...look } = scope.options
      try {
        const made = liquidGL({
          ...look,
          target: `[data-glass-pane="${element.dataset.glassPane}"]`,
          snapshot: scope.snapshot,
          content: false,
          zIndex: GLASS_Z,
          shadow: false,
          reveal: 'none',
          tint: null,
        })
        lens = Array.isArray(made) ? made[0] : made
        // Its canvas is decoration: kept from assistive technology, and so
        // left out first where a copy of the App is too large.
        ;(lens?.renderer as { canvas?: HTMLCanvasElement } | null | undefined)?.canvas?.setAttribute('aria-hidden', 'true')
      } catch {
        lens = undefined
      }
    }
    // A lens with no renderer is liquidGL's own fallback, a backdrop blur on the pane.
    surface.dataset.glass = lens ? (lens.renderer ? 'gl' : 'backdrop') : 'css'
    return () => {
      lens?.destroy()
      delete surface.dataset.glass
      delete element.dataset.glassPane
    }
  }, [scope])
  return <span ref={pane} className="tn-glass" aria-hidden="true" style={PANE} />
}

const PANE: CSSProperties = { position: 'absolute', inset: 0, borderRadius: 'inherit', pointerEvents: 'none', zIndex: -1 }
