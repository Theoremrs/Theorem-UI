// SOURCING: native ResizeObserver, IntersectionObserver and MutationObserver signal the shared on-demand redraw frame; scroll and visibility signals cover movement and hiding. Life frames arrive through life/frames.ts. Materials are CSS custom properties (styles.css --lg-*), read with getComputedStyle; colours resolve to sRGB through a 1px canvas, as mount-life.ts resolves its palette. Where WebGL is missing, the context is lost, or the person asks for less transparency, the element keeps its CSS frost.
import { useEffect, useState } from 'react'
import type { RefObject } from 'react'
import {
  isVisible,
  observeVisibility,
  onLifeFrame,
} from '@/components/life/frames'
import { GlassRenderer } from './renderer'
import type { Material, Rgb, Scene } from './renderer'

export interface LiquidEdges {
  top: boolean
  right: boolean
  bottom: boolean
  left: boolean
}

/**
 * A surface the pane runs on into past its right side: a selector for that
 * pane, whose box spreads the light so the highlight runs on from one into
 * the other, and whether a concave fillet (--lg-fillet) joins them above and
 * below. The fillets are drawn inside the pane's own box.
 */
export interface LiquidJoin {
  pane: string
  top: boolean
  bottom: boolean
}

const ALL_EDGES: LiquidEdges = {
  top: true,
  right: true,
  bottom: true,
  left: true,
}

/** A side left out runs on past the element, so nothing bends there. */
const RUN_ON = 4096
/** A fresh Life frame is sampled at most thirty times a second. */
const FIELD_INTERVAL = 1000 / 30

interface Entry {
  canvas: HTMLCanvasElement
  edges: LiquidEdges
  join?: LiquidJoin
  /** --lg-fillet, the radius of a join's fillets. */
  fillet: number
  material: Material
  radius: number
  /** The sheet's gradient ends, --sheet-top and --sheet-shade. */
  from: Rgb
  shade: Rgb
  key: string
  drawn: number
  visible: boolean
  stopGeometry: (() => void) | null
}

const probe =
  typeof document === 'undefined' ? undefined : document.createElement('canvas')

function rgb(value: string): Rgb {
  const context = probe?.getContext('2d', { willReadFrequently: true })
  if (!context || !value) return [128, 128, 128]
  context.clearRect(0, 0, 1, 1)
  context.fillStyle = value
  context.fillRect(0, 0, 1, 1)
  const [r = 0, g = 0, b = 0] = context.getImageData(0, 0, 1, 1).data
  return [r, g, b]
}

function readMaterial(element: Element) {
  const style = getComputedStyle(element)
  const backdropBlur =
    CSS.supports('backdrop-filter', 'blur(1px)') ||
    CSS.supports('-webkit-backdrop-filter', 'blur(1px)')
  const value = (name: string) => style.getPropertyValue(name).trim()
  const number = (name: string, fallback: number) => {
    const parsed = Number.parseFloat(value(name))
    return Number.isFinite(parsed) ? parsed : fallback
  }
  // A pane over something other than the sheet (the rail's tab, over the
  // rail) has nothing of its own to show through: --lg-backdrop: none, and
  // it draws what the thinned body would show, the field over the sheet.
  const seen = backdropBlur ? number('--lg-show', 0) : 0
  const thin = value('--lg-backdrop') === 'none' ? 1 - seen : 1
  const show = thin === 1 ? seen : 0
  const body = number('--lg-body', 0.7) * thin
  return {
    // A pane attached on one side squares those corners; the others carry
    // its radius.
    radius: Math.max(
      Number.parseFloat(style.borderTopLeftRadius) || 0,
      Number.parseFloat(style.borderTopRightRadius) || 0,
    ),
    from: rgb(value('--sheet-top')),
    shade: rgb(value('--sheet-shade')),
    material: {
      blur: number('--lg-blur', 12),
      bevel: number('--lg-bevel', 14),
      refract: number('--lg-refract', 8),
      clarity: number('--lg-clarity', 0.8),
      tone: rgb(value('--lg-tone')),
      body,
      bodyLow: number('--lg-body-low', body / thin) * thin,
      split: number('--lg-body-split', 1),
      rimBody: number('--lg-rim-body', 0.4),
      lift: number('--lg-lift', 0),
      saturate: number('--lg-saturate', 1.2),
      light: number('--lg-light', 0.3),
      sheen: number('--lg-sheen', 0),
      stroke: number('--lg-stroke', 0.1),
      shade: number('--lg-shade', 0.2),
      show,
    },
    fillet: number('--lg-fillet', 0),
  }
}

