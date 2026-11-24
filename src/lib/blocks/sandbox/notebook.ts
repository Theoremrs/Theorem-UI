// SOURCING: @observablehq/notebook-kit's runtime (NotebookRuntime: Observable's
// reactive runtime, its display and inspector, and the standard library), from
// the vendored import map like every other sandbox module. The page compiles
// each cell with notebook-kit's transpile; this module defines them, one
// `.cell` each, and hands them Theorem's theme.
//
// It runs inside a hosted notebook's frame, after the App bridge: the bridge
// connects the page, reports height and selections, and applies theme changes.
// `views` (views.ts) is the reply's reusable views, drawn with the notebook's
// own d3 and Plot; `saved` is what a saved view was saved with.
import { NotebookRuntime, inspect, library, observe } from '@observablehq/notebook-kit/runtime'
import { CELL_STATUS_EVENT, MAX_CELL_SHOWS } from './protocol'
import type { CellStatus } from './protocol'
import { THEME_EVENT, chartTheme, readTheme } from './theme'
import type { ChartTheme } from './theme'
import { createViews } from './views'
import type { SavedView } from './views'

/** One cell as the page compiled it: notebook-kit's definition, and where it shows. */
export interface NotebookCell {
  id: string
  kind: 'js' | 'md'
  body: (...inputs: Array<unknown>) => unknown
  inputs: Array<string>
  outputs: Array<string>
  output?: string
  autodisplay: boolean
  automutable?: boolean
  autoview?: boolean
}

type Modules = Record<string, () => Promise<unknown>>

/** The theme as a reactive value: cells that read it run again when it changes. */
const theme = () =>
  library.Generators().observe<ChartTheme>((notify) => {
    const changed = () => notify(chartTheme(readTheme()))
    changed()
    window.addEventListener(THEME_EVENT, changed)
    return () => window.removeEventListener(THEME_EVENT, changed)
  })

/** The most labelled parts an element's description names. */
const MAX_PARTS = 12

/**
 * An element as a reader would count it: its tag, its labelled parts with
 * how many marks each holds (a Plot chart labels each mark and axis, so an
 * empty series reads `line ×0`), its table rows, else the start of its text.
 */
function describeElement(element: Element): string {
  const labelled = [...element.querySelectorAll('[aria-label]')]
  const parts = labelled
    .slice(0, MAX_PARTS)
    .map((part) => `${part.getAttribute('aria-label')} ×${part.childElementCount}`)
  if (labelled.length > MAX_PARTS) parts.push(`${labelled.length - MAX_PARTS} more`)
  const rows = element.querySelectorAll('tr').length
  const text = element.textContent.replace(/\s+/g, ' ').trim()
  const what = parts.length ? parts.join(', ') : rows ? `${rows} rows` : text ? JSON.stringify(text.slice(0, 80)) : 'empty'
  return `<${element.localName}> ${what}`
}

/** A value as the inspector shows it collapsed, or an element as described above. */
const describeValue = (value: unknown): string =>
  value instanceof Element ? describeElement(value) : inspect(value).textContent.trim()

/** Whether a name a cell defines is a generator, as `view()` answers, whose values are its input's. */
const isGenerator = (value: unknown) =>
  typeof value === 'object' && value !== null && typeof (value as AsyncIterable<unknown>)[Symbol.asyncIterator] === 'function'

/**
 * What a settled cell shows, for the page's receipt: the value it displays,
 * or each name it defines with its value, so an empty array or a chart with
 * no marks is seen without pixels. A name `view()` defines has the value of
 * the input the cell shows in `root`.
 */
function describeCell(value: unknown, outputs: ReadonlyArray<string>, root: Element): string {
  const input = () => [...root.children].find((child): child is Element & { value: unknown } => 'value' in child)
  const named = (name: string) => {
    const defined = (value as Record<string, unknown>)[name]
    const shown = isGenerator(defined) ? input() : undefined
    return `${name} = ${describeValue(shown ? shown.value : defined)}`
  }
  const described =
    outputs.length && typeof value === 'object' && value !== null
      ? outputs.map(named).join('; ')
      : describeValue(value)
  return described.length > MAX_CELL_SHOWS ? `${described.slice(0, MAX_CELL_SHOWS - 1)}…` : described
}

/**
 * The inspector's observer for a cell, which also tells the page when the cell
 * fails, as the frame's uncaught errors are: the inspector shows the failure
 * in the cell and catches it, so the bridge would not hear. That covers a body
 * that throws and a name the cell reads that nothing defines. A failure the
 * cell inherits from a cell it reads is the same error, told once. How each
 * cell first settles is told too (`CELL_STATUS_EVENT`), with what it shows,
 * so the page knows when the notebook's first outputs are on screen.
 */
function reporting(cellId: string, told: WeakSet<object>, settled: Set<string>): typeof observe {
  const settle = (stage: CellStatus['stage'], detail: Pick<CellStatus, 'error' | 'shows'>) => {
    if (settled.has(cellId)) return
    settled.add(cellId)
    window.dispatchEvent(new CustomEvent<CellStatus>(CELL_STATUS_EVENT, { detail: { cell: cellId, stage, ...detail } }))
  }
  return (state, definition) => {
    const observer = observe(state, definition)
    const { fulfilled, rejected } = observer
    observer.fulfilled = function (value: unknown) {
      fulfilled.call(this, value)
      if (!settled.has(cellId)) settle('ready', { shows: describeCell(value, definition.outputs ?? [], state.root) })
    }
    // The failure is told before the status, so a page that waits for every
    // cell to settle has heard why one failed.
    observer.rejected = function (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      if (typeof error !== 'object' || error === null || !told.has(error)) {
        if (typeof error === 'object' && error !== null) told.add(error)
        window.dispatchEvent(new ErrorEvent('error', { error, message: `Cell ${cellId}: ${message}` }))
      }
      rejected.call(this, error)
      settle('failed', { error: message })
    }
    return observer
  }
}

/** Defines the notebook's cells into `root`, in order. */
export function start(
  cells: Array<NotebookCell>,
  options: { data?: unknown; saved?: SavedView; root?: HTMLElement },
  modules: Modules,
) {
  Object.assign(window, {
    __theoremImport: (specifier: string, remote = specifier) =>
      Object.hasOwn(modules, specifier) ? modules[specifier]!() : import(/* @vite-ignore */ remote),
  })
  const root = options.root ?? document.querySelector('main') ?? document.body
  const notebook = new NotebookRuntime({
    ...library,
    theme,
    data: () => options.data ?? {},
    saved: () => options.saved ?? {},
    views: () =>
      Promise.all([library.d3(), library.Plot()]).then(([d3, Plot]) =>
        createViews(d3, Plot, options.saved),
      ),
  })
  const told = new WeakSet<object>()
  const settled = new Set<string>()
  for (const cell of cells) {
    const element = document.createElement('div')
    element.className = 'cell'
    element.dataset.cellId = cell.id
    element.dataset.kind = cell.kind
    root.append(element)
    notebook.define(
      { root: element, expanded: [], variables: [] },
      { ...cell, id: cells.indexOf(cell) },
      reporting(cell.id, told, settled),
    )
  }
  return notebook
}
