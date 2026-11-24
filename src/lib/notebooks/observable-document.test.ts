import { afterEach, expect, test } from 'bun:test'
import type * as D3Array from 'd3-array'
import * as esbuild from 'esbuild-wasm'
import { bundleNotebookRuntime } from '@/lib/blocks/export'
import { CELL_STATUS_EVENT } from '@/lib/blocks/sandbox/protocol'
import type { CellStatus } from '@/lib/blocks/sandbox/protocol'
import { THEME_EVENT, applyTheme } from '@/lib/blocks/sandbox/theme'
import { importMap } from '@/lib/blocks/vendor/manifest'
import { waitFor } from '../../../test/blocks/render'
import type { ObservableNotebook } from './forms'
import {
  notebookCellsScript,
  observableDocument,
  observablePage,
  observableSource,
} from './observable-document'
import type { ObservableRun, SavedView } from './observable-document'

declare global {
  interface Window {
    __theoremImport?: (specifier: string, remote?: string) => Promise<unknown>
    __theoremNotebook?: unknown
  }
}

const LIGHT = {
  mode: 'light' as const,
  tokens: { '--ink': 'rgb(1, 2, 3)', '--redwood': 'rgb(10, 20, 30)' },
}

let runtime: Promise<string> | undefined
/** The frame's runtime, bundled once with Bun's esbuild and run in this window. */
async function loadRuntime() {
  runtime ??= bundleNotebookRuntime(esbuild)
  ;(0, eval)(await runtime)
}

/** Runs a notebook's cells script the way its frame does. */
async function run(notebook: ObservableNotebook | ObservableRun, saved?: SavedView) {
  await loadRuntime()
  document.body.innerHTML = '<main></main>'
  ;(0, eval)(notebookCellsScript(notebook, saved))
  return document.querySelector('main')!
}

type Selected = { label: string; ids?: Array<string>; state?: Record<string, unknown> } | null

/** What the views report to the page's bridge (`theorem.select`), newest last. */
function selections() {
  const seen: Array<Selected> = []
  ;(window as { theorem?: unknown }).theorem = {
    select: async (selection: Selected) => void seen.push(selection),
  }
  return seen
}

afterEach(() => {
  document.body.innerHTML = ''
  delete (window as { theorem?: unknown }).theorem
})

