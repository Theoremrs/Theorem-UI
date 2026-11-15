// SOURCING: none — bun:test and react-dom/client under act (test/blocks/render) over ./semantic-overlay, with a fake feed, a fake handle and a plain textarea standing in for the mounted core and its input
import { afterEach, describe, expect, test } from 'bun:test'
import { act } from 'react'
import type { Node, SemanticDiff, SemanticTree } from '@/lib/workbench/wire'
import { SemanticOverlay, activate } from './semantic-overlay'
import type { OverlayHandle } from './semantic-overlay'
import { elementId } from './semantic-overlay/aria'
import fixture from './semantic-overlay/feed.fixture.json'
import { cleanup, render } from '../../../test/blocks/render'
import type { SemanticsFeed, SurfaceParts } from './workbench'
import type { InputMirror } from './semantic-overlay/mirror'

afterEach(cleanup)

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
    rect: { x: 2, y: 3, width: 4, height: 1 },
    actions: [],
    binding: { type: 'none' },
    children,
    ...over,
  }
}
const withState = (n: Node, state: Partial<Node['state']>): Node => ({
  ...n,
  state: { ...n.state, ...state },
})

function fakeFeed() {
  const listeners = new Set<(update: string) => void>()
  const feed: { latest: string | undefined; subscribe: SemanticsFeed['subscribe']; push: (update: string) => void } = {
    latest: undefined as string | undefined,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    push(update) {
      feed.latest = update
      for (const listener of listeners) listener(update)
    },
  }
  return feed
}
const full = (root: string, ...nodes: Node[]) =>
  JSON.stringify({ type: 'full', tree: { root, nodes } satisfies SemanticTree })
const diff = (d: Partial<SemanticDiff>) =>
  JSON.stringify({ type: 'diff', diff: { added: [], changed: [], removed: [], ...d } })

function setup(over: { handle?: Partial<OverlayHandle>; input?: boolean } = {}) {
  const feed = fakeFeed()
  const calls: [string, string | undefined][] = []
  let semantics = ''
  const handle: OverlayHandle = {
    semantics: () => semantics,
    cell_size: () => JSON.stringify({ width: 8, height: 16 }),
    act: (action, panel) => {
      calls.push([action, panel])
      return '{"outcome":"accepted","effects":1,"notices":[]}'
    },
    ...over.handle,
  }
  const field = document.createElement('textarea')
  field.setAttribute('aria-label', 'Workbench input')
  document.body.append(field)
  const mirror: { current: InputMirror | undefined } = { current: undefined }
  const parts = {
    handle: handle as unknown as SurfaceParts['handle'],
    root: null,
    input: field,
    mirror,
  } satisfies SurfaceParts
  return {
    feed,
    calls,
    field,
    mirror,
    setSemantics: (json: string) => (semantics = json),
    mount: () => render(<SemanticOverlay feed={feed} parts={parts} settleMs={0} />),
    push: (update: string) => act(async () => feed.push(update)),
  }
}

const layer = () => document.querySelector('[data-semantic-overlay]') as HTMLElement
const byNode = (id: string) =>
  [...document.querySelectorAll('[data-node]')].find((el) => el.getAttribute('data-node') === id) as HTMLElement

const tabsTree = full(
  'root',
  node('root', ['tabs'], { role: 'application', name: 'Workbench' }),
  node('tabs', ['tab:a', 'tab:b'], { role: 'tabList', name: 'Main tabs' }),
  withState(
    node('tab:a', [], { role: 'tab', name: 'Alpha', actions: [{ id: 'tab.focus.a', enabled: true }, { id: 'tab.close.a', enabled: true }] }),
    { selected: true, focused: true },
  ),
  node('tab:b', [], { role: 'tab', name: 'Beta', actions: [{ id: 'tab.focus.b', enabled: true }] }),
)

