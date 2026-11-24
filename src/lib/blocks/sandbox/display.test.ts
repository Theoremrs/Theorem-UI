import { afterEach, expect, test } from 'bun:test'
import { lookNow, markSelectedCell, observeHeight, snapshotHtml } from './display'
import { MAX_SNAPSHOT } from './protocol'

const root = document.documentElement
const original = globalThis.ResizeObserver

afterEach(() => {
  globalThis.ResizeObserver = original
  for (const key of ['scrollHeight', 'getBoundingClientRect'] as const)
    Reflect.deleteProperty(root, key)
  Reflect.deleteProperty(window, 'innerHeight')
})

/** Lays the frame out: how tall its content is, and how tall the frame is. */
function layout(content: number, frame: number) {
  Object.defineProperty(root, 'scrollHeight', {
    configurable: true,
    get: () => Math.max(content, frame),
  })
  Object.defineProperty(root, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({ height: content }) as DOMRect,
  })
  Object.defineProperty(window, 'innerHeight', {
    configurable: true,
    value: frame,
  })
}

test('a frame grows to its content and shrinks back when the content does', () => {
  let resized = () => {}
  globalThis.ResizeObserver = class {
    constructor(callback: () => void) {
      resized = callback
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
  const reports: number[] = []
  // A first layout at a narrow width wraps every line, so the content is tall.
  layout(7962, 150)
  observeHeight((height) => reports.push(height))
  // The frame is now that tall, and the content settles at its real height.
  layout(1700, 7962)
  resized()
  expect(reports).toEqual([7962, 1700])
})

test('only the cell a selection names is marked, and a selection outside every cell marks none', () => {
  document.body.innerHTML =
    '<main><div class="cell" data-cell-id="a"></div><div class="cell" data-cell-id="b"></div></main>'
  const [a, b] = document.querySelectorAll('.cell')
  const marked = () =>
    [...document.querySelectorAll('[data-selected]')].map((cell) =>
      cell.getAttribute('data-cell-id'),
    )
  markSelectedCell(a)
  expect(marked()).toEqual(['a'])
  markSelectedCell(b)
  expect(marked()).toEqual(['b'])
  markSelectedCell(null)
  expect(marked()).toEqual([])
  document.body.innerHTML = ''
})

/** Reports what observeHeight measures with this scrollHeight, frame height and root box. */
function measured(scroll: number, frame: number, box: number) {
  Object.defineProperty(root, 'scrollHeight', {
    configurable: true,
    value: scroll,
  })
  Object.defineProperty(root, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({ height: box }) as DOMRect,
  })
  Object.defineProperty(window, 'innerHeight', {
    configurable: true,
    value: frame,
  })
  const heights: number[] = []
  observeHeight((height) => heights.push(height))
  return heights
}

test('a page with a fractional height gets the whole pixel above it', () => {
  // scrollHeight rounds 186.375 down; the frame would scroll for the rest.
  expect(measured(186, 186, 186.375)).toEqual([187])
})

test('content overflowing a page box shorter than its frame still counts', () => {
  expect(measured(400, 186, 120)).toEqual([400])
})

/**
 * A page laid out by its viewport: its box `margin` taller than whatever frame
 * it is in, and its content `extra` taller.
 */
function viewportPage(frame: number, extra: number, margin = 0) {
  Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: frame })
  Object.defineProperty(root, 'scrollHeight', {
    configurable: true,
    get: () => window.innerHeight + extra,
  })
  Object.defineProperty(root, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({ height: window.innerHeight + margin }) as DOMRect,
  })
}

const resizeTo = (height: number) => {
  window.innerHeight = height
  window.dispatchEvent(new Event('resize'))
}

const frames = (count: number) =>
  new Promise<void>((resolve) => {
    const next = (left: number) => (left ? requestAnimationFrame(() => next(left - 1)) : resolve())
    next(count)
  })

test('a page laid out by its viewport, which outgrows every frame sized to it, says it fills its frame and stops growing', () => {
  // 62vh and 38vh under a 45px caption, in a body with 8px margins.
  viewportPage(150, 61, 16)
  const reports: Array<[number, boolean | undefined]> = []
  observeHeight((height, fills) => reports.push([height, fills]))
  resizeTo(211)
  resizeTo(272)
  resizeTo(600)
  resizeTo(661)
  expect(reports.filter(([, fills]) => fills)).toEqual([[272, true]])
  expect(reports.at(-1)).toEqual([272, true])
})

test('a page laid out by its viewport and already taller than the frame it loaded in says it fills its frame, and keeps the frame it is given', () => {
  // A 100vh grid whose side column needs 297px: in a frame sized to that,
  // the chart that takes the rest of the grid has no height at all.
  Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: 150 })
  Object.defineProperty(root, 'scrollHeight', {
    configurable: true,
    get: () => Math.max(297, window.innerHeight),
  })
  Object.defineProperty(root, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({ height: window.innerHeight }) as DOMRect,
  })
  const reports: Array<[number, boolean | undefined]> = []
  observeHeight((height, fills) => reports.push([height, fills]))
  expect(reports).toEqual([[297, true]])
  // The host gives it a height that follows the window; the grid fills it.
  resizeTo(504)
  resizeTo(720)
  expect(reports).toEqual([[297, true]])
})

