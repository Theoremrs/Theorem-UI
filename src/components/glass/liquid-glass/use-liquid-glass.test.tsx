import { afterEach, expect, mock, spyOn, test } from 'bun:test'
import { act, useRef } from 'react'
import { cleanup, render } from '../../../../test/blocks/render'
import { publishLifeFrame } from '@/components/life/frames'
import type { Pane, Scene } from './renderer'
import type { LiquidJoin } from './use-liquid-glass'

const renders: Array<{ pane: Pane; scene: Scene }> = []
let contextLost: ((lost: boolean) => void) | undefined
let failRenderer = false

class FakeGlassRenderer {
  lost = false

  constructor(onLost: (lost: boolean) => void) {
    if (failRenderer) throw new Error('no WebGL')
    contextLost = onLost
  }

  render(pane: Pane, scene: Scene) {
    renders.push({ pane, scene })
  }
}

void mock.module('@/components/glass/liquid-glass/renderer', () => ({
  GlassRenderer: FakeGlassRenderer,
}))
const { useLiquidGlass } =
  await import('@/components/glass/liquid-glass/use-liquid-glass')

const scheduled = new Map<number, FrameRequestCallback>()
let frameId = 0
let rafCalls = 0
let layoutReads = 0
let now = 0
let restore = () => {}

function rect(left: number, top: number, width: number, height: number) {
  return new DOMRect(left, top, width, height)
}

function measure(element: HTMLElement, box: DOMRect) {
  Object.defineProperty(element, 'getBoundingClientRect', {
    configurable: true,
    value: () => {
      layoutReads++
      return box
    },
  })
}

function instrumentGeometry() {
  const observers: Array<{
    target: Element
    callback: ResizeObserverCallback
  }> = []
  const Native = globalThis.ResizeObserver
  globalThis.ResizeObserver = class {
    private targets = new Set<Element>()
    constructor(private callback: ResizeObserverCallback) {}
    observe(target: Element) {
      this.targets.add(target)
      observers.push({ target, callback: this.callback })
    }
    unobserve(target: Element) {
      this.targets.delete(target)
    }
    disconnect() {
      this.targets.clear()
    }
  }
  const previous = restore
  restore = () => {
    globalThis.ResizeObserver = Native
    previous()
  }
  return (target: Element) => {
    for (const observer of observers)
      if (observer.target === target)
        observer.callback([], {} as ResizeObserver)
  }
}

function flush(elapsed = 16) {
  now += elapsed
  const callbacks = [...scheduled.values()]
  scheduled.clear()
  for (const callback of callbacks) callback(now)
  return callbacks.length
}

function frameAt(timestamp: number) {
  now = timestamp
  const callbacks = [...scheduled.values()]
  scheduled.clear()
  for (const callback of callbacks) callback(now)
  return callbacks.length
}

function idle(frames = 60) {
  let callbacks = 0
  for (let index = 0; index < frames; index++) callbacks += flush()
  return callbacks
}

function Pane({
  edges,
  join,
}: {
  edges?: { top: boolean; right: boolean; bottom: boolean; left: boolean }
  join?: LiquidJoin
}) {
  const ref = useRef<HTMLDivElement>(null)
  useLiquidGlass(ref, true, edges, join)
  return <div ref={ref} className="sheet" data-testid="pane" />
}

async function mount(join?: LiquidJoin) {
  const paneBox = rect(10, 20, 300, 120)
  const fieldBox = rect(0, 0, 800, 600)
  const field = document.createElement('canvas')
  document.body.append(field)
  measure(field, fieldBox)

  const view = await render(<Pane join={join} />)
  const pane = view.container.querySelector<HTMLElement>(
    '[data-testid="pane"]',
  )!
  measure(pane, paneBox)
  publishLifeFrame(field)
  flush(0)

  return { view, pane, paneBox, field, fieldBox }
}

function joinedPane() {
  const element = document.createElement('div')
  element.dataset.testid = 'joined-pane'
  const box = rect(300, 20, 400, 240)
  measure(element, box)
  document.body.append(element)
  const previous = restore
  restore = () => {
    element.remove()
    previous()
  }
  const join: LiquidJoin = {
    pane: '[data-testid="joined-pane"]',
    top: true,
    bottom: true,
  }
  return { join, box }
}

