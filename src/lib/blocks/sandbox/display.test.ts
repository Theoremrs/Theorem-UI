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

test('content overflowing the page box still counts', () => {
  expect(measured(400, 186, 186)).toEqual([400])
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