describe('the rendered overlay', () => {
  test('is one element per node, with its role, name, state and the cells it covers, and nothing a pointer can hit or an eye can see', async () => {
    const t = setup()
    await t.mount()
    await t.push(tabsTree)
    expect(document.querySelectorAll('[data-node]').length).toBe(4)
    const tab = byNode('tab:a')
    expect(tab.getAttribute('role')).toBe('tab')
    expect(tab.getAttribute('aria-label')).toBe('Alpha')
    expect(tab.getAttribute('aria-selected')).toBe('true')
    expect(byNode('tab:b').getAttribute('aria-selected')).toBe('false')
    expect(byNode('tabs').getAttribute('role')).toBe('tablist')
    expect(byNode('tabs').contains(tab)).toBe(true)
    // A child sits at its offset from the element it is inside, in cells.
    expect(tab.style.left).toBe('calc(var(--wb-cell-w) * 0)')
    expect(layer().style.pointerEvents).toBe('none')
    expect(layer().style.opacity).toBe('0')
    expect(layer().style.getPropertyValue('--wb-cell-w')).toBe('8px')
    expect(layer().style.getPropertyValue('--wb-cell-h')).toBe('16px')
  })

  test('renders names and text as text, never as markup, with ids that cannot carry any', async () => {
    const t = setup()
    await t.mount()
    const evil = '<img src=x onerror="window.pwned=1"><script>window.pwned=1</script>'
    await t.push(
      full(
        'r',
        node('r', ['a', 'b', 'c']),
        node('a', [], { role: 'button', name: evil, actions: [{ id: 'x', enabled: true }] }),
        node('b', [], { role: 'textBox', name: evil, text: evil, state: { ...node('b').state, description: evil } }),
        node('"><img src=x onerror=1>/f:a b', [], { role: 'status', name: evil }),
      ),
    )
    // c is not in the tree's reach: the node under the hostile id is not a child of r, so it is not drawn at all.
    expect(document.querySelectorAll('img, script').length).toBe(0)
    expect((window as unknown as { pwned?: number }).pwned).toBeUndefined()
    expect(byNode('a').getAttribute('aria-label')).toBe(evil)
    expect(byNode('b').textContent).toContain(evil)
    expect(byNode('b').querySelector('*')).toBeNull()
  })

  test('a node under a hostile id has an element id no other node can share and no attribute can leak through', async () => {
    const t = setup()
    await t.mount()
    const a = 'f:docs/a b"onfocus="x.txt'
    const b = 'f:docs/a_20_b_22_onfocus_3d__22_x.txt'
    await t.push(full('r', node('r', [a, b]), node(a, [], { role: 'treeItem' }), node(b, [], { role: 'treeItem' })))
    const ids = [...document.querySelectorAll('[data-node]')].map((el) => el.id)
    expect(new Set(ids).size).toBe(3)
    for (const id of ids) expect(id).toMatch(/^wbo[A-Za-z0-9-]*-[A-Za-z0-9_-]*$/)
    expect(document.getElementById(byNode(a).id)).toBe(byNode(a))
    expect(byNode(a).hasAttribute('onfocus')).toBe(false)
  })

  test('a diff changes the elements it names and touches no other', async () => {
    const t = setup()
    await t.mount()
    await t.push(tabsTree)
    const touched = new Set<string>()
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        const target = record.target
        const element = target instanceof Element ? target : target.parentElement
        const id = element?.closest('[data-node]')?.getAttribute('data-node')
        if (id) touched.add(id)
      }
    })
    observer.observe(layer(), { subtree: true, attributes: true, childList: true, characterData: true })
    const before = byNode('tab:a')
    await t.push(diff({ changed: [withState(node('tab:b', [], { role: 'tab', name: 'Beta' }), { selected: true })] }))
    await act(async () => {})
    observer.disconnect()
    expect([...touched]).toEqual(['tab:b'])
    expect(byNode('tab:b').getAttribute('aria-selected')).toBe('true')
    expect(byNode('tab:a')).toBe(before)
  })

  test('adds and removes elements as nodes come and go', async () => {
    const t = setup()
    await t.mount()
    await t.push(tabsTree)
    await t.push(
      diff({
        added: [node('tab:c', [], { role: 'tab', name: 'Gamma' })],
        changed: [node('tabs', ['tab:a', 'tab:c'], { role: 'tabList', name: 'Main tabs' })],
        removed: ['tab:b'],
      }),
    )
    expect(byNode('tab:b')).toBeUndefined()
    expect(byNode('tab:c').getAttribute('aria-label')).toBe('Gamma')
    expect([...byNode('tabs').children].map((el) => el.getAttribute('data-node')).filter(Boolean)).toEqual(['tab:a', 'tab:c'])
  })

  test('shows a node’s level, position, shortcut, busy and disabled state, and describes what else it offers', async () => {
    const t = setup()
    await t.mount()
    await t.push(
      full(
        'r',
        node('r', ['tree']),
        node('tree', ['row'], { role: 'tree', name: 'Files' }),
        withState(
          node('row', [], {
            role: 'treeItem',
            name: 'src',
            level: 2,
            posInSet: 3,
            setSize: 9,
            shortcut: '⌥⌘E',
            actions: [
              { id: 'files.open', enabled: true },
              { id: 'files.rename', enabled: false, reason: 'Read-only' },
            ],
          }),
          { expanded: true, busy: true, disabled: true },
        ),
      ),
    )
    const row = byNode('row')
    expect(row.getAttribute('aria-level')).toBe('2')
    expect(row.getAttribute('aria-posinset')).toBe('3')
    expect(row.getAttribute('aria-setsize')).toBe('9')
    expect(row.getAttribute('aria-expanded')).toBe('true')
    expect(row.getAttribute('aria-busy')).toBe('true')
    expect(row.getAttribute('aria-disabled')).toBe('true')
    expect(row.getAttribute('aria-keyshortcuts')).toBe('Alt+Meta+E')
    const description = document.getElementById(row.getAttribute('aria-describedby')!)!
    expect(description.textContent).toBe('Other actions: files rename (unavailable: Read-only)')
  })
})

