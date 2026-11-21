// SOURCING: bun:test over the field's mount. textmode.js needs WebGL2, which
// happy-dom has not got, so its create is spied on and answered with a fake that
// keeps the two behaviours at stake: it still calls setup after destroy, and
// resizing a destroyed instance throws.
import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { textmode } from 'textmode.js'
import type { Textmodifier } from 'textmode.js'
import { useLifeControls, useLifeCounts } from '@/lib/life/store'
import { onLifeFrame } from './frames'
import { mountLife } from './mount-life'

let setup: () => void
let drawField: () => void
let drawOverlay: () => void
let disposed = false
let looping = true
let redraws = 0
let createSpy: ReturnType<typeof spyOn>

const fake = {
  layers: {
    add: () => ({
      draw(callback: () => void) {
        drawOverlay = callback
      },
    }),
  },
  clear() {},
  canvas: {
    width: 80,
    height: 80,
    getBoundingClientRect: () => ({
      left: 0,
      top: 0,
      width: 80,
      height: 80,
    }),
  },
  grid: {
    cols: 8,
    rows: 8,
    offsetX: 0,
    offsetY: 0,
    cellWidth: 10,
    cellHeight: 20,
  },
  setup: (callback: () => void) => {
    setup = callback
  },
  draw(callback: () => void) {
    drawField = callback
  },
  noLoop() {
    looping = false
  },
  loop() {
    looping = true
  },
  redraw(count = 1) {
    redraws += count
    for (let index = 0; index < count; index++) {
      drawField()
      drawOverlay()
    }
  },
  resizeCanvas() {
    this.redraw()
  },
  deltaTime: () => 16,
  secs: 1,
  noise: () => 0.5,
  push() {},
  translate() {},
  char() {},
  charColor() {},
  cellColor() {},
  point() {},
  pop() {},
  background() {},
  pixelDensity() {
    if (disposed)
      throw new TypeError("Cannot read properties of undefined (reading 'Xh')")
  },
  noiseDetail() {},
  get isDisposed() {
    return disposed
  },
  destroy() {
    disposed = true
  },
}

beforeEach(() => {
  disposed = false
  looping = true
  redraws = 0
  drawField = () => {}
  drawOverlay = () => {}
  document.body.replaceChildren()
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    value: 'visible',
  })
  useLifeCounts.setState({ generation: -1, population: -1, pace: -1 })
  useLifeControls.setState({ shown: true, playing: true, companion: true })
  createSpy = spyOn(textmode, 'create').mockImplementation(
    () => fake as unknown as Textmodifier,
  )
})
afterEach(() => {
  createSpy.mockRestore()
  document.body.replaceChildren()
})

function visibleHost() {
  const host = document.createElement('div')
  host.style.position = 'absolute'
  host.style.width = '80px'
  host.style.height = '80px'
  Object.defineProperty(host, 'clientWidth', { configurable: true, value: 80 })
  Object.defineProperty(host, 'clientHeight', { configurable: true, value: 80 })
  document.body.append(host)
  return host
}

test('a live field sets up and publishes its counts', () => {
  mountLife(document.createElement('div'), { reducedMotion: true })

  setup()

  expect(useLifeCounts.getState().population).toBeGreaterThanOrEqual(0)
})

test('a field destroyed while textmode.js loads does nothing when setup arrives', () => {
  const field = mountLife(document.createElement('div'), {
    reducedMotion: true,
  })
  field.destroy()

  expect(() => setup()).not.toThrow()

  expect(useLifeCounts.getState().population).toBe(-1)
})

test('glass receives the background frame when the companion is off', () => {
  const before = useLifeControls.getState().companion
  useLifeControls.setState({ companion: false })
  const frames: HTMLCanvasElement[] = []
  const stop = onLifeFrame((canvas) => frames.push(canvas))
  const field = mountLife(visibleHost(), {
    reducedMotion: true,
  })
  try {
    setup()
    const canvas = document.querySelector('canvas')!
    canvas.style.position = 'absolute'
    canvas.style.visibility = ''
    drawOverlay()
    expect(frames.length).toBeGreaterThan(0)
    expect(frames[0]).toBeInstanceOf(HTMLCanvasElement)
  } finally {
    stop()
    field.destroy()
    useLifeControls.setState({ companion: before })
  }
})