afterEach(async () => {
  await cleanup()
  restore()
  restore = () => {}
  renders.length = 0
  scheduled.clear()
  failRenderer = false
  layoutReads = 0
  rafCalls = 0
  now = 0
  document.documentElement.removeAttribute('data-palette')
  document.documentElement.removeAttribute('data-glass-study')
  document.documentElement.className = ''
  for (const canvas of document.querySelectorAll('canvas')) canvas.remove()
})

function instrument() {
  const raf = spyOn(globalThis, 'requestAnimationFrame').mockImplementation(
    (callback) => {
      rafCalls++
      const id = ++frameId
      scheduled.set(id, callback)
      return id
    },
  )
  const cancel = spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(
    (id) => {
      scheduled.delete(id)
    },
  )
  restore = () => {
    raf.mockRestore()
    cancel.mockRestore()
  }
}

function observeGeometry() {
  const NativeResize = globalThis.ResizeObserver
  const NativeIntersection = globalThis.IntersectionObserver
  const resize = new Set<Element>()
  const intersection = new Set<Element>()
  const mutations = new Set<Element>()
  const disconnects: Array<() => void> = []
  globalThis.ResizeObserver = class {
    private targets = new Set<Element>()
    observe(target: Element) {
      this.targets.add(target)
      resize.add(target)
    }
    unobserve(target: Element) {
      this.targets.delete(target)
      resize.delete(target)
    }
    disconnect() {
      for (const target of this.targets) resize.delete(target)
      this.targets.clear()
    }
  }
  disconnects.push(() => resize.clear())
  globalThis.IntersectionObserver = class {
    private targets = new Set<Element>()
    observe(target: Element) {
      this.targets.add(target)
      intersection.add(target)
    }
    unobserve(target: Element) {
      this.targets.delete(target)
      intersection.delete(target)
    }
    disconnect() {
      for (const target of this.targets) intersection.delete(target)
      this.targets.clear()
    }
  } as unknown as typeof IntersectionObserver
  disconnects.push(() => intersection.clear())
  const NativeMutation = globalThis.MutationObserver
  globalThis.MutationObserver = class {
    private targets = new Set<Element>()
    constructor(_callback: MutationCallback) {}
    observe(target: Element) {
      this.targets.add(target)
      mutations.add(target)
    }
    disconnect() {
      for (const target of this.targets) mutations.delete(target)
      this.targets.clear()
    }
    takeRecords() {
      return []
    }
  }
  disconnects.push(() => mutations.clear())
  const previous = restore
  restore = () => {
    for (const disconnect of disconnects) disconnect()
    globalThis.ResizeObserver = NativeResize
    globalThis.IntersectionObserver = NativeIntersection
    globalThis.MutationObserver = NativeMutation
    previous()
  }
  return { resize, intersection, mutations }
}

test('without WebGL the pane keeps its CSS frost and does not schedule work', async () => {
  instrument()
  failRenderer = true
  const view = await render(<Pane />)
  const pane = view.container.querySelector<HTMLElement>(
    '[data-testid="pane"]',
  )!
  expect(pane.dataset.liquid).toBeUndefined()
  expect(pane.querySelector('[data-liquid-canvas]') !== null).toBe(false)
  expect(idle()).toBe(0)
  expect(rafCalls).toBe(0)
})

test('an idle glass scene stops requesting frames and reading layout', async () => {
  instrument()
  const { pane } = await mount()
  expect(pane.dataset.liquid).toBe('live')
  expect(renders.length).toBeGreaterThan(0)

  await new Promise((resolve) => setTimeout(resolve, 60))
  renders.length = 0
  layoutReads = 0
  rafCalls = 0
  const callbacks = idle()

  expect({
    callbacks,
    rafCalls,
    layoutReads,
    renders: renders.length,
    pending: scheduled.size,
  }).toEqual({
    callbacks: 0,
    rafCalls: 0,
    layoutReads: 0,
    renders: 0,
    pending: 0,
  })
})