/** WebGL, and a person who has not asked for less transparency. */
function available() {
  if (typeof window === 'undefined') return false
  if (window.matchMedia('(prefers-reduced-transparency: reduce)').matches)
    return false
  return true
}

/** Whether the person currently asks for less transparency, live: a change
 *  while a pane is mounted must take effect, not only at activation. */
function useReducedTransparency(): boolean {
  const [reduced, setReduced] = useState(
    () =>
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-transparency: reduce)').matches,
  )
  useEffect(() => {
    if (typeof window === 'undefined') return
    const query = window.matchMedia('(prefers-reduced-transparency: reduce)')
    const onChange = () => setReduced(query.matches)
    onChange()
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])
  return reduced
}

class Glass {
  private renderer: GlassRenderer | null = null
  private readonly entries = new Map<HTMLElement, Entry>()
  private field: HTMLCanvasElement | null = null
  private fieldFresh = false
  private frame = 0
  private stopField: (() => void) | null = null
  private themeObserver: MutationObserver | null = null
  private theme = 0
  private themeFrame = 0
  private fieldTimer: ReturnType<typeof setTimeout> | null = null
  private scrollFrame = 0
  private stopScroll: (() => void) | null = null
  private started = false
  private stopDocument: (() => void) | null = null

  /** False where the element should keep its CSS frost. */
  add(element: HTMLElement, edges: LiquidEdges): boolean {
    if (!this.renderer) {
      try {
        this.renderer = new GlassRenderer((lost) => this.onLost(lost))
      } catch {
        return false
      }
    }
    const canvas = document.createElement('canvas')
    canvas.dataset.liquidCanvas = ''
    canvas.setAttribute('aria-hidden', 'true')
    // Over the border box, under the content.
    const border = getComputedStyle(element).borderTopWidth
    Object.assign(canvas.style, {
      position: 'absolute',
      inset: `calc(-1 * ${border})`,
      width: `calc(100% + 2 * ${border})`,
      height: `calc(100% + 2 * ${border})`,
      zIndex: '-1',
      pointerEvents: 'none',
    })
    element.append(canvas)
    this.entries.set(element, {
      canvas,
      edges,
      ...readMaterial(element),
      key: '',
      drawn: 0,
      visible: true,
      stopGeometry: null,
    })
    this.observe(element)
    this.start()
    return true
  }

  setJoin(element: HTMLElement, join: LiquidJoin | undefined) {
    const entry = this.entries.get(element)
    if (!entry) return
    entry.join = join
    entry.key = ''
  }

  remove(element: HTMLElement) {
    const entry = this.entries.get(element)
    if (!entry) return
    entry.canvas.remove()
    delete element.dataset.liquid
    entry.stopGeometry?.()
    this.entries.delete(element)
    if (!this.entries.size) this.stop()
  }

