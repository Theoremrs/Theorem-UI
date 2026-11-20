// SOURCING: hand-roll, over the generated wire types and the WAI-ARIA 1.2 role definitions (required owned elements, required context, supported states) and its Authoring Practices patterns for tabs, tree view, listbox and alert: no library renders an external accessibility tree as ARIA, and the Rust `Role::aria()` (terminal/crates/workbench-core/src/semantics.rs) is the contract this extends where a role's own rules need more than a one-to-one name.
import type { Node, NodeAction, NodeId, Role } from '@/lib/workbench/wire'
import type { Tree } from './tree'

/** The ARIA roles the overlay writes. */
export type AriaRole =
  | 'application'
  | 'region'
  | 'toolbar'
  | 'group'
  | 'heading'
  | 'button'
  | 'listbox'
  | 'option'
  | 'tablist'
  | 'tab'
  | 'tabpanel'
  | 'tree'
  | 'treeitem'
  | 'textbox'
  | 'log'
  | 'status'
  | 'alert'
  | 'dialog'
  | 'separator'
  | 'document'
  | 'list'
  | 'listitem'

/**
 * Each wire `Role` and the ARIA role it is written as. It is `Record<Role, ...>`, so a role Rust adds
 * is a type error here until it is mapped.
 *
 * `menu` and `menuItem` are written as `listbox` and `option`, not `menu` and `menuitem`: the picker
 * and the editor's completion popup hold a text field and a list of rows chosen by a highlight that
 * moves while the keyboard stays in the text field, which is the listbox that goes with a field
 * (APG, Editable Combobox with List Autocomplete), and an ARIA menu may own nothing but menu items.
 */
export const ARIA_ROLE: Record<Role, AriaRole> = {
  application: 'application',
  region: 'region',
  toolbar: 'toolbar',
  group: 'group',
  heading: 'heading',
  button: 'button',
  menu: 'listbox',
  menuItem: 'option',
  tabList: 'tablist',
  tab: 'tab',
  tabPanel: 'tabpanel',
  tree: 'tree',
  treeItem: 'treeitem',
  textBox: 'textbox',
  log: 'log',
  status: 'status',
  alert: 'alert',
  dialog: 'dialog',
  separator: 'separator',
  document: 'document',
  list: 'list',
  listItem: 'listitem',
}

/** The roles an element of this role may own (WAI-ARIA 1.2 "required owned elements"); a role not listed owns anything. */
const OWNS: Partial<Record<AriaRole, ReadonlySet<AriaRole>>> = {
  tablist: new Set(['tab']),
  tree: new Set(['treeitem', 'group']),
  listbox: new Set(['option', 'group']),
  list: new Set(['listitem']),
}

/** The roles an element of this role must sit under ("required context role"), directly or through `group`s; a role not listed sits anywhere. */
const SITS_UNDER: Partial<Record<AriaRole, ReadonlySet<AriaRole>>> = {
  tab: new Set(['tablist']),
  treeitem: new Set(['tree']),
  option: new Set(['listbox']),
  listitem: new Set(['list']),
}

/** The roles that take `aria-selected` (WAI-ARIA 1.2); anything else that is current says so with `aria-current`. */
const SELECTABLE = new Set<AriaRole>(['tab', 'treeitem', 'option'])

/** The roles that take `aria-expanded`. */
const EXPANDABLE = new Set<AriaRole>(['button', 'tab', 'treeitem', 'application'])

/** The roles that are the live regions of the interface, and how loudly. Anything not here is not live. */
export const LIVE: Partial<Record<AriaRole, 'polite' | 'assertive'>> = {
  status: 'polite',
  alert: 'assertive',
}

/** The roles whose name is their content (they are announced when it changes) rather than a label. */
export const SPEAKS_ITS_NAME = new Set<AriaRole>(['status', 'alert'])

/** The roles a person acts on: a click on one runs the node's first action. */
export const ACTIVATABLE = new Set<AriaRole>([
  'button',
  'tab',
  'treeitem',
  'option',
  'listitem',
])

/**
 * An element id for a node. Node ids are the panels' own words (`f:docs/a b.txt`, `row-3`) and may
 * hold anything a file can be named. Every character outside `[A-Za-z0-9-]` becomes `_` and its code
 * point in hex and `_` again, so the encoding is one-to-one (two ids never share an element id), has
 * no space (ids are space-separated lists in `aria-activedescendant` and `aria-describedby`), and
 * cannot close an attribute or open a tag. `prefix` is the overlay's own, so two overlays on a page
 * do not collide.
 */
