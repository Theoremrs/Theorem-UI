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
import { NotebookRuntime, library } from '@observablehq/notebook-kit/runtime'
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

/**
 * A cell's failure, told to the page as the frame's uncaught errors are: the
 * inspector shows it in the cell and catches it, so the bridge would not hear.
 */
function reported(cell: NotebookCell): NotebookCell['body'] {
  const tell = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    window.dispatchEvent(
      new ErrorEvent('error', { error, message: `Cell ${cell.id}: ${message}` }),
    )
  }
  return (...inputs) => {
    try {
      const result = cell.body(...inputs)
      if (result instanceof Promise)
        return result.catch((error: unknown) => {
          tell(error)
          throw error
        })
      return result
    } catch (error) {
      tell(error)
      throw error
    }
  }
}

/** Defines the notebook's cells into `root`, in order. */
export function start(
  cells: Array<NotebookCell>,
  options: { data?: unknown; saved?: SavedView; root?: HTMLElement },
  modules: Modules,
) {
  Object.assign(window, {
    __theoremImport: (specifier: string) =>
      Object.hasOwn(modules, specifier)
        ? modules[specifier]!()
        : Promise.reject(
            new Error(
              `"${specifier}" is not in the sandbox's import map; a notebook loads nothing from the network`,
            ),
          ),
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
  for (const cell of cells) {
    const element = document.createElement('div')
    element.className = 'cell'
    element.dataset.cellId = cell.id
    element.dataset.kind = cell.kind
    root.append(element)
    notebook.define(
      { root: element, expanded: [], variables: [] },
      { ...cell, body: reported(cell), id: cells.indexOf(cell) },
    )
  }
  return notebook
}
