// SOURCING: @observablehq/notebook-kit's transpile (a cell's inputs, outputs
// and body, as Notebook Kit compiles them; its parse errors carry acorn's
// `pos`) and the names the frame's NotebookRuntime defines (notebook-kit's
// library, the frame's own builtins in sandbox/notebook.ts, and
// @observablehq/runtime's invalidation, visibility and @variable). What this
// adds is reading a view's cells before they run, to tell the agent that
// wrote them what will fail: no library checks a notebook without running it.
import { toCell, transpile } from '@observablehq/notebook-kit'

type Compiled = ReturnType<typeof transpile> & {
  /** The dialect the cell compiled in: Observable JavaScript when only that parses. */
  mode: 'js' | 'ojs' | 'md'
}

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
    return { ...transpile(toCell({ id, value: source, mode: kind }), options), mode: kind }
  } catch (error) {
    if (kind !== 'js') throw error
    try {
      return { ...transpile(toCell({ id, value: source, mode: 'ojs' }), options), mode: 'ojs' }
    } catch (ojs) {
      throw withRemedy(reached(ojs) > reached(error) ? ojs : error)
    }
  }
}

/** Whether a source compiles in either dialect. */
function compiles(source: string): boolean {
  try {
    transpileCell(source, 0)
    return true
  } catch {
    return false
  }
}

/**
 * A JavaScript cell as the declarations it holds. A cell that compiles is
 * one part. One that compiles in neither dialect but is several Observable
 * declarations in a row (`viewof a = ...` then `viewof b = ...`), which
 * Observable JavaScript takes one to a cell, is split at the line where each
 * next declaration starts: the shortest run of whole lines that compiles is
 * a part, and the rest is split the same way. What no run of lines makes
 * compile stays one part, and shows its error.
 */
export function cellParts(source: string, kind: 'js' | 'md' = 'js'): Array<string> {
  if (kind !== 'js' || compiles(source)) return [source]
  const lines = source.split('\n')
  for (let end = 1; end < lines.length; end++) {
    const head = lines.slice(0, end).join('\n')
    if (head.trim() && compiles(head))
      return [head, ...cellParts(lines.slice(end).join('\n').replace(/^\s*\n/, ''))]
  }
  return [source]
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

/** A cell as a notebook holds it: its source, and Markdown or JavaScript. */
type CellSource = string | { source: string; kind?: 'js' | 'md' }

/**
 * What will fail when a view's or a notebook's cells run, found without
 * running them: a cell that parses in neither dialect, a name two cells
 * define, and a name a cell reads that no cell, builtin or browser global
 * defines. A bare string is a JavaScript cell. Each line names the cell by
 * its place in `cells`, so the agent can fix its own view.
 */
export function cellProblems(given: ReadonlyArray<CellSource>): Array<string> {
  const problems: Array<string> = []
  // Each cell's declarations (cellParts), compiled; a part that does not
  // compile is reported and read as defining and reading nothing.
  const parts = given.map((cell, index) => {
    const { source, kind = 'js' } = typeof cell === 'string' ? { source: cell } : cell
    return cellParts(source, kind).map((part): { source: string; compiled?: Compiled } => {
      try {
        return { source: part, compiled: transpileCell(part, index, kind) }
      } catch (error) {
        problems.push(`Cell ${index + 1} does not parse: ${error instanceof Error ? error.message : String(error)}`)
        return { source: part, compiled: undefined }
      }
    })
  })
  const each = (visit: (part: { source: string; compiled: Compiled }, index: number) => void) =>
    parts.forEach((cell, index) => cell.forEach((part) => part.compiled && visit(part as { source: string; compiled: Compiled }, index)))
  const readBy = (name: string, except: number) =>
    parts.some((cell, at) => at !== except && cell.some((part) => part.compiled?.inputs?.includes(name)))
  const definers = new Map<string, Array<number>>()
  each(({ compiled }, index) => {
    for (const name of definedBy(compiled)) definers.set(name, [...(definers.get(name) ?? []), index + 1])
  })
  for (const [name, at] of definers)
    if (at.length > 1 && !name.includes('$'))
      problems.push(`Cells ${at.join(' and ')} each define \`${name}\`; one cell defines each name.`)
  // An input bound without `viewof` or `view()` is the element, not its value:
  // a cell that reads it gets NaN or "[object HTMLFormElement]", and no error.
  each(({ source, compiled }, index) => {
    const name = /^\s*(?:const\s+)?([A-Za-z_$][\w$]*)\s*=\s*Inputs\.\w+\(/.exec(source)?.[1]
    if (!name || !definedBy(compiled).includes(name) || !readBy(name, index)) return
    problems.push(
      `Cell ${index + 1} binds \`${name}\` to the input element, so cells that read \`${name}\` get the element, not its value: write \`viewof ${name} = Inputs...\` or \`const ${name} = view(Inputs...)\`.`,
    )
  })
  // A cell `name = ...` displays what it defines, so the input `view()`
  // showed is replaced by its value as soon as it has one.
  each(({ source, compiled }, index) => {
    const name = /^\s*([A-Za-z_$][\w$]*)\s*=\s*view\(/.exec(source)?.[1]
    if (name && definedBy(compiled).includes(name))
      problems.push(
        `Cell ${index + 1} shows \`${name}\`'s value in place of its input, as a cell \`${name} = ...\` displays what it defines: write \`const ${name} = view(Inputs...)\` or \`viewof ${name} = Inputs...\`.`,
      )
  })
  each(({ compiled }, index) => {
    for (const name of new Set(compiled.inputs ?? []))
      if (!definers.has(name) && !FRAME_BUILTINS.has(name) && !(name in globalThis))
        problems.push(`Cell ${index + 1} reads \`${written(name)}\`, which no cell defines.`)
  })
  return [...new Set(problems)]
}

/**
 * Each pending cell that waits on no other pending cell, with the pending
 * cells that wait on it, directly or through others: where a view that stays
 * `mounted` while its page draws is stuck, such as an input that was given a
 * value it does not take and so gives none. `pending` and the answer are
 * indexes into `cells`; a root nothing waits on is left out.
 */
export function blockingCells(cells: ReadonlyArray<string>, pending: ReadonlyArray<number>): Map<number, Array<number>> {
  // Each cell's declarations compiled (cellParts); one that does not compile defines and reads nothing.
  const compiled = cells.map((source, index) =>
    cellParts(source).flatMap((part) => {
      try {
        return [transpileCell(part, index)]
      } catch {
        return []
      }
    }),
  )
  const waiting = new Set(pending)
  const definer = new Map<string, number>()
  compiled.forEach((cell, index) => cell.forEach((part) => definedBy(part).forEach((name) => definer.set(name, index))))
  const waitsOn = (index: number) =>
    new Set(
      (compiled[index] ?? []).flatMap((part) => part.inputs ?? []).flatMap((name) => {
        const at = definer.get(name)
        return at !== undefined && at !== index && waiting.has(at) ? [at] : []
      }),
    )
  const reaches = (from: number, to: number, seen = new Set<number>()): boolean =>
    [...waitsOn(from)].some((next) => next === to || (!seen.has(next) && (seen.add(next), reaches(next, to, seen))))
  const blocking = new Map<number, Array<number>>()
  for (const root of pending) {
    if (waitsOn(root).size) continue
    const waiters = pending.filter((other) => other !== root && reaches(other, root))
    if (waiters.length) blocking.set(root, waiters)
  }
  return blocking
}
