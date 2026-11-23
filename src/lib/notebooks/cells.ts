// SOURCING: @observablehq/notebook-kit's transpile (a cell's inputs, outputs
// and body, as Notebook Kit compiles them; its parse errors carry acorn's
// `pos`) and the names the frame's NotebookRuntime defines (notebook-kit's
// library, the frame's own builtins in sandbox/notebook.ts, and
// @observablehq/runtime's invalidation, visibility and @variable). What this
// adds is reading a view's cells before they run, to tell the agent that
// wrote them what will fail: no library checks a notebook without running it.
import { toCell, transpile } from '@observablehq/notebook-kit'

type Compiled = ReturnType<typeof transpile>

/** How far into the source a parse got before it failed. */
const reached = (error: unknown) => {
  const pos = (error as { pos?: unknown }).pos
  return typeof pos === 'number' ? pos : -1
}

/**
 * A cell compiled by Notebook Kit. JavaScript that does not parse is tried as
 * Observable JavaScript (`viewof x = ...`, `x = {...}`), which Notebook Kit
 * also compiles, so a cell written in either dialect runs. When neither
 * parses, the error shown is the one from the dialect that read further: that
 * is the dialect the cell was written in, and its error names the real fault.
 */
export function transpileCell(source: string, id: number, kind: 'js' | 'md' = 'js'): Compiled {
  const options = { resolveImport: (specifier: string) => specifier }
  try {
    return transpile(toCell({ id, value: source, mode: kind }), options)
  } catch (error) {
    if (kind !== 'js') throw error
    try {
      return transpile(toCell({ id, value: source, mode: 'ojs' }), options)
    } catch (ojs) {
      throw withRemedy(reached(ojs) > reached(error) ? ojs : error)
    }
  }
}

/** A parse error, with how to write what the cell meant when the fault is a known one. */
function withRemedy(error: unknown): unknown {
  if (!(error instanceof Error)) return error
  const assigned = /^Assignment to (?:constant|external) variable '?([\w$]+)'?/.exec(error.message)?.[1]
  if (assigned)
    error.message += `. A cell cannot assign a value another cell defines: declare it \`mutable ${assigned} = ...\` and write \`mutable ${assigned} = ...\` where it changes.`
  return error
}

/**
 * Every name a view's cells can read without defining it: notebook-kit's
 * library (pinned to it by cells.test.ts), the frame's own builtins, and the
 * runtime's.
 */
export const FRAME_BUILTINS: ReadonlySet<string> = new Set([
  // notebook-kit's library
  'dark', 'now', 'width', 'DatabaseClient', 'FileAttachment', 'Generators', 'Interpreter',
  'Mutable', 'Promises', 'Files', 'DOM', 'sql',
  '_', 'aq', 'Arrow', 'd3', 'dot', 'duckdb', 'DuckDBClient', 'echarts', 'Flechette', 'htl',
  'html', 'svg', 'Inputs', 'L', 'mapboxgl', 'md', 'mermaid', 'Plot', 'React', 'ReactDOM',
  'tex', 'topojson', 'vl',
  'aapl', 'alphabet', 'cars', 'citywages', 'diamonds', 'flare', 'industries', 'miserables',
  'olympians', 'penguins', 'pizza', 'weather',
  // the frame's (sandbox/notebook.ts) and notebook-kit's define
  'theme', 'data', 'saved', 'views', 'display', 'view',
  // @observablehq/runtime's
  'invalidation', 'visibility', '@variable',
])

/** The names a compiled cell defines, as the runtime defines them. */
function definedBy(compiled: Compiled): Array<string> {
  const { output, outputs = [] } = compiled
  if (output == null) return outputs
  if (output.startsWith('viewof$')) return [output, output.slice('viewof$'.length)]
  if (output.startsWith('initial ')) {
    const name = output.slice('initial '.length)
    return [name, `mutable$${name}`]
  }
  return [output]
}

/** The name a reader would write for a runtime name. */
const written = (name: string) => name.replace(/^viewof\$/, 'viewof ').replace(/^mutable\$/, 'mutable ')

/**
 * What will fail when a view's cells run, found without running them: a cell
 * that parses in neither dialect, a name two cells define, and a name a cell
 * reads that no cell, builtin or browser global defines. Each line names the
 * cell by its place in `cells`, so the agent can fix its own view.
 */
export function cellProblems(cells: ReadonlyArray<string>): Array<string> {
  const problems: Array<string> = []
  const compiled: Array<Compiled | undefined> = cells.map((source, index) => {
    try {
      return transpileCell(source, index)
    } catch (error) {
      problems.push(`Cell ${index + 1} does not parse: ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
  })
  const definers = new Map<string, Array<number>>()
  compiled.forEach((cell, index) => {
    if (!cell) return
    for (const name of definedBy(cell)) definers.set(name, [...(definers.get(name) ?? []), index + 1])
  })
  for (const [name, at] of definers)
    if (at.length > 1 && !name.includes('$'))
      problems.push(`Cells ${at.join(' and ')} each define \`${name}\`; one cell defines each name.`)
  // An input bound without `viewof` or `view()` is the element, not its value:
  // a cell that reads it gets NaN or "[object HTMLFormElement]", and no error.
  compiled.forEach((cell, index) => {
    const name = /^\s*(?:const\s+)?([A-Za-z_$][\w$]*)\s*=\s*Inputs\.\w+\(/.exec(cells[index] ?? '')?.[1]
    if (!cell || !name || !definedBy(cell).includes(name)) return
    if (compiled.some((other, at) => at !== index && other?.inputs?.includes(name)))
      problems.push(
        `Cell ${index + 1} binds \`${name}\` to the input element, so cells that read \`${name}\` get the element, not its value: write \`viewof ${name} = Inputs...\` or \`const ${name} = view(Inputs...)\`.`,
      )
  })
  compiled.forEach((cell, index) => {
    if (!cell) return
    for (const name of new Set(cell.inputs ?? []))
      if (!definers.has(name) && !FRAME_BUILTINS.has(name) && !(name in globalThis))
        problems.push(`Cell ${index + 1} reads \`${written(name)}\`, which no cell defines.`)
  })
  return problems
}