describe('feed and resync', () => {
  test('a diff that does not fit is answered by the core’s whole tree', async () => {
    const t = setup()
    t.setSemantics(JSON.stringify({ root: 'r', nodes: [node('r', ['z']), node('z', [], { name: 'Truth' })] }))
    await t.mount()
    await t.push(tabsTree)
    await t.push(diff({ changed: [node('nothing-like-it')] }))
    expect(byNode('z').getAttribute('aria-label')).toBe('Truth')
    expect(byNode('tab:a')).toBeUndefined()
  })

  test('an overlay mounted after the first tree starts from the core’s, whatever the last update was', async () => {
    const t = setup()
    t.setSemantics(JSON.stringify({ root: 'r', nodes: [node('r', ['z']), node('z', [], { name: 'Now' })] }))
    t.feed.latest = diff({ changed: [node('z')] })
    await t.mount()
    expect(byNode('z').getAttribute('aria-label')).toBe('Now')
  })

  test('ignores a message that is not the feed’s', async () => {
    const t = setup()
    await t.mount()
    await t.push(tabsTree)
    await t.push('garbage')
    await t.push('{"type":"full"}')
    expect(document.querySelectorAll('[data-node]').length).toBe(4)
  })
})

describe('activation', () => {
  test('a click on a tab runs its first action through act, aimed at its panel', async () => {
    const t = setup()
    await t.mount()
    await t.push(
      full(
        'r',
        node('r', ['body:p9']),
        node('body:p9', ['row'], { role: 'tabPanel' }),
        node('row', [], { role: 'button', name: 'Stop', actions: [{ id: 'theo.stop', enabled: true }, { id: 'theo.other', enabled: true }] }),
      ),
    )
    await act(async () => byNode('row').click())
    expect(t.calls).toEqual([['theo.stop', 'p9']])
  })

  test('a tab’s first action is showing its panel; the core is not given a panel for the dock’s own nodes', async () => {
    const t = setup()
    await t.mount()
    await t.push(tabsTree)
    await act(async () => byNode('tab:b').click())
    expect(t.calls).toEqual([['tab.focus.b', undefined]])
  })

  test('does nothing for an unavailable action, a node with none, or a click on a role nobody acts on', async () => {
    const t = setup()
    await t.mount()
    await t.push(
      full(
        'r',
        node('r', ['a', 'b', 'c']),
        node('a', [], { role: 'button', actions: [{ id: 'x', enabled: false, reason: 'No' }] }),
        node('b', [], { role: 'button' }),
        node('c', [], { role: 'region', actions: [{ id: 'y', enabled: true }] }),
      ),
    )
    for (const id of ['a', 'b', 'c']) await act(async () => byNode(id).click())
    expect(t.calls).toEqual([])
  })

  test('with a core that has no act, everything is still presented and a click does nothing and throws nothing', async () => {
    const t = setup({ handle: { act: undefined } })
    await t.mount()
    await t.push(tabsTree)
    await act(async () => byNode('tab:b').click())
    expect(document.querySelectorAll('[data-node]').length).toBe(4)
  })

  test('activate reports what the core answered, and why it did not ask', () => {
    const tab = node('t', [], { actions: [{ id: 'a', enabled: true }] })
    const refuse = { act: () => '{"outcome":"refused","code":"unavailable","reason":"Not now"}' }
    expect(activate(refuse, tab, undefined)).toEqual({ ran: true, outcome: 'refused', reason: 'Not now' })
    expect(activate({ act: () => 'not json' }, tab, undefined)).toEqual({ ran: false, why: 'no-entry-point' })
    expect(activate({}, tab, undefined)).toEqual({ ran: false, why: 'no-entry-point' })
    expect(activate(undefined, node('n'), undefined)).toEqual({ ran: false, why: 'no-action' })
    expect(activate(refuse, withState(tab, { disabled: true }), undefined)).toEqual({ ran: false, why: 'unavailable' })
  })
})