test('a resized pane redraws once and then returns to idle', async () => {
  instrument()
  const resize = instrumentGeometry()
  const { pane, paneBox } = await mount()
  renders.length = 0
  layoutReads = 0

  measure(pane, rect(paneBox.left, paneBox.top, 360, paneBox.height))
  resize(pane)
  flush()

  expect(renders.length).toBeGreaterThan(0)
  expect(renders.at(-1)?.pane.rect.width).toBe(360)
  expect(pane.dataset.liquid).toBe('live')

  renders.length = 0
  layoutReads = 0
  expect(idle()).toBe(0)
  expect(layoutReads).toBe(0)
  expect(renders).toHaveLength(0)
})

test('a moved pane redraws on scroll and then stops reading layout', async () => {
  instrument()
  const { paneBox } = await mount()
  renders.length = 0
  layoutReads = 0
  measure(
    document.querySelector<HTMLElement>('[data-testid="pane"]')!,
    rect(40, paneBox.top, paneBox.width, paneBox.height),
  )
  document.dispatchEvent(new Event('scroll', { bubbles: true }))
  flush()
  flush()
  expect(renders.at(-1)?.pane.rect.left).toBe(40)
  renders.length = 0
  layoutReads = 0
  expect(idle()).toBe(0)
  expect(layoutReads).toBe(0)
})

test('a hidden pane or document does no drawing and wakes when visible', async () => {
  instrument()
  const { pane } = await mount()
  renders.length = 0
  layoutReads = 0
  pane.style.visibility = 'hidden'
  await new Promise((resolve) => setTimeout(resolve, 0))
  flush()
  renders.length = 0
  layoutReads = 0
  expect(renders).toHaveLength(0)
  expect(idle()).toBe(0)
  expect(layoutReads).toBe(0)

  pane.style.visibility = ''
  await new Promise((resolve) => setTimeout(resolve, 0))
  flush()
  expect(renders.length).toBeGreaterThan(0)
  expect(pane.dataset.liquid).toBe('live')

  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    value: 'hidden',
  })
  document.dispatchEvent(new Event('visibilitychange'))
  renders.length = 0
  layoutReads = 0
  expect(idle()).toBe(0)
  expect(layoutReads).toBe(0)

  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    value: 'visible',
  })
  document.dispatchEvent(new Event('visibilitychange'))
  flush()
  await new Promise((resolve) => setTimeout(resolve, 40))
  flush()
  expect(renders.length).toBeGreaterThan(0)
})

test('a theme change redraws the pane without restarting a permanent loop', async () => {
  instrument()
  await mount()
  renders.length = 0
  layoutReads = 0

  document.documentElement.dataset.palette = 'redwood'
  await new Promise((resolve) => setTimeout(resolve, 0))
  flush()
  flush()

  expect(renders.length).toBeGreaterThan(0)
  renders.length = 0
  layoutReads = 0
  expect(idle()).toBe(0)
  expect(layoutReads).toBe(0)
  expect(renders).toHaveLength(0)
})

test('a pane-local material change redraws without a global theme change', async () => {
  instrument()
  const { pane } = await mount()
  renders.length = 0
  pane.style.setProperty('--lg-blur', '20')
  await new Promise((resolve) => setTimeout(resolve, 0))
  flush()
  expect(renders.length).toBeGreaterThan(0)
  expect(renders.at(-1)?.pane.material.blur).toBe(20)
  renders.length = 0
  layoutReads = 0
  expect(idle()).toBe(0)
  expect(layoutReads).toBe(0)
})

test('a fresh Life frame redraws, and a too-soon frame is not lost', async () => {
  instrument()
  const { field } = await mount()
  await new Promise((resolve) => setTimeout(resolve, 40))
  flush(0)
  frameAt(performance.now() + 1000)
  renders.length = 0
  layoutReads = 0

  publishLifeFrame(field)
  frameAt(now)
  expect(renders).toHaveLength(1)
  renders.length = 0
  publishLifeFrame(field)
  frameAt(now)
  expect(renders).toHaveLength(0)
  await new Promise((resolve) => setTimeout(resolve, 40))
  frameAt(now + 40)

  expect(renders).toHaveLength(1)
  expect(renders.at(-1)?.scene.field).toBe(field)
  renders.length = 0
  layoutReads = 0
  expect(idle()).toBe(0)
  expect(layoutReads).toBe(0)
})

