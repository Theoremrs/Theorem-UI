// SOURCING: acorn (the declaration list is parsed as JavaScript call
// expressions, so it reads like the calls the block makes). Which calls exist
// is this app's own capability model (plan D9), hand-rolled.
import { parseExpressionAt } from 'acorn'
import type { Expression, SpreadElement } from 'acorn'
import { APP_HISTORY_DAYS } from './app-db'

/**
 * What a block declared it may reach. A block gets exactly these and nothing
 * else: no declaration, no capability.
 */
export interface Capabilities {
  /** Workspace paths or globs it may read, `files.read("Data/*.csv")`. */
  read: Array<string>
  /** Workspace paths or globs it may write, `files.write("Data/log.csv")`. */
  write: Array<string>
  /** Shared state collections, `state("habits")`. */
  state: Array<string>
  /** Hosts it may fetch from over HTTPS, `net("api.example.com")`. */
  net: Array<string>
  /** Agent blocks it may start, `run("agent:#nightly")`. */
  run: Array<string>
  /** Graph databases it keeps in this browser, `db("records")`. */
  db: Array<string>
}

export const noCapabilities = (): Capabilities => ({
  read: [],
  write: [],
  state: [],
  net: [],
  run: [],
  db: [],
})

/**
 * A block with effects runs only when someone presses Run: writing files,
 * reaching the network and starting agents are never part of recomputing.
 */
export const isEffectful = (capabilities: Capabilities): boolean =>
  capabilities.write.length > 0 ||
  capabilities.net.length > 0 ||
  capabilities.run.length > 0

export interface Declarations {
  capabilities: Capabilities
  /**
   * Days of past versions each declared database keeps, by name: the window
   * its declaration gives — `db("crm", { historyDays: 365 })` — or
   * `APP_HISTORY_DAYS` when it gives none. Every `db` in `capabilities.db` is
   * in here, so a reader never has to supply a default of its own.
   */
  dbHistoryDays: Record<string, number>
  errors: Array<string>
}

const emptyDeclarations = (): Declarations => ({
  capabilities: noCapabilities(),
  dbHistoryDays: {},
  errors: [],
})

const CALLS: Record<string, keyof Capabilities> = {
  'files.read': 'read',
  'files.write': 'write',
  state: 'state',
  net: 'net',
  run: 'run',
  db: 'db',
}

const HOST = /^[a-z0-9.-]+(:\d+)?$/i
const RUN_TARGET = /^agent:#[\w:.-]+$/
/** A database's name is part of a file name in the browser's private storage. */
export const DB_NAME = /^[a-z0-9][a-z0-9_-]{0,47}$/

function calleeName(node: Expression): string | null {
  if (node.type === 'Identifier') return node.name
  if (
    node.type === 'MemberExpression' &&
    !node.computed &&
    node.object.type === 'Identifier' &&
    node.property.type === 'Identifier'
  )
    return `${node.object.name}.${node.property.name}`
  return null
}

function stringArgument(
  node: Expression | SpreadElement | undefined,
): string | null {
  if (node?.type === 'Literal' && typeof node.value === 'string')
    return node.value
  if (node?.type === 'TemplateLiteral' && node.expressions.length === 0)
    return node.quasis[0]?.value.cooked ?? null
  return null
}

/**
 * The window in `db("name", { historyDays: n })`'s second argument, or what is
 * wrong with it.
 */
function dbHistoryDays(
  name: string,
  node: Expression | SpreadElement,
): number | string {
  const usage = `db("${name}", …) takes { historyDays: n }, a number of days, zero or more`
  if (node.type !== 'ObjectExpression') return usage
  const [property, ...rest] = node.properties
  if (!property || rest.length > 0 || property.type !== 'Property') return usage
  const key =
    property.key.type === 'Identifier'
      ? property.key.name
      : property.key.type === 'Literal'
        ? property.key.value
        : null
  const value = property.value
  if (
    property.computed ||
    property.kind !== 'init' ||
    key !== 'historyDays' ||
    value.type !== 'Literal' ||
    typeof value.value !== 'number' ||
    !Number.isFinite(value.value) ||
    value.value < 0
  )
    return usage
  return value.value
}

