import { afterEach, expect, mock, spyOn, test } from 'bun:test'
import { PATTERNS } from '@/lib/life/patterns'
import { useLifeControls, useLifeCounts } from '@/lib/life/store'
import { mountLife2d } from './mount-life-2d'

type DrawnGlyph = {
  glyph: string
  x: number
  y: number
  alpha: number
  color: string
}

const cleanups: Array<() => void> = []

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
  useLifeControls.setState({
    shown: true,
    playing: true,
    brush: 'cell',
    companion: true,
  })
  useLifeCounts.setState({ generation: 0, population: 0, pace: 0 })
})

/** Run the production renderer against a fake 2D canvas and a manual RAF clock. */
function setup(reducedMotion = false) {
  useLifeControls.setState({
    shown: true,
    playing: false,
    brush: 'cell',
    companion: false,
  })
  useLifeCounts.setState({ generation: 0, population: 0, pace: 0 })

  const drawn: DrawnGlyph[] = []
  const ctx = {
    clearRect: mock(
      (_x: number, _y: number, _width: number, _height: number) => {},
    ),
    setTransform: mock(
      (
        _a: number,
        _b: number,
        _c: number,
        _d: number,
        _e: number,
        _f: number,
      ) => {},
    ),
    fillText: mock((glyph: string, x: number, y: number) => {
      drawn.push({ glyph, x, y, alpha: ctx.globalAlpha, color: ctx.fillStyle })
    }),
    globalAlpha: 1,
    fillStyle: '',
    textAlign: 'left',
    textBaseline: 'alphabetic',
    font: '',
  }
  const context = spyOn(
    HTMLCanvasElement.prototype,
    'getContext',
  ).mockReturnValue(ctx as unknown as CanvasRenderingContext2D)
  const scheduled = new Map<number, FrameRequestCallback>()
  let frameId = 0
  const raf = spyOn(globalThis, 'requestAnimationFrame').mockImplementation(
    (callback) => {
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
  const dpr = Object.getOwnPropertyDescriptor(window, 'devicePixelRatio')
  const visibility = Object.getOwnPropertyDescriptor(
    document,
    'visibilityState',
  )
  Object.defineProperty(window, 'devicePixelRatio', {
    configurable: true,
    value: 3,
  })

  const host = document.createElement('div')
  host.style.position = 'absolute'
  host.style.width = '240px'
  host.style.height = '192px'
  Object.defineProperty(host, 'clientWidth', { configurable: true, value: 240 })
  Object.defineProperty(host, 'clientHeight', {
    configurable: true,
    value: 192,
  })
  host.style.setProperty('--redwood', '#b37b40')
  document.body.append(host)
  const game = mountLife2d(host, { reducedMotion })
  const canvas = host.querySelector('canvas')!
  canvas.style.position = 'absolute'
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    value: 'visible',
  })
  Object.defineProperty(canvas, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({ left: 0, top: 0 }),
  })

  let now = 0
  const frame = (elapsed = 100) => {
    now += elapsed
    const callbacks = [...scheduled.values()]
    scheduled.clear()
    for (const callback of callbacks) callback(now)
  }
  cleanups.push(() => {
    game.destroy()
    host.remove()
    if (visibility)
      Object.defineProperty(document, 'visibilityState', visibility)
    else Reflect.deleteProperty(document, 'visibilityState')
    if (dpr) Object.defineProperty(window, 'devicePixelRatio', dpr)
    else Reflect.deleteProperty(window, 'devicePixelRatio')
    cancel.mockRestore()
    raf.mockRestore()
    context.mockRestore()
  })

  return { host, canvas, game, ctx, drawn, scheduled, frame }
}