test('a page laid out by its viewport that outgrows the frame it is given to fill keeps that frame', () => {
  // 62vh and 38vh under a 45px caption.
  viewportPage(150, 45)
  const reports: Array<[number, boolean | undefined]> = []
  observeHeight((height, fills) => reports.push([height, fills]))
  resizeTo(504)
  resizeTo(600)
  expect(reports).toEqual([[195, true]])
})

test('a page exactly as tall as the frame it loaded in says it fills its frame', async () => {
  viewportPage(150, 0)
  const reports: Array<[number, boolean | undefined]> = []
  observeHeight((height, fills) => reports.push([height, fills]))
  await frames(3)
  expect(reports).toEqual([[150, undefined], [150, true]])
  // The host gives it a height that follows the window; it says nothing more.
  window.innerHeight = 504
  window.dispatchEvent(new Event('resize'))
  await frames(3)
  expect(reports).toEqual([[150, undefined], [150, true]])
})

test('a page that only happened to be as tall as its first frame goes back to its content height, and follows it', async () => {
  let resized = () => {}
  globalThis.ResizeObserver = class {
    constructor(callback: () => void) {
      resized = callback
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
  layout(150, 150)
  const reports: Array<[number, boolean | undefined]> = []
  observeHeight((height, fills) => reports.push([height, fills]))
  await frames(3)
  expect(reports).toEqual([[150, undefined], [150, true]])
  // The host gives it the fill height, which its content does not follow.
  layout(150, 504)
  window.dispatchEvent(new Event('resize'))
  expect(reports.at(-1)).toEqual([150, undefined])
  // Back at 150px, more content loads.
  layout(400, 150)
  resized()
  expect(reports.at(-1)).toEqual([400, undefined])
})

test('a page sized by its content does not say it fills its frame', async () => {
  layout(320, 150)
  const reports: Array<[number, boolean | undefined]> = []
  observeHeight((height, fills) => reports.push([height, fills]))
  layout(320, 320)
  window.dispatchEvent(new Event('resize'))
  await frames(3)
  expect(reports).toEqual([[320, undefined]])
})

/** A canvas whose picture is `size` characters of data URL. */
function canvas(id: string, size: number): HTMLCanvasElement {
  const element = document.createElement('canvas')
  element.id = id
  element.width = 40
  element.height = 20
  element.toDataURL = () => `data:image/png;base64,${'A'.repeat(size)}`
  return element
}

test('a copy too large for a snapshot leaves out its largest canvas pictures, blank at their size, and keeps the page', () => {
  const words = document.createElement('p')
  words.textContent = 'ALU result 12'
  document.body.replaceChildren(words, canvas('scene', MAX_SNAPSHOT * 0.6), canvas('chart', MAX_SNAPSHOT * 0.7), canvas('small', 100))
  try {
    const html = snapshotHtml()
    expect(html.length).toBeLessThanOrEqual(MAX_SNAPSHOT)
    const copy = document.createElement('div')
    copy.innerHTML = html
    const images = [...copy.querySelectorAll('img')]
    expect(images.map((image) => [image.getAttribute('width'), image.getAttribute('height')])).toEqual([['40', '20'], ['40', '20'], ['40', '20']])
    expect(images.map((image) => (image.getAttribute('src') ?? '').length > 0)).toEqual([true, false, true])
    expect(copy.textContent).toContain('ALU result 12')
    expect(lookNow()?.html).toBe(html)
  } finally {
    document.body.replaceChildren()
  }
})

test('decoration hidden from assistive technology is left out of a copy before a larger canvas that is content', () => {
  const glass = canvas('glass', MAX_SNAPSHOT * 0.5)
  glass.setAttribute('aria-hidden', 'true')
  document.body.replaceChildren(canvas('scene', MAX_SNAPSHOT * 0.6), glass)
  try {
    const copy = document.createElement('div')
    copy.innerHTML = snapshotHtml()
    expect([...copy.querySelectorAll('img')].map((image) => (image.getAttribute('src') ?? '').length > 0)).toEqual([true, false])
  } finally {
    document.body.replaceChildren()
  }
})

test('a copy leaves out what the page does not display, and keeps its styles and its SVG whole', () => {
  document.body.innerHTML = `
    <style>.fallback { display: none }</style>
    <main>
      <canvas id="scene"></canvas>
      <p class="fallback">WebGL2 unavailable</p>
      <p hidden>Loading</p>
      <p style="display: none">Debug</p>
      <p>Feed 0.037</p>
      <svg><defs><linearGradient id="sky"><stop offset="0"></stop></linearGradient></defs><rect fill="url(#sky)"></rect></svg>
    </main>`
  try {
    const copy = document.createElement('div')
    copy.innerHTML = snapshotHtml()
    expect(copy.textContent).not.toContain('WebGL2 unavailable')
    expect(copy.textContent).not.toContain('Loading')
    expect(copy.textContent).not.toContain('Debug')
    expect(copy.textContent).toContain('Feed 0.037')
    expect(copy.querySelector('main > img')).not.toBeNull()
    expect(copy.querySelector('body style, div > style')?.textContent).toContain('.fallback')
    expect(copy.querySelector('svg linearGradient#sky stop')).not.toBeNull()
  } finally {
    document.body.replaceChildren()
  }
})