test('one Life frame is sampled once and does not restart a standing loop', async () => {
  instrument()
  const { field } = await mount()
  await new Promise((resolve) => setTimeout(resolve, 60))
  flush()

  publishLifeFrame(field)
  let callbacks = 0
  for (let index = 0; index < 60; index++) callbacks += flush()
  expect(callbacks).toBe(1)
  expect(renders.at(-1)?.scene.field).toBe(field)
  await new Promise((resolve) => setTimeout(resolve, 60))
  flush()

  renders.length = 0
  layoutReads = 0
  rafCalls = 0
  callbacks = 0
  for (let round = 0; round < 5; round++) {
    await new Promise((resolve) => setTimeout(resolve, 50))
    callbacks += flush()
  }
  expect({
    callbacks,
    renders: renders.length,
    layoutReads,
    rafCalls,
  }).toEqual({ callbacks: 0, renders: 0, layoutReads: 0, rafCalls: 0 })
})

test('a fresh Life frame wakes a pane that has not drawn yet', async () => {
  instrument()
  const { pane, field } = await mount()
  pane.style.visibility = 'hidden'
  await new Promise((resolve) => setTimeout(resolve, 0))
  flush()
  delete pane.dataset.liquid
  renders.length = 0

  publishLifeFrame(field)
  flush()
  expect(renders).toHaveLength(0)
  pane.style.visibility = ''
  await new Promise((resolve) => setTimeout(resolve, 0))
  flush()
  expect(renders.length).toBeGreaterThan(0)
  expect(pane.getAttribute('data-liquid')).toBe('live')
})

test('a hidden Life frame does not keep glass scheduling frames', async () => {
  instrument()
  const { field } = await mount()
  field.style.visibility = 'hidden'
  await new Promise((resolve) => setTimeout(resolve, 0))
  flush()
  renders.length = 0
  layoutReads = 0
  rafCalls = 0
  publishLifeFrame(field)
  expect(idle()).toBe(0)
  expect({ renders: renders.length, layoutReads, rafCalls }).toEqual({
    renders: 0,
    layoutReads: 0,
    rafCalls: 0,
  })

  field.style.visibility = ''
  await new Promise((resolve) => setTimeout(resolve, 0))
  flush()
  expect(renders.length).toBeGreaterThan(0)
  expect(renders.at(-1)?.scene.field).toBe(field)
})

test('context loss keeps CSS frost and restoration redraws immediately', async () => {
  instrument()
  const { pane } = await mount()
  expect(pane.dataset.liquid).toBe('live')

  contextLost?.(true)
  expect(pane.dataset.liquid).toBeUndefined()
  renders.length = 0
  rafCalls = 0
  expect(idle()).toBe(0)
  expect(rafCalls).toBe(0)

  contextLost?.(false)
  flush()
  expect(renders.length).toBeGreaterThan(0)
  expect(pane.dataset.liquid).toBe('live')
  expect(idle()).toBe(0)
})

test('removing the last pane disconnects its observers and idle work', async () => {
  instrument()
  const observed = observeGeometry()
  const { view, pane } = await mount()
  expect(observed.resize.has(pane)).toBe(true)
  expect(observed.intersection.has(pane)).toBe(true)
  expect(observed.mutations.has(pane)).toBe(true)
  await view.unmount()
  expect(observed.resize.size).toBe(0)
  expect(observed.intersection.size).toBe(0)
  expect(observed.mutations.size).toBe(0)
  expect(pane.querySelector('[data-liquid-canvas]') !== null).toBe(false)
  expect(pane.dataset.liquid).toBeUndefined()
  renders.length = 0
  layoutReads = 0
  rafCalls = 0
  expect(idle()).toBe(0)
  expect({ renders: renders.length, layoutReads, rafCalls }).toEqual({
    renders: 0,
    layoutReads: 0,
    rafCalls: 0,
  })
})

