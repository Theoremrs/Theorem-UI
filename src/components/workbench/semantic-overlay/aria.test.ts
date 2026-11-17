// SOURCING: none — bun:test over ./aria with the recorded feed and hand-made trees; the Role union and Rust's Role::aria are read from their files so a role added in Rust fails here until it is mapped
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Node, Role } from '@/lib/workbench/wire'
import {
  ARIA_ROLE,
  actionName,
  arrange,
  ariaAttributes,
  describe as describeNode,
  elementId,
  keyShortcuts,
  panelOf,
  share,
} from './aria'
import type { AriaRole, Placed } from './aria'
import fixture from './feed.fixture.json'
import { parseUpdate, reduce, treeOf } from './tree'
import type { Tree } from './tree'

const ROOT = join(import.meta.dir, '../../../..')

function node(id: string, children: string[] = [], over: Partial<Node> = {}): Node {
  return {
    id,
    role: 'group',
    name: id,
    state: {
      focused: false,
      selected: false,
      disabled: false,
      busy: false,
      expanded: null,
      description: null,
      symlink: false,
      ignored: false,
      hidden: false,
      modified: false,
    },
    rect: { x: 0, y: 0, width: 4, height: 1 },
    actions: [],
    binding: { type: 'none' },
    children,
    ...over,
  }
}
const treeOfNodes = (...nodes: Node[]): Tree => treeOf({ root: nodes[0]!.id, nodes })

const wireRoles = [...readFileSync(join(ROOT, 'src/lib/workbench/wire/Role.ts'), 'utf8').matchAll(/"([A-Za-z]+)"/g)].map(
  (m) => m[1]!,
) as Role[]

describe('the role map', () => {
  test('maps every role in the wire union, and the union is read from the generated file', () => {
    expect(wireRoles.length).toBeGreaterThanOrEqual(22)
    for (const role of wireRoles) expect(ARIA_ROLE[role]).toBeString()
    expect(Object.keys(ARIA_ROLE).sort()).toEqual([...wireRoles].sort())
  })

  test('agrees with Rust Role::aria for every role but the two written differently on purpose', () => {
    const source = readFileSync(
      join(ROOT, 'terminal/crates/workbench-core/src/semantics.rs'),
      'utf8',
    )
    const rust = new Map<string, string>()
    for (const m of source.matchAll(/Self::([A-Za-z]+) => "([a-z]+)"/g))
      rust.set(m[1]![0]!.toLowerCase() + m[1]!.slice(1), m[2]!)
    // A role Rust gives an ARIA name has one here; a role added there and not here fails this test.
    expect([...rust.keys()].sort()).toEqual([...wireRoles].sort())
    const differs = wireRoles.filter((role) => ARIA_ROLE[role] !== rust.get(role))
    expect(differs.sort()).toEqual(['menu', 'menuItem'])
    expect(ARIA_ROLE.menu).toBe('listbox')
    expect(ARIA_ROLE.menuItem).toBe('option')
  })
})