test('reduced motion starts paused but explicitly choosing Play advances the field', async () => {
  const { game, frame, scheduled, ctx } = setup(true)
  game.clear()
  await new Promise((resolve) => setTimeout(resolve, 0))
  ctx.clearRect.mockClear()
  let callbacks = 0
  for (let i = 0; i < 8; i++) {
    callbacks += scheduled.size
    frame()
  }
  expect(useLifeCounts.getState().generation).toBe(0)
  expect({ callbacks, draws: ctx.clearRect.mock.calls.length }).toEqual({
    callbacks: 0,
    draws: 0,
  })

  useLifeControls.setState({ playing: true })
  await new Promise((resolve) => setTimeout(resolve, 0))
  for (let i = 0; i < 14; i++) frame()
  expect(useLifeCounts.getState().generation).toBeGreaterThan(0)

  const generation = useLifeCounts.getState().generation
  useLifeControls.setState({ playing: false })
  await new Promise((resolve) => setTimeout(resolve, 0))
  callbacks = 0
  const drawn = ctx.clearRect.mock.calls.length
  for (let i = 0; i < 10; i++) {
    callbacks += scheduled.size
    frame()
  }
  expect(useLifeCounts.getState().generation).toBe(generation)
  expect({ callbacks, draws: ctx.clearRect.mock.calls.length - drawn }).toEqual(
    {
      callbacks: 0,
      draws: 0,
    },
  )
  game.step()
  expect(useLifeCounts.getState().generation).toBe(generation + 1)
})

test('a hidden field or document stops drawing and resumes on the next frame', async () => {
  const { host, game, frame, scheduled, ctx } = setup()
  useLifeControls.setState({ playing: true })
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(scheduled.size).toBe(1)
  frame()
  expect(ctx.clearRect).toHaveBeenCalled()

  host.style.visibility = 'hidden'
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(scheduled.size).toBe(0)
  let draws = ctx.clearRect.mock.calls.length
  frame()
  expect(ctx.clearRect.mock.calls.length).toBe(draws)

  host.style.visibility = ''
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(scheduled.size).toBe(1)
  frame()
  expect(ctx.clearRect.mock.calls.length).toBeGreaterThan(draws)

  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    value: 'hidden',
  })
  document.dispatchEvent(new Event('visibilitychange'))
  expect(scheduled.size).toBe(0)
  draws = ctx.clearRect.mock.calls.length
  frame()
  expect(ctx.clearRect.mock.calls.length).toBe(draws)

  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    value: 'visible',
  })
  document.dispatchEvent(new Event('visibilitychange'))
  expect(scheduled.size).toBe(1)
  frame()
  expect(ctx.clearRect.mock.calls.length).toBeGreaterThan(draws)

  game.destroy()
  expect(scheduled.size).toBe(0)
})

test('coalesced pointer motion paints every cell in a segment and stops after release', () => {
  const { game, frame, drawn } = setup()
  game.clear()
  game.press(15, 24) // cell (1, 1)
  game.drag(95, 24) // cell (9, 1), with no intermediate pointer events
  frame()
  expect(useLifeCounts.getState().population).toBe(9)
  for (let x = 1; x <= 9; x++)
    expect(
      drawn.some(
        (entry) =>
          entry.glyph === '@' && entry.x === (x + 0.5) * 10 && entry.y === 24,
      ),
    ).toBe(true)

  game.release()
  game.drag(145, 24)
  frame()
  expect(useLifeCounts.getState().population).toBe(9)

  // Erasing is a stroke too: remove all intermediate cells, not just endpoints.
  game.press(15, 24)
  game.drag(95, 24)
  frame()
  expect(useLifeCounts.getState().population).toBe(0)
  game.release()

  game.clear()
  game.press(15, 24)
  game.drag(95, 152) // a diagonal, cell (1, 1) to (9, 9)
  frame()
  expect(useLifeCounts.getState().population).toBe(9)
})