  private start() {
    if (this.started) return
    this.started = true
    this.stopField = onLifeFrame((canvas) => {
      const changed = this.field !== canvas
      this.field = canvas
      this.fieldFresh = isVisible(canvas)
      if (changed) this.watchField(canvas)
      if (changed || this.fieldFresh) this.wake()
    })
    this.themeObserver = new MutationObserver(() => {
      if (this.themeFrame) return
      this.themeFrame = requestAnimationFrame(() => {
        this.themeFrame = 0
        this.theme++
        for (const [element, entry] of this.entries)
          Object.assign(entry, readMaterial(element), { key: '' })
        this.wake()
      })
    })
    this.themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: [
        'class',
        'style',
        'data-palette',
        'data-appearance-preset',
        'data-glass-study',
      ],
    })
    const scroll = () => {
      if (this.scrollFrame) return
      this.scrollFrame = requestAnimationFrame(() => {
        this.scrollFrame = 0
        this.wake()
      })
    }
    document.addEventListener('scroll', scroll, {
      capture: true,
      passive: true,
    })
    window.addEventListener('resize', scroll)
    const visibility = () => this.wake()
    document.addEventListener('visibilitychange', visibility)
    if (this.field) this.watchField(this.field)
    this.stopScroll = () => {
      document.removeEventListener('scroll', scroll, { capture: true })
      window.removeEventListener('resize', scroll)
      document.removeEventListener('visibilitychange', visibility)
    }
    this.wake()
  }

  private watchField(canvas: HTMLCanvasElement) {
    this.stopDocument?.()
    this.stopDocument = observeVisibility(canvas, () => {
      this.fieldFresh = isVisible(canvas)
      this.wake()
    })
  }

  private observe(element: HTMLElement) {
    const entry = this.entries.get(element)
    if (!entry) return
    const changed = () => {
      Object.assign(entry, readMaterial(element), { key: '' })
      this.wake()
    }
    const intersection = new IntersectionObserver(changed)
    intersection.observe(element)
    const mutation = new MutationObserver(changed)
    // A pane also moves when the layout around it changes without resizing
    // it: a message expanding above the edit composer pushes the form down
    // while it stays fully visible and nothing scrolls. The pane is nested
    // inside its own wrappers, so that message is a sibling of an ancestor,
    // not of the pane; every ancestor's own child list carries the change.
    // Watch each ancestor's direct children rather than one subtree, so the
    // cost stays proportional to the containers and not to the whole thread.
    // Character data is excluded: typing changes no layout here and must not
    // cost a redraw per keystroke.
    const targets = new Set<Element>()
    for (let node: Element | null = element; node; node = node.parentElement)
      targets.add(node)
    // One registration per target: observing a target again replaces its
    // options rather than adding to them, so each target's whole interest is
    // stated at once. The pane's own subtree is not watched for structure;
    // its content is the composer's text, which does not move the pane.
    for (const target of targets)
      mutation.observe(target, {
        attributes: true,
        attributeFilter: ['class', 'style', 'hidden'],
        ...(target === element ? {} : { childList: true }),
      })
    // Structure and attributes alone miss a container that grows in place:
    // a message streaming text, an image resolving its height, a
    // content-visibility row settling, or an ancestor's margin/height
    // transition. Each changes an ancestor's box without inserting a node or
    // touching an attribute, so watch the boxes too. The pane's own box is
    // included, which is what a resized pane needs.
    const resize = new ResizeObserver(changed)
    for (const target of targets) resize.observe(target)
    entry.stopGeometry = () => {
      resize.disconnect()
      intersection.disconnect()
      mutation.disconnect()
    }
  }

  private wake() {
    if (!this.started || this.frame || this.renderer?.lost) return
    if (document.visibilityState === 'hidden') return
    this.frame = requestAnimationFrame((now) => {
      this.frame = 0
      this.draw(now)
    })
  }

  private stop() {
    cancelAnimationFrame(this.frame)
    cancelAnimationFrame(this.themeFrame)
    cancelAnimationFrame(this.scrollFrame)
    this.frame = 0
    this.themeFrame = 0
    if (this.fieldTimer) clearTimeout(this.fieldTimer)
    this.fieldTimer = null
    this.scrollFrame = 0
    this.started = false
    this.stopField?.()
    this.stopField = null
    this.stopDocument?.()
    this.stopDocument = null
    this.stopScroll?.()
    this.stopScroll = null
    this.themeObserver?.disconnect()
    this.themeObserver = null
    // The field's canvas belongs to a Life mount that may already be gone.
    // Keeping it would watch a detached element until the next field publish.
    this.field = null
    this.fieldFresh = false
  }

  private onLost(lost: boolean) {
    if (lost) {
      cancelAnimationFrame(this.frame)
      this.frame = 0
      if (this.fieldTimer) clearTimeout(this.fieldTimer)
      this.fieldTimer = null
    }
    for (const [element, entry] of this.entries) {
      if (lost) delete element.dataset.liquid
      entry.key = ''
    }
    if (!lost) this.wake()
  }

  private draw(now: number) {
    const renderer = this.renderer
    if (!renderer || renderer.lost || document.visibilityState === 'hidden')
      return
    // isVisible already covers the visibility property, computed or inline.
    const field = this.field && isVisible(this.field) ? this.field : null
    const fieldRect = field?.getBoundingClientRect() ?? null
    const fresh = this.fieldFresh
    this.fieldFresh = false
    const dpr = window.devicePixelRatio || 1
    let sampled = false
    for (const [element, entry] of this.entries) {
      entry.visible = isVisible(element)
      if (!entry.visible) {
        entry.key = ''
        continue
      }
      const rect = element.getBoundingClientRect()
      if (rect.width < 1 || rect.height < 1) {
        entry.visible = false
        entry.key = ''
        continue
      }
      const { join } = entry
      const light = join
        ? document.querySelector(join.pane)?.getBoundingClientRect()
        : undefined
      // The fillets need the room the live pane's box makes for them; until
      // it draws, the box is the frost's, so it draws without them.
      const fillet: [number, number] =
        join && element.dataset.liquid === 'live'
          ? [join.top ? entry.fillet : 0, join.bottom ? entry.fillet : 0]
          : [0, 0]
      const key = [
        rect.left,
        rect.top,
        rect.width,
        rect.height,
        light?.left,
        light?.top,
        light?.width,
        light?.height,
        ...fillet,
        dpr,
        this.theme,
        fieldRect?.left,
        fieldRect?.top,
        fieldRect?.width,
        fieldRect?.height,
      ].join()
      const moved = key !== entry.key
      if (!moved && !(fresh && field && now - entry.drawn >= FIELD_INTERVAL))
        continue
      entry.key = key
      entry.drawn = now
      sampled ||= fresh && field !== null
      // A pane outside the sheet (the rail's tab) still sits on its field.
      const sheet =
        (
          element.closest('.sheet') ?? document.querySelector('.sheet')
        )?.getBoundingClientRect() ??
        fieldRect ??
        new DOMRect(0, 0, window.innerWidth, window.innerHeight)
      const scene: Scene = {
        field,
        fieldRect,
        sheetTop: sheet.top,
        sheetHeight: sheet.height,
        from: entry.from,
        shade: entry.shade,
      }
      const { edges } = entry
      renderer.render(
        {
          rect,
          radius: entry.radius,
          extend: [
            edges.left ? 0 : RUN_ON,
            edges.top ? 0 : RUN_ON,
            edges.right ? 0 : RUN_ON,
            edges.bottom ? 0 : RUN_ON,
          ],
          light,
          fillet,
          dpr,
          material: entry.material,
          target: entry.canvas,
        },
        scene,
      )
      // The frost stays until the pane has drawn, so it never shows empty.
      element.dataset.liquid = 'live'
    }
    if (fresh && field && !sampled) {
      const delay = Math.max(
        0,
        ...[...this.entries.values()]
          .filter((entry) => entry.visible)
          .map((entry) => FIELD_INTERVAL - (now - entry.drawn)),
      )
      if (delay && !this.fieldTimer) {
        this.fieldTimer = setTimeout(() => {
          this.fieldTimer = null
          this.fieldFresh = true
          this.wake()
        }, delay)
      }
    }
  }
}