test('reduced transparency removes the canvas and restores its join when turned off', async () => {
  instrument()
  // A controllable media query: the pane mounts with transparency allowed.
  const listeners = new Set<(event: { matches: boolean }) => void>()
  let reduced = false
  const nativeMatchMedia = window.matchMedia
  window.matchMedia = (query: string) => {
    if (query.includes('prefers-reduced-transparency')) {
      return {
        get matches() {
          return reduced
        },
        media: query,
        addEventListener: (
          _: string,
          cb: (event: { matches: boolean }) => void,
        ) => listeners.add(cb),
        removeEventListener: (
          _: string,
          cb: (event: { matches: boolean }) => void,
        ) => listeners.delete(cb),
        addListener: (cb: (event: { matches: boolean }) => void) =>
          listeners.add(cb),
        removeListener: (cb: (event: { matches: boolean }) => void) =>
          listeners.delete(cb),
        dispatchEvent: () => true,
        onchange: null,
      } as unknown as MediaQueryList
    }
    return nativeMatchMedia(query)
  }
  const previousRestore = restore
  restore = () => {
    window.matchMedia = nativeMatchMedia
    listeners.clear()
    previousRestore()
  }

  const { join, box } = joinedPane()
  const { pane } = await mount(join)
  const originalCanvas = pane.querySelector('[data-liquid-canvas]')
  expect(pane.dataset.liquid).toBe('live')
  expect(originalCanvas).not.toBeNull()
  expect(renders.at(-1)?.pane.light).toBe(box)

  // The person asks for less transparency while the chart is already mounted.
  reduced = true
  await act(async () => {
    for (const cb of listeners) cb({ matches: true })
  })

  expect(pane.dataset.liquid).toBeUndefined()
  expect(pane.querySelector('[data-liquid-canvas]')).toBeNull()

  reduced = false
  renders.length = 0
  await act(async () => {
    for (const cb of listeners) cb({ matches: false })
  })
  flush()

  expect(pane.dataset.liquid).toBe('live')
  expect(pane.querySelectorAll('[data-liquid-canvas]')).toHaveLength(1)
  expect(pane.querySelector('[data-liquid-canvas]')).not.toBe(originalCanvas)
  expect(renders.at(-1)?.pane.light).toBe(box)
})

test('edge changes recreate the canvas with its shared lighting join', async () => {
  instrument()
  const { join, box } = joinedPane()
  const { view, pane } = await mount(join)
  const originalCanvas = pane.querySelector('[data-liquid-canvas]')
  expect(renders.at(-1)?.pane.light).toBe(box)

  renders.length = 0
  await view.rerender(
    <Pane
      join={join}
      edges={{ top: true, right: false, bottom: true, left: true }}
    />,
  )
  flush()

  expect(pane.dataset.liquid).toBe('live')
  expect(pane.querySelectorAll('[data-liquid-canvas]')).toHaveLength(1)
  expect(pane.querySelector('[data-liquid-canvas]')).not.toBe(originalCanvas)
  expect(renders.at(-1)?.pane.extend).toEqual([0, 0, 4096, 0])
  expect(renders.at(-1)?.pane.light).toBe(box)
})

test('a pane moved by a sibling growing redraws without a scroll or resize', async () => {
  instrument()
  const { pane, paneBox } = await mount()
  renders.length = 0
  layoutReads = 0

  // Expanding a message above the composer moves the form down. The pane
  // keeps its size, stays fully visible, and nothing scrolls: only its
  // position changes.
  const sibling = document.createElement('div')
  pane.parentElement!.insertBefore(sibling, pane)
  measure(
    pane,
    rect(paneBox.left, paneBox.top + 90, paneBox.width, paneBox.height),
  )
  await new Promise((resolve) => setTimeout(resolve, 30))
  flush()

  expect(renders.at(-1)?.pane.rect.top).toBe(paneBox.top + 90)
})

test('typing in a sibling does not redraw the glass every keystroke', async () => {
  instrument()
  const { pane } = await mount()
  const typed = document.createElement('div')
  typed.textContent = 'a draft'
  pane.parentElement!.insertBefore(typed, pane)
  await new Promise((resolve) => setTimeout(resolve, 30))
  flush()
  await new Promise((resolve) => setTimeout(resolve, 30))
  flush()

  renders.length = 0
  layoutReads = 0
  rafCalls = 0
  for (let index = 0; index < 20; index++) {
    typed.firstChild!.textContent = `a draft ${index}`
    await new Promise((resolve) => setTimeout(resolve, 1))
    flush()
  }
  expect({ renders: renders.length, layoutReads, rafCalls }).toEqual({
    renders: 0,
    layoutReads: 0,
    rafCalls: 0,
  })
})