test('the sandbox import map carries the d3 bundle and the notebook runtime', () => {
  expect(importMap.imports.d3).toMatch(/^\/vendor\/d3@7\.9\.0\//)
  expect(importMap.imports['@observablehq/notebook-kit/runtime']).toBeDefined()
})

test('d3 resolves inside the sandbox runtime, from the bundle', async () => {
  await run({ form: 'observable', title: 'Empty', cells: [] })
  const d3 = (await window.__theoremImport!('d3')) as typeof D3Array & {
    scaleLinear: () => { domain: (d: number[]) => { range: (r: number[]) => (x: number) => number } }
  }
  expect(d3.scaleLinear().domain([0, 10]).range([0, 100])(5)).toBe(50)
  expect(d3.max([3, 9, 4])).toBe(9)
})

test('a module the bundle does not hold is imported from where notebook-kit resolves it', async () => {
  const script = notebookCellsScript({
    form: 'observable',
    title: 'Imports',
    cells: [
      { id: 'npm', kind: 'js', source: 'import _ from "lodash"' },
      { id: 'scoped', kind: 'js', source: 'import {tableFromIPC} from "npm:apache-arrow"' },
      { id: 'url', kind: 'js', source: 'const m = import("https://esm.sh/canvas-confetti@1")' },
    ],
  })
  expect(script).toContain('__theoremImport("lodash", "https://cdn.jsdelivr.net/npm/lodash/+esm")')
  expect(script).toContain('"https://cdn.jsdelivr.net/npm/apache-arrow@17.0.0/+esm"')
  expect(script).toContain('__theoremImport("https://esm.sh/canvas-confetti@1", "https://esm.sh/canvas-confetti@1")')
  await run({ form: 'observable', title: 'Empty', cells: [] })
  const module = (await window.__theoremImport!('seven', 'data:text/javascript,export default 7')) as { default: number }
  expect(module.default).toBe(7)
})

test('cells run reactively: an import in one cell feeds an expression in the next', async () => {
  const main = await run({
    form: 'observable',
    title: 'Scale',
    cells: [
      { id: 'title', kind: 'md', source: '# Half of ${total}' },
      { id: 'lib', kind: 'js', source: 'import * as d3 from "d3"' },
      { id: 'total', kind: 'js', source: 'const total = data.total' },
      {
        id: 'scaled',
        kind: 'js',
        source: 'd3.scaleLinear().domain([0, total]).range([0, 100])(total / 2)',
      },
    ],
    data: { total: 40 },
  })
  const scaled = main.querySelector('[data-cell-id="scaled"]')!
  await waitFor(() => scaled.textContent.includes('50'))
  await waitFor(() => main.querySelector('h1')?.textContent.includes('Half of 40'))
  expect(
    [...main.querySelectorAll<HTMLElement>('.cell')].map((s) => s.dataset.cellId),
  ).toEqual(['title', 'lib', 'total', 'scaled'])
})

test('a cell that does not parse shows its error and the others still run', async () => {
  const main = await run({
    form: 'observable',
    title: 'Broken',
    cells: [
      { id: 'bad', kind: 'js', source: 'const = 1' },
      { id: 'good', kind: 'js', source: '1 + 1' },
    ],
  })
  await waitFor(() => main.querySelector('[data-cell-id="good"]')!.textContent.includes('2'))
  await waitFor(() =>
    main.querySelector('[data-cell-id="bad"]')!.textContent.includes('SyntaxError'),
  )
})

test('cells read the theme as a reactive value that follows a change', async () => {
  applyTheme(LIGHT)
  const main = await run({
    form: 'observable',
    title: 'Theme',
    cells: [{ id: 'ink', kind: 'js', source: 'theme.mode + " " + theme.series[0]' }],
  })
  const cell = main.querySelector('[data-cell-id="ink"]')!
  await waitFor(() => cell.textContent.includes('light rgb(10, 20, 30)'))
  applyTheme({ mode: 'dark', tokens: { '--redwood': 'rgb(200, 100, 50)' } })
  window.dispatchEvent(new Event(THEME_EVENT))
  await waitFor(() => cell.textContent.includes('dark rgb(200, 100, 50)'))
})

test('the document carries what it runs, its theme baked in for the first paint', async () => {
  const html = await observableDocument(
    { form: 'observable', title: 'Doc', cells: [{ id: 'a', kind: 'js', source: '1' }] },
    LIGHT,
    { esbuild },
  )
  expect(html).not.toContain('Content-Security-Policy')
  expect(html).toContain('--redwood:rgb(10, 20, 30)')
  expect(html).toContain('__theoremNotebook.start')
  expect(html).not.toMatch(/cdn\.jsdelivr\.net\/npm\/d3/)
})

test('the frame puts no policy over the notebook, so d3 builds its row readers from strings', async () => {
  const html = await observableDocument(
    { form: 'observable', title: 'Rows', cells: [] },
    LIGHT,
    { esbuild },
  )
  expect(html).not.toMatch(/http-equiv="Content-Security-Policy"/)
})

test('a downloaded notebook carries its data and the theme it was drawn in, so it runs on its own', () => {
  const kit = observableSource(
    {
      form: 'observable',
      title: 'Theme',
      cells: [{ id: 'ink', kind: 'js', source: 'theme.series[0]' }],
      data: { n: 1 },
    },
    LIGHT,
  )
  expect(kit).toContain('const data =')
  expect(kit).toContain('const theme =')
  expect(kit).toContain('rgb(10, 20, 30)')
  expect(kit.indexOf('const theme =')).toBeLessThan(kit.indexOf('theme.series[0]'))
})

test('a reply view reads an array as its data, and views.linked draws its records as a linked table', async () => {
  const main = await run({
    title: 'Linked',
    cells: [{ id: 'v', kind: 'js', source: 'views.linked(data, {x: "a", y: "b", id: "id", label: "name"})' }],
    data: [
      { id: 'p', name: 'Pine', a: 1, b: 2 },
      { id: 'q', name: 'Quill', a: 3, b: 5 },
      { id: 'r', name: 'Rook', a: 4, b: 1 },
    ],
  })
  const cell = main.querySelector('[data-cell-id="v"]')!
  await waitFor(() => cell.querySelectorAll('tbody tr').length === 3)
  expect(cell.querySelector('svg')).not.toBeNull()
  expect(cell.textContent).toContain('Quill')
})

test('views.graph selects a node and its neighbours, and reports their ids to the page', async () => {
  const seen = selections()
  const main = await run({
    title: 'Graph',
    cells: [{ id: 'g', kind: 'js', source: 'views.graph(data)' }],
    data: {
      nodes: [{ id: 'a', label: 'Alpha' }, { id: 'b', label: 'Beta' }, { id: 'c', label: 'Gamma' }, { id: 'd' }],
      links: [{ source: 'a', target: 'b' }, { source: 'c', target: 'a' }],
    },
  })
  const cell = main.querySelector('[data-cell-id="g"]')!
  await waitFor(() => cell.querySelectorAll('.tv-node').length === 4)
  const alpha = [...cell.querySelectorAll<SVGGElement>('.tv-node')].find(
    (node) => node.getAttribute('aria-label') === 'Alpha',
  )!
  alpha.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  await waitFor(() => seen.length > 0)
  const last = seen.at(-1)!
  expect(last.label).toBe('Alpha and 2 neighbours')
  expect(new Set(last.ids)).toEqual(new Set(['a', 'b', 'c']))
  expect(last.state).toEqual({ graph1: 'a' })
  expect(alpha.getAttribute('aria-pressed')).toBe('true')
})

test('views.param marks a moved parameter, reports it, and a saved view starts from it', async () => {
  const seen = selections()
  const source = 'const k = view(views.param(Inputs.range([0, 10], {value: 2, step: 1}), "k"))'
  const main = await run({ title: 'Param', cells: [{ id: 'k', kind: 'js', source }] })
  const cell = main.querySelector('[data-cell-id="k"]')!
  await waitFor(() => cell.querySelector('input[type="range"]') !== null)
  const marker = cell.querySelector<HTMLElement>('.tv-moved')!
  expect(marker.hidden).toBe(true)
  expect(getComputedStyle(marker).display).toBe('none')
  const range = cell.querySelector<HTMLInputElement>('input[type="range"]')!
  range.value = '7'
  range.dispatchEvent(new Event('input', { bubbles: true }))
  await waitFor(() => seen.length > 0)
  expect(marker.hidden).toBe(false)
  expect(getComputedStyle(marker).display).not.toBe('none')
  expect(marker.textContent).toBe('moved from 2')
  expect(seen.at(-1)!.state).toEqual({ params: { k: 7 } })

  const reopened = await run({ title: 'Param', cells: [{ id: 'k', kind: 'js', source }] }, { params: { k: 7 } })
  const restored = reopened.querySelector('[data-cell-id="k"]')!
  await waitFor(() => restored.querySelector('input[type="range"]') !== null)
  expect(restored.querySelector<HTMLInputElement>('input[type="range"]')!.valueAsNumber).toBe(7)
  expect(restored.querySelector<HTMLElement>('.tv-moved')!.hidden).toBe(false)
})

test('a cell that throws reports a page error naming the cell, so the reply can offer Fix', async () => {
  const errors: Array<string> = []
  const listen = (event: ErrorEvent) => errors.push(event.message)
  window.addEventListener('error', listen)
  try {
    await run({ title: 'Throws', cells: [{ id: 'bad', kind: 'js', source: 'data.missing.field' }] })
    await waitFor(() => errors.length > 0)
    expect(errors[0]).toMatch(/^Cell bad: /)
  } finally {
    window.removeEventListener('error', listen)
  }
})

test('a ready cell says what it shows: an empty array, each name it defines, a chart with no marks', async () => {
  const statuses: Array<CellStatus> = []
  const listen = (event: Event) => statuses.push((event as CustomEvent<CellStatus>).detail)
  window.addEventListener(CELL_STATUS_EVENT, listen)
  try {
    await run({
      title: 'Shows',
      cells: [
        { id: 'rows', kind: 'js', source: '[]' },
        { id: 'window', kind: 'js', source: 'const start = 2005\nconst picked = []' },
        {
          id: 'chart',
          kind: 'js',
          source: [
            'const figure = document.createElement("figure")',
            'for (const [label, marks] of [["line", 0], ["x-axis tick", 3]]) {',
            '  const group = figure.appendChild(document.createElement("div"))',
            '  group.setAttribute("aria-label", label)',
            '  for (let i = 0; i < marks; i++) group.append(document.createElement("span"))',
            '}',
            'display(figure)',
            'figure',
          ].join('\n'),
        },
      ],
    })
    await waitFor(() => statuses.length === 3)
    const shows = Object.fromEntries(statuses.map((status) => [status.cell, status.shows]))
    expect(shows.rows).toMatch(/^Array\(0\)/)
    expect(shows.window).toMatch(/^start = 2005; picked = Array\(0\)/)
    expect(shows.chart).toBe('figure = <figure> line ×0, x-axis tick ×3')
  } finally {
    window.removeEventListener(CELL_STATUS_EVENT, listen)
  }
})

test('a name view() defines shows the value of the input the cell shows', async () => {
  const statuses: Array<CellStatus> = []
  const listen = (event: Event) => statuses.push((event as CustomEvent<CellStatus>).detail)
  window.addEventListener(CELL_STATUS_EVENT, listen)
  try {
    await run({
      title: 'Viewed',
      cells: [{ id: 'k', kind: 'js', source: 'const k = view(Inputs.range([0, 10], {value: 3, step: 1}))' }],
    })
    await waitFor(() => statuses.length === 1)
    expect(statuses[0]).toEqual({ cell: 'k', stage: 'ready', shows: 'k = 3' })
  } finally {
    window.removeEventListener(CELL_STATUS_EVENT, listen)
  }
})

test('each cell tells the page once how it first settled, a failure with its error', async () => {
  const statuses: Array<CellStatus> = []
  const listen = (event: Event) => statuses.push((event as CustomEvent<CellStatus>).detail)
  const quiet = (event: ErrorEvent) => event.preventDefault()
  window.addEventListener(CELL_STATUS_EVENT, listen)
  window.addEventListener('error', quiet)
  try {
    await run({
      title: 'Settles',
      cells: [
        { id: 'n', kind: 'js', source: 'n = 3' },
        { id: 'tripled', kind: 'js', source: 'n * 3' },
        { id: 'bad', kind: 'js', source: 'broken = data.missing.field' },
        { id: 'heir', kind: 'js', source: 'broken + 1' },
      ],
    })
    await waitFor(() => statuses.length === 4)
    const by = Object.fromEntries(statuses.map((status) => [status.cell, status]))
    expect(by.n).toEqual({ cell: 'n', stage: 'ready', shows: '3' })
    expect(by.tripled).toEqual({ cell: 'tripled', stage: 'ready', shows: '9' })
    expect(by.bad?.stage).toBe('failed')
    expect(by.bad?.error).toBeTruthy()
    expect(by.heir).toEqual({ cell: 'heir', stage: 'failed', error: by.bad!.error })
  } finally {
    window.removeEventListener(CELL_STATUS_EVENT, listen)
    window.removeEventListener('error', quiet)
  }
})

test('a page carries only the modules its cells import', async () => {
  const bare = await observablePage({ title: 'Bare', cells: [{ id: 'a', kind: 'js', source: '1 + 1' }] }, LIGHT, { esbuild })
  const withD3 = await observablePage(
    { title: 'D3', cells: [{ id: 'a', kind: 'js', source: 'import * as d3 from "d3"' }] },
    LIGHT,
    { esbuild },
  )
  expect(withD3.length).toBeGreaterThan(bare.length)
  expect(bare).not.toContain('"d3"')
})

test('a cell in Observable JavaScript runs too: viewof and bare assignments', async () => {
  const main = await run({
    title: 'Dialect',
    cells: [
      { id: 'base', kind: 'js', source: 'base = 10' },
      { id: 'k', kind: 'js', source: 'viewof k = views.param(Inputs.range([0, 10], {value: 3, step: 1}), "k")' },
      { id: 'sum', kind: 'js', source: '`sum ${base + k}`' },
    ],
  })
  const sum = main.querySelector('[data-cell-id="sum"]')!
  await waitFor(() => sum.textContent.includes('sum 13'))
  const range = main.querySelector<HTMLInputElement>('[data-cell-id="k"] input[type="range"]')!
  range.value = '5'
  range.dispatchEvent(new Event('input', { bubbles: true }))
  await waitFor(() => sum.textContent.includes('sum 15'))
})