describe('attributes by role and state', () => {
  const state = (over: Partial<Node['state']>) => ({ ...node('x').state, ...over })

  test('names every element by label, but a live region by its content', () => {
    expect(ariaAttributes(node('t', [], { name: 'Files' }), 'tab')['aria-label']).toBe('Files')
    expect(ariaAttributes(node('n', [], { name: 'Saved' }), 'status')['aria-label']).toBeUndefined()
    expect(ariaAttributes(node('n', [], { name: 'Boom' }), 'alert')['aria-label']).toBeUndefined()
  })

  test('selected is aria-selected where the role takes it and aria-current where it does not', () => {
    const selected = state({ selected: true })
    for (const role of ['tab', 'treeitem', 'option'] as AriaRole[])
      expect(ariaAttributes(node('x', [], { state: selected }), role)).toMatchObject({ 'aria-selected': 'true' })
    expect(ariaAttributes(node('x', [], { state: state({}) }), 'tab')['aria-selected']).toBe('false')
    for (const role of ['button', 'group', 'listitem'] as AriaRole[]) {
      const a = ariaAttributes(node('x', [], { state: selected }), role)
      expect(a['aria-current']).toBe('true')
      expect(a['aria-selected']).toBeUndefined()
    }
  })

  test('disabled, busy and expanded map; expanded only where the role takes it and only when there is one', () => {
    const a = ariaAttributes(node('x', [], { state: state({ disabled: true, busy: true, expanded: false }) }), 'treeitem')
    expect(a).toMatchObject({ 'aria-disabled': 'true', 'aria-busy': 'true', 'aria-expanded': 'false' })
    expect(ariaAttributes(node('x', [], { state: state({ expanded: true }) }), 'treeitem')['aria-expanded']).toBe('true')
    expect(ariaAttributes(node('x', [], { state: state({ expanded: null }) }), 'treeitem')['aria-expanded']).toBeUndefined()
    expect(ariaAttributes(node('x', [], { state: state({ expanded: true }) }), 'tabpanel')['aria-expanded']).toBeUndefined()
    expect(ariaAttributes(node('x'), 'button')['aria-disabled']).toBeUndefined()
  })

  test('a button whose every action is unavailable is aria-disabled; one with a live action is not', () => {
    const action = (enabled: boolean) => ({ id: 'a', enabled, reason: enabled ? null : 'Not now.' })
    expect(ariaAttributes(node('x', [], { actions: [action(false)] } as Partial<Node>), 'button')['aria-disabled']).toBe('true')
    expect(ariaAttributes(node('x', [], { actions: [action(false), action(true)] } as Partial<Node>), 'button')['aria-disabled']).toBeUndefined()
    expect(ariaAttributes(node('x', [], { actions: [action(false)] } as Partial<Node>), 'group')['aria-disabled']).toBeUndefined()
  })

  test('level, position and set size, keyshortcuts and the text box’s multiline', () => {
    const a = ariaAttributes(
      node('x', [], { level: 2, posInSet: 3, setSize: 9, shortcut: '\u2325\u2318G' }),
      'treeitem',
    )
    expect(a).toMatchObject({
      'aria-level': '2',
      'aria-posinset': '3',
      'aria-setsize': '9',
      'aria-keyshortcuts': 'Alt+Meta+G',
    })
    expect(ariaAttributes(node('x', [], { level: 2 }), 'group')['aria-level']).toBeUndefined()
    expect(ariaAttributes(node('x', [], { posInSet: 1 }), 'option')['aria-posinset']).toBeUndefined()
    expect(ariaAttributes(node('x'), 'textbox')['aria-multiline']).toBe('true')
  })

  test('a notice is polite, an alert assertive, and a terminal screen is a log that is never announced', () => {
    expect(ariaAttributes(node('x'), 'status')['aria-live']).toBe('polite')
    expect(ariaAttributes(node('x'), 'alert')['aria-live']).toBe('assertive')
    expect(ariaAttributes(node('x'), 'log')['aria-live']).toBe('off')
    expect(ariaAttributes(node('x'), 'button')['aria-live']).toBeUndefined()
  })

  test('chords are written the way aria-keyshortcuts reads them', () => {
    expect(keyShortcuts('\u2325\u2318G')).toBe('Alt+Meta+G')
    expect(keyShortcuts('\u2303\u21e7P')).toBe('Control+Shift+P')
    expect(keyShortcuts('Ctrl+Alt+t')).toBe('Control+Alt+T')
    expect(keyShortcuts('Cmd+Shift+G')).toBe('Meta+Shift+G')
    expect(keyShortcuts('Enter')).toBe('Enter')
  })
})