test('selected pattern is previewed at the pointer, then removed on leave', () => {
  const { game, drawn, frame } = setup()
  game.clear()
  useLifeControls.setState({ brush: 'glider' })
  drawn.length = 0
  game.hover(55, 56) // centre cell (5, 3)
  const preview = drawn.filter((entry) => entry.glyph === 'o')
  expect(preview).toHaveLength(PATTERNS.glider.cells.length)
  expect(preview.every((entry) => entry.alpha === 0.5)).toBe(true)
  expect(preview.map(({ x, y }) => [x, y])).toEqual([
    [55, 40],
    [65, 56],
    [45, 72],
    [55, 72],
    [65, 72],
  ])

  drawn.length = 0
  game.leave()
  expect(drawn.filter((entry) => entry.glyph === 'o')).toHaveLength(0)
  game.hover(55, 56)
  game.press(55, 56)
  frame()
  expect(useLifeCounts.getState().population).toBe(PATTERNS.glider.cells.length)
})

test('brush preview wraps horizontally like stamp and clips beyond vertical edges', () => {
  const { game, drawn, frame } = setup()
  game.clear()
  useLifeControls.setState({ brush: 'glider' })

  // A glider centered on the rightmost column wraps two preview cells left.
  drawn.length = 0
  game.hover(235, 56) // centre (23, 3), field is 24 columns wide
  const preview = drawn.filter((entry) => entry.glyph === 'o')
  expect(preview).toHaveLength(PATTERNS.glider.cells.length)
  expect(preview.map(({ x, y }) => [x, y])).toEqual([
    [235, 40],
    [5, 56],
    [225, 72],
    [235, 72],
    [5, 72],
  ])
  game.press(235, 56)
  frame()
  expect(useLifeCounts.getState().population).toBe(preview.length)
  expect(
    drawn.filter((entry) => entry.glyph === '@').some((entry) => entry.x === 5),
  ).toBe(true)

  // Top edge clips rows instead of wrapping them to the bottom.
  game.clear()
  drawn.length = 0
  game.hover(5, 8) // centre (0, 0), first pattern row is above canvas
  const topPreview = drawn.filter((entry) => entry.glyph === 'o')
  expect(topPreview).toHaveLength(4)
  expect(topPreview.every((entry) => entry.y >= 0)).toBe(true)
  game.press(5, 8)
  frame()
  expect(useLifeCounts.getState().population).toBe(4)
})

test('real Canvas 2D path handles drawing, resize, palette repaint, and teardown', async () => {
  const { host, canvas, game, ctx, drawn, scheduled, frame } = setup()
  expect(canvas.style.pointerEvents).toBe('none')
  expect(canvas.width).toBe(480) // DPR 3 is deliberately capped at 2
  expect(canvas.height).toBe(384)
  expect(ctx.setTransform).toHaveBeenCalledWith(2, 0, 0, 2, 0, 0)

  game.clear()
  game.press(25, 40)
  frame()
  expect(ctx.clearRect).toHaveBeenCalled()
  expect(ctx.fillText).toHaveBeenCalled()
  game.resize(300, 224)
  expect(canvas.width).toBe(600)
  expect(canvas.height).toBe(448)
  expect(canvas.style.width).toBe('300px')
  expect(canvas.style.height).toBe('224px')

  host.style.setProperty('--redwood', '#ff00dd')
  game.repaint()
  useLifeControls.setState({ brush: 'glider' })
  drawn.length = 0
  game.hover(55, 56)
  const repaintedPreview = drawn.filter((entry) => entry.glyph === 'o')
  expect(repaintedPreview).toHaveLength(PATTERNS.glider.cells.length)
  expect(repaintedPreview.every((entry) => entry.color === '#ff00dd')).toBe(
    true,
  )

  useLifeControls.setState({ playing: true })
  await new Promise((resolve) => setTimeout(resolve, 0))
  const staleFrame = [...scheduled.values()][0]!
  game.destroy()
  expect(host.querySelector('canvas')).toBeNull()
  expect(scheduled.size).toBe(0)
  staleFrame(10000) // a queued callback that runs after teardown is inert
  expect(scheduled.size).toBe(0)
})