function validate(kind: keyof Capabilities, value: string): string | null {
  if (kind === 'net' && !HOST.test(value))
    return `net("${value}") needs a host name such as api.example.com`
  if (kind === 'run' && !RUN_TARGET.test(value))
    return `run("${value}") needs an agent block such as agent:#nightly`
  if (kind === 'db' && !DB_NAME.test(value))
    return `db("${value}") needs a short name of lowercase letters, digits, - and _, such as records`
  if (
    (kind === 'read' || kind === 'write') &&
    /^\/|(^|\/)\.\.(\/|$)/.test(value)
  )
    return `files.${kind}("${value}") must stay inside the folder`
  return null
}

/** Parses one list of declarations, `files.read("a.csv"), state("x")`. */
export function parseDeclarationList(
  text: string,
  into: Declarations = emptyDeclarations(),
): Declarations {
  if (!text.trim()) return into
  let expression: Expression
  try {
    expression = parseExpressionAt(text, 0, { ecmaVersion: 'latest' })
  } catch (error) {
    into.errors.push(
      `Cannot read "${text.trim()}": ${(error as Error).message}`,
    )
    return into
  }
  const calls =
    expression.type === 'SequenceExpression'
      ? expression.expressions
      : [expression]
  for (const call of calls) {
    const source = text.slice(call.start, call.end)
    const kind =
      call.type === 'CallExpression' && call.callee.type !== 'Super'
        ? CALLS[calleeName(call.callee) ?? '']
        : undefined
    const args = call.type === 'CallExpression' ? call.arguments : []
    // A database may also say how much history it keeps.
    const value =
      args.length === 1 || (kind === 'db' && args.length === 2)
        ? stringArgument(args[0])
        : null
    if (!kind || value === null) {
      into.errors.push(
        `"${source}" is not a declaration; use files.read("…"), files.write("…"), state("…"), db("…"), net("…") or run("agent:#…")`,
      )
      continue
    }
    const problem = validate(kind, value)
    if (problem) {
      into.errors.push(problem)
      continue
    }
    if (kind === 'db') {
      // A declaration of a database always settles its window: the one it
      // states, or the default it leaves itself. Saying `db("crm")` besides
      // `db("crm", { historyDays: 365 })` would otherwise mix the two.
      const days = args[1] ? dbHistoryDays(value, args[1]) : APP_HISTORY_DAYS
      if (typeof days === 'string') {
        into.errors.push(days)
        continue
      }
      // A database may be named `constructor`: only own keys count.
      const before = Object.hasOwn(into.dbHistoryDays, value)
        ? into.dbHistoryDays[value]
        : undefined
      if (before !== undefined && before !== days) {
        into.errors.push(
          `db("${value}") is declared with two windows, ${before} and ${days} days`,
        )
        continue
      }
      into.dbHistoryDays[value] = days
    }
    if (!into.capabilities[kind].includes(value))
      into.capabilities[kind].push(value)
  }
  return into
}

const USES_LINE = /^\s*\/\/\s*uses:(.*)$/

/**
 * The declarations in a code block's leading comments:
 *
 *     // uses: files.read("Data/habits.csv"), state("habits")
 *     // uses: net("api.example.com")
 *
 * Only the comment lines before the first line of code count.
 */
export function parseCodeDeclarations(source: string): Declarations {
  const declarations = emptyDeclarations()
  for (const line of source.split('\n')) {
    const uses = USES_LINE.exec(line)
    if (uses) parseDeclarationList(uses[1] ?? '', declarations)
    else if (line.trim() !== '' && !/^\s*(\/\/|\/\*|\*)/.test(line)) break
  }
  return declarations
}

/** The declarations of an HTML app, from `<meta name="theorem:uses" content="…">`. */
export function parseHtmlDeclarations(contents: Array<string>): Declarations {
  const declarations = emptyDeclarations()
  for (const content of contents) parseDeclarationList(content, declarations)
  return declarations
}
