// SOURCING: @observablehq/notebook-kit's transpile (each cell's inputs,
// outputs and body, as Notebook Kit compiles them, through cells.ts) and serialize (the
// notebook as a Notebook Kit file, for Copy and Download), acorn and magic-string (a
// cell's dynamic imports pointed at the frame's bundled modules, and
// notebook-kit's resolveImportDefault for the rest), the hosted
// App document and bridge (the frame), notebook-kit's inspector and highlight
// styles and Inputs' stylesheet. No library builds a notebook into an
// opaque frame of its own.
import { resolveImportDefault, serialize, toCell, toNotebook } from '@observablehq/notebook-kit'
import highlightStyle from '@observablehq/notebook-kit/highlight.css?raw'
import inspectorStyle from '@observablehq/notebook-kit/inspector.css?raw'
import inputsStyle from '@observablehq/inputs/dist/index.css?raw'
import { parseExpressionAt } from 'acorn'
import type { Node as AcornNode } from 'acorn'
import { simple } from 'acorn-walk'
import MagicString from 'magic-string'
import type * as Esbuild from 'esbuild-wasm'
import { bundleNotebookRuntime } from '@/lib/blocks/export'
import { hostedAppDocument } from '@/lib/blocks/hosted-app'
import { chartTheme } from '@/lib/blocks/sandbox/theme'
import type { ThemeState } from '@/lib/blocks/sandbox/theme'
import type { AppSelection } from '@/lib/blocks/sandbox/protocol'
import { transpileCell } from './cells'
import type { ObservableCell, ObservableNotebook } from './forms'
import { inlineCode, notebookPage, scriptJson } from './page'

type Bundler = Pick<typeof Esbuild, 'build'>

/** notebook-kit's and Inputs' styles, under the notebook surface page.ts adds. */
const OBSERVABLE_STYLE = [inputsStyle, inspectorStyle, highlightStyle].join('\n')

/** Where a module the bundle does not hold is fetched from: a bare name is an npm package, as in Observable. */
const remoteOf = (specifier: string) =>
  resolveImportDefault(/^[@\w]/.test(specifier) && !/^\w+:/.test(specifier) ? `npm:${specifier}` : specifier)

/**
 * A cell's `import("d3")` as the frame resolves it: from the bundle, which
 * holds the import map's modules, or else from where notebook-kit resolves it
 * (a URL as written, `npm:` and bare names from jsDelivr).
 */
function pointImports(body: string, imports: Set<string>): string {
  const out = new MagicString(body)
  simple(parseExpressionAt(body, 0, { ecmaVersion: 'latest' }), {
    ImportExpression(node) {
      const { source } = node as AcornNode & { source: AcornNode & { value?: unknown } }
      out.overwrite(node.start, source.start, '__theoremImport(')
      if (typeof source.value !== 'string') return
      imports.add(source.value)
      out.appendLeft(source.end, `, ${JSON.stringify(remoteOf(source.value))}`)
    },
  })
  return out.toString()
}

/** One cell's definition, as the source of an object literal. */
function compileCell(
  cell: ObservableCell,
  index: number,
  imports: Set<string>,
): string {
  const meta = { id: cell.id, kind: cell.kind }
  try {
    const compiled = transpileCell(cell.source, index, cell.kind)
    const definition = {
      ...meta,
      inputs: compiled.inputs ?? [],
      outputs: compiled.outputs ?? [],
      output: compiled.output,
      autodisplay: compiled.autodisplay === true,
      autoview: compiled.autoview === true,
      automutable: compiled.automutable === true,
    }
    return `{...${scriptJson(definition)}, body: ${pointImports(compiled.body, imports)}}`
  } catch (error) {
    // A cell that does not parse shows its error where it stands; the rest run.
    const message = (error as Error).message
    return `{...${scriptJson({ ...meta, inputs: [], outputs: [], autodisplay: true })}, body: () => { throw new SyntaxError(${scriptJson(message)}) }}`
  }
}

/** What a saved view was saved with, which its views start from (sandbox/views.ts). */
export type SavedView = { params?: Record<string, unknown>; state?: Record<string, unknown> }

/**
 * What a notebook's views hold now, as a selection carries it: the
 * parameters moved with `views.param` and each view's own state. Undefined
 * when they hold nothing, so there is nothing to start from.
 */
export function savedViewOf(selection?: AppSelection): SavedView | undefined {
  const state = selection?.state
  if (!state) return undefined
  const { params, ...views } = state as { params?: Record<string, unknown> }
  return {
    ...(params && { params }),
    ...(Object.keys(views).length && { state: views }),
  }
}