export function elementId(prefix: string, id: NodeId): string {
  let out = ''
  for (const char of id)
    out += /[A-Za-z0-9-]/.test(char) ? char : `_${char.codePointAt(0)!.toString(16)}_`
  return `${prefix}-${out}`
}

/** The id of the element that carries a node's description. */
export const descriptionId = (elementIdOf: string) => `${elementIdOf}--d`

/** One element of the overlay: a node by id, the ARIA role it is written as, and the elements inside it. */
export interface Placed {
  id: NodeId
  role: AriaRole
  children: Placed[]
}

/**
 * Lays the tree out as the elements the overlay renders, in reading order, so that ARIA's own rules
 * hold for what assistive technology is given:
 *
 * - An element that may own only some roles (a tablist owns tabs; a tree, treeitems; a listbox,
 *   options; a list, listitems) is given only those. A child of another kind (the picker's heading,
 *   filter and Back, or a tree's loading line and rename field) is placed beside it instead, in the
 *   element's parent, before it when it came before the first owned child and after it otherwise.
 *   Every element is positioned over its own cells, so where it sits in the markup does not move it.
 * - An element that must sit under a role (a tab under a tablist, an option under a listbox) and
 *   does not is written as a `group`, so it is still named and still there but claims no context.
 *
 * Every node appears once and a node in no list (a cycle, an orphan) does not appear.
 */
export function arrange(tree: Tree): Placed | undefined {
  if (!tree.nodes.has(tree.root)) return undefined
  const seen = new Set<NodeId>()
  const place = (
    id: NodeId,
    context: AriaRole | undefined,
  ): { before: Placed[]; self: Placed; after: Placed[] } | undefined => {
    const node = tree.nodes.get(id)
    if (!node || seen.has(id)) return undefined
    seen.add(id)
    let role = ARIA_ROLE[node.role]
    const needs = SITS_UNDER[role]
    if (needs && !(context && needs.has(context))) role = 'group'
    const self: Placed = { id, role, children: [] }
    const owns = OWNS[role]
    const before: Placed[] = []
    const after: Placed[] = []
    let owned = false
    for (const child of node.children) {
      // A group between a container and its rows does not end the container's context.
      const placed = place(child, role === 'group' ? context : role)
      if (!placed) continue
      if (!owns || owns.has(placed.self.role)) {
        owned = true
        self.children.push(...placed.before, placed.self, ...placed.after)
      } else (owned ? after : before).push(placed.self, ...placed.before, ...placed.after)
    }
    return { before, self, after }
  }
  const placed = place(tree.root, undefined)
  return placed ? { ...placed.self, children: [...placed.before, ...placed.self.children, ...placed.after] } : undefined
}

/** The attributes of a node's element, other than its position and content. Only what the wire provides is mapped. */
export function ariaAttributes(
  node: Node,
  role: AriaRole,
): Record<string, string | undefined> {
  const { state } = node
  const attributes: Record<string, string | undefined> = { role }
  // The roles that are announced by their content (a notice) carry no label that would be read twice.
  if (!SPEAKS_ITS_NAME.has(role)) attributes['aria-label'] = node.name
  if (role === 'textbox') attributes['aria-multiline'] = 'true'
  if (SELECTABLE.has(role)) attributes['aria-selected'] = String(state.selected)
  else if (state.selected) attributes['aria-current'] = 'true'
  // A control whose every action is unavailable is disabled as far as a person can tell; the reason is in its description.
  const unavailable = ACTIVATABLE.has(role) && node.actions.length > 0 && node.actions.every((action) => !action.enabled)
  if (state.disabled || unavailable) attributes['aria-disabled'] = 'true'
  if (state.busy) attributes['aria-busy'] = 'true'
  if (EXPANDABLE.has(role) && state.expanded !== null)
    attributes['aria-expanded'] = String(state.expanded)
  if (node.level !== undefined && (role === 'treeitem' || role === 'heading'))
    attributes['aria-level'] = String(node.level)
  if (node.posInSet !== undefined && node.setSize !== undefined) {
    attributes['aria-posinset'] = String(node.posInSet)
    attributes['aria-setsize'] = String(node.setSize)
  }
  if (node.shortcut) attributes['aria-keyshortcuts'] = keyShortcuts(node.shortcut)
  const live = LIVE[role]
  if (live) attributes['aria-live'] = live
  // A log that carries a terminal's screen is read on request, never announced as it changes.
  else if (role === 'log') attributes['aria-live'] = 'off'
  return attributes
}