test('a message expanding in an ancestor container moves the pane', async () => {
  instrument()
  // The product's shape: the glass pane is nested inside its own wrappers,
  // and the message that grows is a sibling of an ANCESTOR, not of the pane.
  // aui_edit-composer-wrapper > div.relative > form(pane)
  function Nested() {
    const ref = useRef<HTMLDivElement>(null)
    useLiquidGlass(ref, true)
    return (
      <div data-testid="list">
        <div data-testid="wrapper">
          <div>
            <div ref={ref} className="sheet" data-testid="nested-pane" />
          </div>
        </div>
      </div>
    )
  }
  const field = document.createElement('canvas')
  document.body.append(field)
  measure(field, rect(0, 0, 800, 600))
  const view = await render(<Nested />)
  const pane = view.container.querySelector<HTMLElement>(
    '[data-testid="nested-pane"]',
  )!
  const box = rect(10, 20, 300, 120)
  measure(pane, box)
  publishLifeFrame(field)
  flush(0)
  await new Promise((resolve) => setTimeout(resolve, 30))
  flush()
  renders.length = 0
  layoutReads = 0

  // A message grows above the wrapper: the pane keeps its size, stays fully
  // visible, nothing scrolls, and the pane's own parent is untouched.
  const list = view.container.querySelector<HTMLElement>(
    '[data-testid="list"]',
  )!
  const wrapper = view.container.querySelector<HTMLElement>(
    '[data-testid="wrapper"]',
  )!
  const message = document.createElement('div')
  list.insertBefore(message, wrapper)
  measure(pane, rect(box.left, box.top + 120, box.width, box.height))
  await new Promise((resolve) => setTimeout(resolve, 30))
  flush()

  expect(renders.at(-1)?.pane.rect.top).toBe(box.top + 120)
})

test('typing inside the pane does not redraw the glass', async () => {
  instrument()
  const { pane } = await mount()
  const text = document.createElement('div')
  text.textContent = 'a draft'
  pane.append(text)
  await new Promise((resolve) => setTimeout(resolve, 30))
  flush()
  await new Promise((resolve) => setTimeout(resolve, 30))
  flush()

  renders.length = 0
  layoutReads = 0
  rafCalls = 0
  for (let index = 0; index < 20; index++) {
    // Typing replaces the text node, which is a childList change inside the
    // pane. It moves nothing, so it must cost no redraw.
    text.firstChild!.textContent = `a draft ${index}`
    await new Promise((resolve) => setTimeout(resolve, 1))
    flush()
  }
  expect({ renders: renders.length, layoutReads, rafCalls }).toEqual({
    renders: 0,
    layoutReads: 0,
    rafCalls: 0,
  })
})

test('an existing message growing in place moves the pane', async () => {
  instrument()
  const resize = instrumentGeometry()
  const { pane, paneBox } = await mount()
  // An EXISTING sibling, already in the DOM, grows: streaming text, an image
  // resolving its height, or a content-visibility row settling. No node is
  // inserted, no class or style changes, the pane keeps its size and stays
  // fully visible, and nothing scrolls.
  const message = document.createElement('div')
  message.textContent = 'short'
  pane.parentElement!.insertBefore(message, pane)
  await new Promise((resolve) => setTimeout(resolve, 30))
  flush()
  renders.length = 0
  layoutReads = 0

  message.firstChild!.textContent = 'a much longer streamed answer'.repeat(20)
  measure(
    pane,
    rect(paneBox.left, paneBox.top + 120, paneBox.width, paneBox.height),
  )
  // happy-dom does no layout, so report the container's new box the way a
  // browser's ResizeObserver would. The point under test is that the glass
  // renderer observes the container at all: with no ancestor observation
  // this notification has no listener and nothing redraws.
  resize(pane.parentElement!)
  await new Promise((resolve) => setTimeout(resolve, 30))
  flush()

  expect(renders.at(-1)?.pane.rect.top).toBe(paneBox.top + 120)
})