describe('element ids', () => {
  test('are one-to-one, hold no space, quote or markup, and carry the overlay prefix', () => {
    const hostile = [
      'f:docs/a b.txt',
      'f:docs/a_20_b.txt',
      '"><img src=x onerror=alert(1)>',
      "a' onfocus='x",
      'a\nb',
      'a\u0000b',
      '\u{1f600}',
      'f:\u00e9',
      'f:e\u0301',
      '..//..',
      '',
      '-',
      '_',
      '__',
      'a_5f_',
    ]
    const ids = hostile.map((id) => elementId('wbo1', id))
    expect(new Set(ids).size).toBe(hostile.length)
    for (const id of ids) {
      expect(id).toMatch(/^wbo1-[A-Za-z0-9_-]*$/)
      expect(id).not.toMatch(/[\s"'<>&]/)
    }
    expect(elementId('wbo1', 'a')).not.toBe(elementId('wbo2', 'a'))
  })
})

describe('required owned elements and context', () => {
  /** What ARIA 1.2 requires, checked on an arranged tree. */
  const owns: Partial<Record<AriaRole, AriaRole[]>> = {
    tablist: ['tab'],
    tree: ['treeitem', 'group'],
    listbox: ['option', 'group'],
    list: ['listitem'],
  }
  const under: Partial<Record<AriaRole, AriaRole>> = {
    tab: 'tablist',
    treeitem: 'tree',
    option: 'listbox',
    listitem: 'list',
  }
  /** `container` is the nearest ancestor that is not a plain group: the context a row has through groups. */
  function check(placed: Placed, container?: AriaRole) {
    const allowedChildren = owns[placed.role]
    const needs = under[placed.role]
    if (needs) expect(container).toBe(needs)
    for (const child of placed.children) {
      if (allowedChildren) expect(allowedChildren).toContain(child.role)
      check(child, placed.role === 'group' ? container : placed.role)
    }
  }
  const ids = (placed: Placed): string[] => [placed.id, ...placed.children.flatMap(ids)]

  test('hold for every tree the core published, each node once', () => {
    let held: Tree | undefined
    for (const json of fixture.updates) {
      held = reduce(held, parseUpdate(json)!)!
      const placed = arrange(held)!
      check(placed)
      const all = ids(placed)
      expect(new Set(all).size).toBe(all.length)
      expect(all.sort()).toEqual([...held.nodes.keys()].sort())
    }
  })

  test('the picker’s heading and filter sit beside its listbox, before the options, and the options are its own', () => {
    let held: Tree | undefined
    for (const json of fixture.updates) held = reduce(held, parseUpdate(json)!)
    const panel = (function find(p: Placed): Placed | undefined {
      return p.id === 'body:p2' ? p : p.children.map(find).find(Boolean)
    })(arrange(held!)!)!
    expect(panel.children.map((c) => `${c.role}:${c.id}`)).toEqual([
      'heading:p2/heading',
      'textbox:p2/filter',
      'listbox:p2/picker',
    ])
    const listbox = panel.children[2]!
    expect(listbox.children.map((c) => c.role)).toEqual(['option'])
  })

  test('a tree’s loading line, confirmation and rename field are placed after its rows, a heading before', () => {
    const t = treeOfNodes(
      node('r', ['tree']),
      node('tree', ['lead', 'a', 'load', 'edit'], { role: 'tree' }),
      node('lead', [], { role: 'heading' }),
      node('a', [], { role: 'treeItem' }),
      node('load', [], { role: 'status' }),
      node('edit', [], { role: 'textBox' }),
    )
    const placed = arrange(t)!
    expect(placed.children.map((c) => c.id)).toEqual(['lead', 'tree', 'load', 'edit'])
    expect(placed.children[1]!.children.map((c) => c.id)).toEqual(['a'])
  })

  test('a tab with no tablist and an option with no listbox are written as groups, still named', () => {
    const t = treeOfNodes(
      node('r', ['tab', 'opt', 'item']),
      node('tab', [], { role: 'tab' }),
      node('opt', [], { role: 'menuItem' }),
      node('item', [], { role: 'listItem' }),
    )
    expect(arrange(t)!.children.map((c) => c.role)).toEqual(['group', 'group', 'group'])
  })

  test('a node listed under two parents, or in a cycle, is placed once and cannot loop', () => {
    const t = treeOfNodes(node('r', ['a', 'b']), node('a', ['c', 'r']), node('b', ['c']), node('c'))
    const all = ids(arrange(t)!)
    expect(all.sort()).toEqual(['a', 'b', 'c', 'r'])
  })

  test('share keeps the object of every part that did not change', () => {
    const t = treeOfNodes(node('r', ['a', 'b']), node('a'), node('b'))
    const first = arrange(t)!
    const again = share(first, arrange(t)!)
    expect(again).toBe(first)
    const t2 = treeOfNodes(node('r', ['a', 'b']), node('a'), node('b', [], { role: 'button' }))
    const changed = share(first, arrange(t2)!)
    expect(changed).not.toBe(first)
    expect(changed.children[0]).toBe(first.children[0])
  })
})

describe('descriptions and actions', () => {
  test('say what a node says beyond its name, why its action is unavailable, and the actions a click does not run', () => {
    const tab = node('tab:p3', [], {
      role: 'tab',
      actions: [
        { id: 'tab.focus.p3', enabled: true },
        { id: 'tab.close.p3', enabled: true },
        { id: 'tab.pin.p3', enabled: false, reason: 'Pinned tabs stay' },
      ],
    })
    expect(describeNode(tab, 'p3')).toBe(
      'Other actions: tab close; tab pin (unavailable: Pinned tabs stay)',
    )
    const row = node('row', [], {
      state: { ...node('x').state, description: 'starts a process' },
      actions: [{ id: 'shell.choose', enabled: false, reason: 'Needs a terminal' }],
    })
    expect(describeNode(row)).toBe('starts a process. Unavailable: Needs a terminal')
    const same = node('row', [], {
      state: { ...node('x').state, description: 'Needs a terminal' },
      actions: [{ id: 'shell.choose', enabled: false, reason: 'Needs a terminal' }],
    })
    expect(describeNode(same)).toBe('Needs a terminal')
    expect(describeNode(node('plain'))).toBeUndefined()
  })

  test('names an action by its title when the core gave one, and trims it', () => {
    expect(actionName({ id: 'tab.focus.p3', title: 'Focus Files' }, 'p3')).toBe('Focus Files')
    expect(actionName({ id: 'tab.close.p3', title: '  ' }, 'p3')).toBe('tab close')
    expect(actionName({ id: 'tab.close.p3' }, 'p3')).toBe('tab close')
  })

  test('names an action from its id, without the panel instance it is aimed at', () => {
    expect(actionName('tab.close.p3', 'p3')).toBe('tab close')
    expect(actionName('approval.allow')).toBe('approval allow')
    expect(actionName('side-chat.choose')).toBe('side chat choose')
  })

  test('the panel of a node is the body above it', () => {
    let held: Tree | undefined
    for (const json of fixture.updates) held = reduce(held, parseUpdate(json)!)
    const parents = new Map<string, string>()
    for (const n of held!.nodes.values()) for (const c of n.children) parents.set(c, n.id)
    expect(panelOf((id) => parents.get(id), 'p2/row-0')).toBe('p2')
    expect(panelOf((id) => parents.get(id), 'tab:p2')).toBeUndefined()
  })
})