test('pause stops textmode drawing; play and an explicit step redraw', async () => {
  const host = visibleHost()
  const game = mountLife(host, { reducedMotion: true })
  setup()
  const canvas = host.querySelector('canvas')!
  canvas.style.position = 'absolute'
  drawField()
  expect(canvas.style.visibility).toBe('')
  useLifeControls.setState({ playing: false })
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(looping).toBe(false)
  redraws = 0
  drawOverlay()
  expect(redraws).toBe(0)

  game.step()
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(redraws).toBeGreaterThan(0)
  expect(looping).toBe(false)
  useLifeControls.setState({ playing: true })
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(looping).toBe(true)
  game.destroy()
})

test('a hidden field or document stops textmode and resumes without a stale frame', async () => {
  const host = visibleHost()
  const game = mountLife(host, { reducedMotion: true })
  setup()
  const canvas = host.querySelector('canvas')!
  canvas.style.position = 'absolute'
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(looping).toBe(true)

  host.style.visibility = 'hidden'
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(looping).toBe(false)
  redraws = 0
  host.style.visibility = ''
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => requestAnimationFrame(resolve))
  expect(looping).toBe(true)
  expect(redraws).toBeGreaterThan(0)

  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    value: 'hidden',
  })
  document.dispatchEvent(new Event('visibilitychange'))
  expect(looping).toBe(false)
  redraws = 0
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    value: 'visible',
  })
  document.dispatchEvent(new Event('visibilitychange'))
  expect(looping).toBe(true)
  expect(redraws).toBeGreaterThan(0)
  game.destroy()
})

test('a field mounted off or hidden does not draw until it becomes visible', async () => {
  const host = visibleHost()
  host.style.display = 'none'
  const game = mountLife(host, { reducedMotion: true })
  setup()
  expect(looping).toBe(false)
  redraws = 0
  host.style.display = ''
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => requestAnimationFrame(resolve))
  expect(looping).toBe(true)
  expect(redraws).toBeGreaterThan(0)
  game.destroy()
})

test('a paused textmode field repaints when the companion is switched off', async () => {
  const host = visibleHost()
  const game = mountLife(host, { reducedMotion: true })
  setup()
  const canvas = host.querySelector('canvas')!
  canvas.style.position = 'absolute'
  drawField()
  drawOverlay()
  useLifeControls.setState({ playing: false })
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(looping).toBe(false)

  redraws = 0
  useLifeControls.setState({ companion: false })
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(redraws).toBeGreaterThan(0)
  expect(looping).toBe(false)

  redraws = 0
  useLifeControls.setState({ companion: true })
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(redraws).toBeGreaterThan(0)
  expect(looping).toBe(false)
  game.destroy()
})

test('a paused textmode field repaints when the brush preview changes', async () => {
  const host = visibleHost()
  const game = mountLife(host, { reducedMotion: true })
  setup()
  const canvas = host.querySelector('canvas')!
  canvas.style.position = 'absolute'
  drawField()
  useLifeControls.setState({ playing: false })
  await new Promise((resolve) => setTimeout(resolve, 0))
  redraws = 0
  useLifeControls.setState({ brush: 'glider' })
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(redraws).toBeGreaterThan(0)
  expect(looping).toBe(false)
  game.destroy()
})

test('a paused field repaints once when text moves and skips an unchanged measurement', async () => {
  const host = visibleHost()
  const game = mountLife(host, { reducedMotion: true })
  setup()
  const canvas = host.querySelector('canvas')!
  canvas.style.position = 'absolute'
  drawField()
  useLifeControls.setState({ playing: false })
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(looping).toBe(false)

  const line = { left: 0, top: 0, right: 40, bottom: 16 }
  redraws = 0
  game.occlude([line])
  expect(redraws).toBe(1)
  expect(looping).toBe(false)

  redraws = 0
  game.occlude([{ ...line }])
  expect(redraws).toBe(0)
  expect(looping).toBe(false)

  redraws = 0
  game.occlude([{ ...line, top: 24, bottom: 40 }])
  expect(redraws).toBe(1)
  expect(looping).toBe(false)
  game.destroy()
})

test('a paused interaction draws once, not twice', async () => {
  const host = visibleHost()
  const game = mountLife(host, { reducedMotion: true })
  setup()
  const canvas = host.querySelector('canvas')!
  canvas.style.position = 'absolute'
  drawField()
  useLifeControls.setState({ playing: false })
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(looping).toBe(false)
  redraws = 0
  game.step()
  // The synchronous draw and any queued frame must not both render.
  await new Promise((resolve) => setTimeout(resolve, 30))
  expect(redraws).toBe(1)
  game.destroy()
})
