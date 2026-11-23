// SOURCING: @assistant-ui/generative-ui's A2UI subpath (applyA2uiOperations
// reduces v0.9, v0.9.1 and v1.0 operations of any catalog into surfaces;
// convertSurfaceToUISpec maps the basic catalog onto the vocabulary and,
// with keepUnknownComponents, keeps every other component as a `$type` node
// with its resolved props and children). What this app adds is drawing those
// kept nodes, and keeping their actions live: no library renders a component
// its vocabulary does not name.
//
// The agent's own A2UI, in its reply. Any catalog and any component is
// accepted: the basic catalog is drawn by the vocabulary, and a component the
// vocabulary does not name is drawn from what it carries (its label and
// value, its other plain properties, its children), so nothing the agent
// wrote is dropped. Warnings go back to the agent in the receipt, to help it
// fix its own output.
import {
  applyA2uiOperations,
  convertSurfaceToUISpec,
} from '@assistant-ui/generative-ui/a2ui'
import type { A2uiOperation } from '@assistant-ui/generative-ui/a2ui'

/** The protocol versions applyA2uiOperations reads. */
const A2UI_VERSIONS = ['v0.9', 'v0.9.1', 'v1.0'] as const

type Node = Record<string, unknown>

const isNode = (value: unknown): value is Node =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const typeOf = (node: Node) => {
  const type = node.$type ?? node._type
  return typeof type === 'string' ? type : undefined
}

const scalar = (value: unknown): value is string | number =>
  typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))

/**
 * A component the vocabulary does not name, as the vocabulary draws it: its
 * label and value as one fact (or, when it fires an action, a button), each
 * other plain property as a fact of its own, then its children.
 */
function drawnFromProps(node: Node, children: unknown, surfaceId?: string): Node {
  const { $type, _type, children: _, $key, label, value, action: raw, ...rest } = node
  const $action = node.$action ?? (surfaceId === undefined ? undefined : a2uiActionOf(raw, surfaceId))
  const facts: Array<Node> = []
  // An action the component fires stays live, as a button named by its label.
  if ($action !== undefined) {
    facts.push({ $type: 'Button', label: scalar(label) ? String(label) : String($type ?? _type), $action })
    if (scalar(value)) facts.push({ $type: 'Text', value })
  } else if (scalar(label) && scalar(value)) facts.push({ $type: 'Fact', label, value })
  else {
    if (scalar(label)) facts.push({ $type: 'Text', value: label, weight: 'medium' })
    if (scalar(value)) facts.push({ $type: 'Text', value })
  }
  for (const [key, entry] of Object.entries(rest))
    if (!key.startsWith('$') && scalar(entry)) facts.push({ $type: 'Fact', label: key, value: entry })
  const kids = Array.isArray(children) ? children : children === undefined ? [] : [children]
  return {
    $type: 'Col',
    ...($key !== undefined && { $key }),
    gap: 1,
    children: [...(facts.length ? [{ $type: 'Row', gap: 3, children: facts }] : []), ...kids],
  }
}

/**
 * A kept component's own A2UI `action`, as the converter shapes a basic
 * component's (an event by name with its context and user message, or a
 * function call with its arguments). The converter leaves a component it
 * does not map with its action as written, so the action is read here.
 */
function a2uiActionOf(action: unknown, surfaceId: string): Node | undefined {
  if (!isNode(action)) return undefined
  const event = isNode(action.event) ? action.event : action
  if (typeof event.name === 'string')
    return {
      type: 'a2ui:action',
      name: event.name,
      surfaceId,
      ...(typeof event.userMessage === 'string' && { userMessage: event.userMessage }),
      ...(event.context !== undefined && { context: event.context }),
    }
  const call = isNode(action.functionCall) ? action.functionCall : undefined
  if (call && typeof call.call === 'string')
    return { type: 'a2ui:functionCall', call: call.call, surfaceId, ...(isNode(call.args) && { args: call.args }) }
  return undefined
}

/**
 * The tree with every component the vocabulary does not name drawn from its
 * properties, and the names of those components.
 */
export function withUnknownDrawn(
  tree: unknown,
  known: (type: string) => boolean,
  surfaceId?: string,
): { tree: unknown; unknown: Array<string> } {
  const unknown = new Set<string>()
  const walk = (value: unknown, depth: number): unknown => {
    if (depth > 64) return null
    if (Array.isArray(value)) return value.map((entry) => walk(entry, depth + 1))
    if (!isNode(value)) return value
    const type = typeOf(value)
    if (!type) return value
    const children = value.children === undefined ? undefined : walk(value.children, depth + 1)
    if (known(type)) return children === undefined ? value : { ...value, children }
    unknown.add(type)
    return drawnFromProps(value, children, surfaceId)
  }
  return { tree: walk(tree, 0), unknown: [...unknown] }
}