describe('focus, without moving it', () => {
  test('the input names the focused node and follows it', async () => {
    const t = setup()
    await t.mount()
    await t.push(tabsTree)
    expect(t.field.getAttribute('aria-activedescendant')).toBe(byNode('tab:a').id)
    await t.push(
      diff({
        changed: [
          withState(node('tab:a', [], { role: 'tab', name: 'Alpha' }), { selected: true }),
          withState(node('tab:b', [], { role: 'tab', name: 'Beta' }), { focused: true }),
        ],
      }),
    )
    expect(t.field.getAttribute('aria-activedescendant')).toBe(byNode('tab:b').id)
    expect(t.field.getAttribute('aria-label')).toBe('Workbench input')
  })

  test('the id it names is the id of the element, hostile or not', async () => {
    const t = setup()
    await t.mount()
    const odd = 'tab:"> x y'
    await t.push(full('r', node('r', [odd]), withState(node(odd, [], { role: 'tab' }), { focused: true })))
    expect(document.getElementById(t.field.getAttribute('aria-activedescendant')!)).toBe(byNode(odd))
    expect(t.field.getAttribute('aria-activedescendant')).toBe(elementId(byNode(odd).id.split('-')[0]!, odd))
  })

  const editor = (text: string, anchor: number, focus: number) =>
    withState(
      node('edit', [], { role: 'textBox', name: 'Message', text, selection: { anchor, focus } }),
      { focused: true },
    )

  test('a text field with text and a caret is held by the input: its text, selection and name, and the node’s own element steps aside', async () => {
    const t = setup()
    await t.mount()
    await t.push(full('r', node('r', ['edit']), editor('hello world', 6, 11)))
    expect(t.field.value).toBe('hello world')
    expect([t.field.selectionStart, t.field.selectionEnd]).toEqual([6, 11])
    expect(t.field.getAttribute('aria-label')).toBe('Message')
    expect(t.field.hasAttribute('aria-activedescendant')).toBe(false)
    expect(t.mirror.current).toEqual({ value: 'hello world', start: 6, end: 11, backward: false })
    expect(byNode('edit').getAttribute('aria-hidden')).toBe('true')
    // The core moves the caret and changes the text: the input follows.
    await t.push(diff({ changed: [editor('hello there', 11, 11)] }))
    expect(t.field.value).toBe('hello there')
    expect(t.field.selectionStart).toBe(11)
  })

  test('hands the input back, empty and under its own name, when focus leaves the text field', async () => {
    const t = setup()
    await t.mount()
    await t.push(
      full('r', node('r', ['edit', 'tab']), editor('draft', 5, 5), node('tab', [], { role: 'tab', name: 'T' })),
    )
    expect(t.field.value).toBe('draft')
    await t.push(
      diff({
        changed: [
          withState(editor('draft', 5, 5), { focused: false }),
          withState(node('tab', [], { role: 'tab', name: 'T' }), { focused: true }),
        ],
      }),
    )
    expect(t.field.value).toBe('')
    expect(t.mirror.current).toBeUndefined()
    expect(t.field.getAttribute('aria-label')).toBe('Workbench input')
    expect(t.field.getAttribute('aria-activedescendant')).toBe(byNode('tab').id)
    expect(byNode('edit').hasAttribute('aria-hidden')).toBe(false)
  })

  test('a field with text and no caret, as the composer is published today, is read from its element, not mirrored', async () => {
    const t = setup()
    await t.mount()
    await t.push(
      full('r', node('r', ['edit']), withState(node('edit', [], { role: 'textBox', name: 'Message', text: 'abc' }), { focused: true })),
    )
    expect(t.field.value).toBe('')
    expect(t.field.getAttribute('aria-activedescendant')).toBe(byNode('edit').id)
    expect(byNode('edit').textContent).toBe('abc')
  })

  test('leaves the input alone while an IME composes, and keeps the mirror it will be put back to', async () => {
    const t = setup()
    await t.mount()
    await t.push(full('r', node('r', ['edit']), editor('ab', 2, 2)))
    t.field.dispatchEvent(new Event('compositionstart', { bubbles: true }))
    t.field.value = 'abにほ'
    await t.push(diff({ changed: [editor('abc', 3, 3)] }))
    expect(t.field.value).toBe('abにほ')
    expect(t.mirror.current).toMatchObject({ value: 'abc', start: 3 })
    t.field.dispatchEvent(new Event('compositionend', { bubbles: true }))
    await t.push(diff({ changed: [editor('abcd', 4, 4)] }))
    expect(t.field.value).toBe('abcd')
  })

  test('lets go of the input when it unmounts', async () => {
    const t = setup()
    const view = await t.mount()
    await t.push(full('r', node('r', ['edit']), editor('hello', 5, 5)))
    await view.unmount()
    expect(t.mirror.current).toBeUndefined()
    expect(t.field.hasAttribute('aria-activedescendant')).toBe(false)
    expect(t.field.getAttribute('aria-label')).toBe('Workbench input')
  })
})