let glass: Glass | undefined

/**
 * Makes `ref`'s element liquid glass: the Life field and the sheet behind
 * it, blurred and settled toward the pane's tone in the body, bent and
 * clearer at a curved rim, lit from the top left. The element is marked
 * data-liquid="live" once it draws; until then, and wherever it cannot
 * (no WebGL, reduced transparency), its own CSS frost shows. A pane that
 * runs on into another (`join`) is lit across that pane's box and can meet it
 * through concave fillets, so the two read as one surface.
 */
export function useLiquidGlass(
  ref: RefObject<HTMLElement | null>,
  enabled: boolean,
  edges: LiquidEdges = ALL_EDGES,
  join?: LiquidJoin,
) {
  const { top, right, bottom, left } = edges
  const reduced = useReducedTransparency()
  useEffect(() => {
    const element = ref.current
    if (!enabled || !element || reduced || !available()) return
    glass ??= new Glass()
    const active = glass
    if (!active.add(element, { top, right, bottom, left })) return
    return () => active.remove(element)
  }, [ref, enabled, top, right, bottom, left, reduced])
  const pane = join?.pane
  const joinTop = join?.top ?? false
  const joinBottom = join?.bottom ?? false
  useEffect(() => {
    const element = ref.current
    if (!enabled || !element) return
    glass?.setJoin(
      element,
      pane ? { pane, top: joinTop, bottom: joinBottom } : undefined,
    )
  }, [ref, enabled, pane, joinTop, joinBottom])
}