export interface PresentedTree {
  readonly key: string
  readonly tree: unknown
}

/** What a present call paints: its trees, what they are, and what to tell the agent. */
export interface Presentation {
  readonly trees: Array<PresentedTree>
  readonly painted: Array<string>
  readonly warnings: Array<string>
}

/**
 * What a present call's arguments paint. A `_type` tree is drawn as given; an
 * `a2ui` run of operations, of any catalog and version the reducer reads, is
 * reduced into surfaces and each surface converted to a tree. Either way a
 * component the vocabulary does not name is drawn from what it carries. A
 * malformed operation is reported, not thrown, so a streaming call is safe.
 */
export function presentation(
  args: Record<string, unknown>,
  known: (type: string) => boolean,
): Presentation {
  const trees: Array<PresentedTree> = []
  const painted: Array<string> = []
  const warnings: Array<string> = []
  const unknown = new Set<string>()
  const draw = (key: string, tree: unknown, surfaceId?: string) => {
    const drawn = withUnknownDrawn(tree, known, surfaceId)
    for (const name of drawn.unknown) unknown.add(name)
    trees.push({ key, tree: drawn.tree })
  }
  if (Array.isArray(args.a2ui)) {
    const reduced = applyA2uiOperations(new Map(), args.a2ui as Array<A2uiOperation>)
    warnings.push(...reduced.warnings)
    // The reducer names the operation but not what it reads; say it, so the
    // agent can fix the stamp rather than guess.
    if (reduced.warnings.some((warning) => warning.includes('unsupported version')))
      warnings.push(`Each message needs "version" set to ${A2UI_VERSIONS.map((v) => `"${v}"`).join(', ')}.`)
    if (reduced.warnings.some((warning) => /^Component at .* is malformed|malformed components/.test(warning)))
      warnings.push(
        'A component is a flat object: {"id": "gauge", "component": "Gauge", ...its props}, its type a string; a parent names its children by id ("children": ["a", "b"]) and one component has the id "root".',
      )
    for (const [surfaceId, surface] of reduced.state) {
      const converted = convertSurfaceToUISpec(surface, { keepUnknownComponents: true })
      warnings.push(...converted.warnings)
      if (converted.spec == null) continue
      draw(`a2ui:${surfaceId}`, converted.spec, surfaceId)
      painted.push(surfaceId)
    }
  }
  const type = typeOf(args)
  if (type) {
    const { a2ui: _, ...tree } = args
    draw('tree', tree)
    painted.push(type)
  }
  for (const name of unknown)
    warnings.push(`"${name}" is not in the vocabulary; it was drawn from its properties and children.`)
  return { trees, painted, warnings }
}

/** An A2UI action the reader fired, in the shape the converter gives it. */
type A2uiAction = {
  readonly type?: unknown
  readonly name?: unknown
  readonly call?: unknown
  readonly args?: unknown
  readonly context?: unknown
  readonly userMessage?: unknown
  readonly surfaceId?: unknown
}

/** An http(s) address an `openUrl` call names, else nothing. */
export function openUrlOf(action: A2uiAction): string | undefined {
  if (action.type !== 'a2ui:functionCall' || action.call !== 'openUrl') return undefined
  const url = isNode(action.args) ? action.args.url : undefined
  if (typeof url !== 'string') return undefined
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : undefined
  } catch {
    return undefined
  }
}

/**
 * The message an A2UI action sends the agent: the action's own user message
 * when it gives one, else its name (or function call) with its context, so
 * the agent that wrote the surface hears what the reader did on it.
 */
export function a2uiActionMessage(action: A2uiAction): string | undefined {
  if (typeof action.userMessage === 'string' && action.userMessage.trim()) return action.userMessage
  const surface = typeof action.surfaceId === 'string' ? ` on surface "${action.surfaceId}"` : ''
  if (action.type === 'a2ui:action' && typeof action.name === 'string') {
    const context = action.context === undefined ? '' : `\n${JSON.stringify(action.context, null, 2)}`
    return `A2UI action "${action.name}"${surface}${context}`
  }
  if (action.type === 'a2ui:functionCall' && typeof action.call === 'string') {
    const args = action.args === undefined ? '' : `\n${JSON.stringify(action.args, null, 2)}`
    return `A2UI function call "${action.call}"${surface}${args}`
  }
  return undefined
}