const MODIFIERS: Record<string, string> = {
  cmd: 'Meta',
  command: 'Meta',
  meta: 'Meta',
  super: 'Meta',
  ctrl: 'Control',
  control: 'Control',
  alt: 'Alt',
  opt: 'Alt',
  option: 'Alt',
  shift: 'Shift',
}

/** The modifier marks a Mac reads a chord with, as the core writes them (`\u2325\u2318G`). */
const GLYPHS: Record<string, string> = {
  '\u2318': 'Meta',
  '\u2325': 'Alt',
  '\u2303': 'Control',
  '\u21e7': 'Shift',
}

/**
 * `aria-keyshortcuts` syntax for a chord as people read it ("\u2325\u2318G", "Ctrl+Alt+T", "Enter"):
 * modifiers by their KeyboardEvent names, then the key, joined with `+`. A chord this cannot read is
 * passed on as it is, which is still read to the person as text.
 */
export function keyShortcuts(chord: string): string {
  const out: string[] = []
  let rest = chord.trim()
  while (rest && GLYPHS[rest[0]!]) {
    out.push(GLYPHS[rest[0]!]!)
    rest = rest.slice(1)
  }
  for (const part of rest.split('+')) {
    const key = part.trim()
    if (!key) continue
    out.push(MODIFIERS[key.toLowerCase()] ?? (key.length === 1 ? key.toUpperCase() : key))
  }
  return out.join('+')
}

/**
 * The words an action is named with: the title the core read from the registry ("Focus Files"), or,
 * for an id nothing can name, its id's words: `tab.close.p1` on panel `p1` reads "tab close".
 */
export function actionName(action: string | { id: NodeAction['id']; title?: NodeAction['title'] }, panel?: string): string {
  if (typeof action !== 'string') return action.title?.trim() || actionName(action.id, panel)
  const base = panel && action.endsWith(`.${panel}`) ? action.slice(0, -panel.length - 1) : action
  return base.replace(/[._-]+/g, ' ').trim()
}

/**
 * What a node says beyond its name: its own description, why its first action is unavailable, and the
 * actions it offers that a click does not run (the first runs on activation). One string, read as the
 * node's description (`aria-describedby`): child buttons would not be reachable, since a tab, a tree
 * item and an option present their children as plain text, and `aria-actions` is not yet implemented by
 * a screen reader.
 */
export function describe(node: Node, panel?: string): string | undefined {
  const parts: string[] = []
  const description = node.state.description ?? undefined
  if (description) parts.push(description)
  const [first, ...rest] = node.actions
  if (first && !first.enabled && first.reason && first.reason !== description)
    parts.push(`Unavailable: ${first.reason}`)
  if (rest.length) {
    const names = rest.map((action) => {
      const name = actionName(action, panel)
      if (action.enabled) return name
      return action.reason ? `${name} (unavailable: ${action.reason})` : `${name} (unavailable)`
    })
    parts.push(`Other actions: ${names.join('; ')}`)
  }
  return parts.length ? parts.join('. ') : undefined
}

/**
 * The panel instance a node belongs to: the `body:<panel>` tab panel above it, which is how the core
 * names the body of each panel it shows. `undefined` for the dock's own nodes.
 */
export function panelOf(
  parent: (id: NodeId) => NodeId | undefined,
  id: NodeId,
): string | undefined {
  for (let at: NodeId | undefined = id, hops = 0; at && hops < 64; at = parent(at), hops += 1)
    if (at.startsWith('body:')) return at.slice('body:'.length)
  return undefined
}

/**
 * `next` with every part that is the same as in `previous` (same node, same role, same elements
 * inside) being `previous`'s own object, so a part that did not change is the same object and the
 * renderer skips it.
 */
export function share(previous: Placed | undefined, next: Placed): Placed {
  if (!previous || previous.id !== next.id || previous.role !== next.role) return next
  const children = next.children.map((child, at) => {
    const old = previous.children[at]
    return old ? share(old, child) : child
  })
  const same =
    children.length === previous.children.length &&
    children.every((child, at) => child === previous.children[at])
  return same ? previous : { ...next, children }
}

/** The action a click runs: the node's first. */
export const primaryAction = (node: Node) => node.actions[0]