describe('what is announced', () => {
  test('a notice is a live region that exists before its words are put in it, and says them once', async () => {
    const t = setup()
    await t.mount()
    const base = node('r', ['n'])
    await t.push(full('r', base, node('n', [], { role: 'status', name: 'Saved' })))
    const region = byNode('n')
    expect(region.getAttribute('role')).toBe('status')
    expect(region.getAttribute('aria-live')).toBe('polite')
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    expect(region.textContent).toBe('Saved')
    // Diffs that change other things leave its words, and its element, alone.
    const mutations: string[] = []
    const observer = new MutationObserver((records) => records.forEach((r) => mutations.push(r.type)))
    observer.observe(region, { subtree: true, childList: true, characterData: true })
    await t.push(diff({ changed: [node('r', ['n'], { name: 'renamed' })] }))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    observer.disconnect()
    expect(mutations).toEqual([])
    expect(byNode('n')).toBe(region)
  })

  test('an alert is assertive, and a terminal’s screen is a log that is not live', async () => {
    const t = setup()
    await t.mount()
    await t.push(
      full(
        'r',
        node('r', ['a', 'l']),
        node('a', [], { role: 'alert', name: 'Lost the session' }),
        node('l', [], { role: 'log', name: 'Output', text: '$ ls\nfile' }),
      ),
    )
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    expect(byNode('a').getAttribute('aria-live')).toBe('assertive')
    expect(byNode('a').textContent).toBe('Lost the session')
    expect(byNode('l').getAttribute('aria-live')).toBe('off')
    expect(byNode('l').textContent).toBe('$ ls\nfile')
  })

  test('streamed screen text replaces the log’s text and touches nothing else', async () => {
    const t = setup()
    await t.mount()
    await t.push(full('r', node('r', ['l', 'b']), node('l', [], { role: 'log', text: 'one' }), node('b', [], { role: 'button' })))
    const button = byNode('b')
    await t.push(diff({ changed: [node('l', [], { role: 'log', text: 'one\ntwo' })] }))
    expect(byNode('l').textContent).toBe('one\ntwo')
    expect(byNode('b')).toBe(button)
  })
})

test('the fixture of the real feed renders every node once', async () => {
  const t = setup()
  await t.mount()
  let count = 0
  for (const update of fixture.updates) {
    await t.push(update)
    const parsed = JSON.parse(update) as { type: string; tree?: SemanticTree; diff?: SemanticDiff }
    if (parsed.tree) count = parsed.tree.nodes.length
    if (parsed.diff) count += parsed.diff.added.length - parsed.diff.removed.length
    expect(document.querySelectorAll('[data-node]').length).toBe(count)
  }
  const ids = [...document.querySelectorAll('[id]')].map((el) => el.id)
  expect(new Set(ids).size).toBe(ids.length)
  // Every id an aria-describedby or the input's active descendant names is an element that is there.
  for (const el of document.querySelectorAll('[aria-describedby]'))
    expect(document.getElementById(el.getAttribute('aria-describedby')!)).not.toBeNull()
})