/**
 * What a page runs: a notebook's title, cells and data. A view in a reply is
 * one too, and its data may be any JSON value, such as an array of records.
 */
export type ObservableRun = Omit<ObservableNotebook, 'form' | 'data'> & {
  form?: 'observable'
  data?: unknown
}

/** The notebook's cells compiled, and the import map's modules they import. */
function compileNotebook(notebook: ObservableRun, saved?: SavedView) {
  const imports = new Set<string>()
  const cells = notebook.cells
    .map((cell, index) => compileCell(cell, index, imports))
    .join(',\n')
  const options = `{ data: ${scriptJson(notebook.data ?? {})}${saved ? `, saved: ${scriptJson(saved)}` : ''} }`
  return {
    script: inlineCode(`window.__theoremNotebook.start([\n${cells}\n], ${options})`),
    imports: [...imports].sort(),
  }
}

/** The script that defines the notebook's cells into the frame. */
export function notebookCellsScript(
  notebook: ObservableRun,
  saved?: SavedView,
): string {
  return compileNotebook(notebook, saved).script
}

type PageOptions = {
  esbuild?: Bundler
  saved?: SavedView
  /** Drawn inside a reply: no surface or margin of its own, so it reads as part of the answer. */
  inline?: boolean
}

/** What an inline notebook drops: the frame's surface and the page's margin. */
const INLINE_STYLE = '<style>html{background:transparent}body{padding:0}</style>'

/** Runtimes bundled in this page, by the modules they carry. */
const runtimes = new Map<string, Promise<string>>()

function runtimeFor(imports: Array<string>, esbuild?: Bundler) {
  if (esbuild) return bundleNotebookRuntime(esbuild, imports)
  const key = imports.join('\n')
  let runtime = runtimes.get(key)
  if (!runtime) {
    runtime = bundleNotebookRuntime(undefined, imports).catch((error) => {
      runtimes.delete(key)
      throw error
    })
    runtimes.set(key, runtime)
  }
  return runtime
}

/**
 * An Observable notebook's page before it is hosted: the notebook runtime
 * with the modules its cells import, the cells, and the theme it opened
 * with. It carries every bundled module it uses, so it is also what a view is
 * saved as: an App document that runs the same notebook anywhere an App runs.
 */
export async function observablePage(
  notebook: ObservableRun,
  theme: ThemeState,
  options: PageOptions & { head?: string } = {},
): Promise<string> {
  const { script: cells, imports } = compileNotebook(notebook, options.saved)
  const script = await runtimeFor(imports, options.esbuild)
  return notebookPage({
    title: notebook.title,
    form: 'observable',
    theme,
    style: OBSERVABLE_STYLE,
    head: [options.inline && INLINE_STYLE, options.head].filter(Boolean).join('\n') || undefined,
    main: '',
    scripts: `<script>${script}</script>\n<script>${cells}</script>`,
  })
}

/** The hosted document an Observable notebook runs in: its page with the App bridge. */
export async function observableDocument(
  notebook: ObservableRun,
  theme: ThemeState,
  options: PageOptions = {},
): Promise<string> {
  return hostedAppDocument(
    await observablePage(notebook, theme, options),
    options.esbuild,
  )
}

/** The dialect a cell is written in, as it compiles; one that does not compile keeps its kind. */
function modeOf(cell: { source: string; kind: 'js' | 'md' }) {
  try {
    return transpileCell(cell.source, 0, cell.kind).mode
  } catch {
    return cell.kind
  }
}

/**
 * The notebook as a Notebook Kit file, which Observable Desktop and
 * `notebooks preview` open. Its data and the theme it was drawn in, builtins
 * in the frame, become its first cells so the file runs on its own; the theme
 * is the page's at export, as fixed values.
 */
export function observableSource(
  notebook: ObservableNotebook,
  theme: ThemeState,
): string {
  const constant = (name: string, value: unknown) => ({
    kind: 'js' as const,
    source: `const ${name} = ${JSON.stringify(value, null, 2)}`,
  })
  const sources = [
    ...(notebook.data ? [constant('data', notebook.data)] : []),
    constant('theme', chartTheme(theme)),
    ...notebook.cells,
  ]
  return serialize(
    toNotebook({
      title: notebook.title,
      cells: sources.map((cell, index) =>
        toCell({ id: index + 1, value: cell.source, mode: modeOf(cell) }),
      ),
    }),
  )
}
