// SOURCING: none — bun:test and react-dom/client under act (test/blocks/render) over ./icon-layer, with the real store and a fake handle standing in for the mounted core
import { afterEach, describe, expect, test } from 'bun:test'
import { act } from 'react'
import { useTerminalTheme } from '@/components/terminal/live-terminal-theme'
import { FALLBACK_ROLES } from '@/components/terminal/terminal-roles'
import { IconLayer } from './icon-layer'
import { createIconStore, parseIcons } from './icon-layer/store'
import { cleanup, render } from '../../../test/blocks/render'

afterEach(cleanup)

const icons = (...list: [number, number, string][]) =>
  JSON.stringify(list.map(([x, y, icon]) => ({ x, y, icon })))

describe('the icon store', () => {
  test('parses a frame and drops what is not an icon of the page set', () => {
    expect(
      parseIcons(
        JSON.stringify([
          { x: 1, y: 2, icon: 'folderFile' },
          { x: 1, y: 3, icon: 'noSuchIcon' },
          { x: 1, y: 4, icon: 'toString' },
          { x: -1, y: 4, icon: 'fileText' },
          { x: 1.5, y: 4, icon: 'fileText' },
          { x: 'a', y: 4, icon: 'fileText' },
          null,
          7,
        ]),
      ),
    ).toEqual([{ x: 1, y: 2, icon: 'folderFile' }])
  })

  test("keeps the colour of the glyph an icon stands for, when it is a #rrggbb colour", () => {
    expect(
      parseIcons(
        JSON.stringify([
          { x: 1, y: 2, icon: 'arrowRight', ink: '#82A098' },
          { x: 3, y: 2, icon: 'arrowDown', ink: 'red' },
          { x: 5, y: 2, icon: 'arrowDown', ink: null },
        ]),
      ),
    ).toEqual([
      { x: 1, y: 2, icon: 'arrowRight', ink: '#82A098' },
      { x: 3, y: 2, icon: 'arrowDown' },
      { x: 5, y: 2, icon: 'arrowDown' },
    ])
  })

  test('JSON that is not a list is no icons', () => {
    expect(parseIcons('not json')).toEqual([])
    expect(parseIcons('{"x":1}')).toEqual([])
    expect(parseIcons('null')).toEqual([])
  })

  test('holds one array until the frame changes, and says when it did', () => {
    const store = createIconStore()
    let heard = 0
    const stop = store.subscribe(() => heard++)
    const first = store.getSnapshot()
    expect(first).toEqual([])
    expect(store.set(icons([1, 1, 'fileText']))).toBe(true)
    const second = store.getSnapshot()
    expect(second).toEqual([{ x: 1, y: 1, icon: 'fileText' }])
    expect(store.set(icons([1, 1, 'fileText']))).toBe(false)
    expect(store.getSnapshot()).toBe(second)
    expect(heard).toBe(1)
    expect(store.set(icons([1, 1, 'folderEmpty']))).toBe(true)
    expect(store.getSnapshot()).not.toBe(second)
    expect(heard).toBe(2)
    stop()
    store.set('[]')
    expect(heard).toBe(2)
  })
})

describe('the icon layer', () => {
  const handle = { cell_size: () => JSON.stringify({ width: 8, height: 16 }) }
  const layer = () => document.querySelector('[data-icon-layer]') as HTMLElement
  const slot = (x: number, y: number) =>
    document.querySelector(
      `[data-cell-x="${x}"][data-cell-y="${y}"]`,
    ) as HTMLElement

  test('draws one inert, hidden element per icon at its cell, 2 cells wide by 1 high', async () => {
    const store = createIconStore()
    store.set(icons([3, 5, 'folderFile'], [5, 6, 'fileCode']))
    await render(<IconLayer store={store} handle={handle} />)
    expect(layer().getAttribute('aria-hidden')).toBe('true')
    expect(layer().style.pointerEvents).toBe('none')
    expect(layer().style.getPropertyValue('--wb-cell-w')).toBe('8px')
    expect(layer().style.getPropertyValue('--wb-cell-h')).toBe('16px')
    // The mark is the largest square in two cells by one: min(2 x 8, 16).
    expect(layer().style.getPropertyValue('--wb-icon')).toBe('16px')
    const folder = slot(3, 5)
    expect(folder.dataset.icon).toBe('folderFile')
    expect(folder.getAttribute('aria-hidden')).toBe('true')
    expect(folder.style.left).toBe('calc(var(--wb-cell-w) * 3)')
    expect(folder.style.top).toBe('calc(var(--wb-cell-h) * 5)')
    expect(folder.style.width).toBe('calc(var(--wb-cell-w) * 2)')
    expect(folder.style.height).toBe('var(--wb-cell-h)')
    expect(folder.style.pointerEvents).toBe('none')
    expect(slot(5, 6).dataset.icon).toBe('fileCode')
    expect(document.querySelectorAll('[data-icon]').length).toBe(2)
  })

  test('paints each icon with the rail mark masks, one per layer of the owner source', async () => {
    const store = createIconStore()
    store.set(icons([1, 1, 'folderEmpty']))
    await render(<IconLayer store={store} handle={handle} />)
    const mark = slot(1, 1).querySelector('.rail-mark') as HTMLElement
    expect(mark).not.toBeNull()
    expect(mark.querySelectorAll('.icon-mask').length).toBeGreaterThan(1)
  })

  test("paints an icon that stands for a glyph in the glyph's colour, and the rest in the layer's", async () => {
    const store = createIconStore()
    store.set(
      JSON.stringify([
        { x: 1, y: 1, icon: 'arrowRight', ink: '#82a098' },
        { x: 4, y: 1, icon: 'fileText' },
      ]),
    )
    await render(<IconLayer store={store} handle={handle} />)
    expect(['#82a098', 'rgb(130, 160, 152)']).toContain(slot(1, 1).style.color)
    expect(slot(1, 1).querySelector('.rail-mark')).not.toBeNull()
    expect(slot(4, 1).style.color).toBe('')
  })

  test("sizes an arrow to the text glyph it stands for and every other mark to the slot", async () => {
    const store = createIconStore()
    store.set(icons([1, 1, 'arrowRight'], [4, 1, 'arrowDown'], [7, 1, 'fileText']))
    await render(<IconLayer store={store} handle={handle} />)
    const size = (x: number) => (slot(x, 1).querySelector('.rail-mark') as HTMLElement).style
    for (const x of [1, 4]) expect([size(x).width, size(x).height]).toEqual(['0.72em', '0.72em'])
    expect([size(7).width, size(7).height]).toEqual(['var(--wb-icon)', 'var(--wb-icon)'])
  })

  test('follows the frame: a new list moves, adds and removes elements', async () => {
    const store = createIconStore()
    store.set(icons([1, 1, 'folderEmpty']))
    await render(<IconLayer store={store} handle={handle} />)
    await act(
      async () =>
        void store.set(icons([1, 1, 'folderFile'], [3, 2, 'fileText'])),
    )
    expect(slot(1, 1).dataset.icon).toBe('folderFile')
    expect(slot(3, 2).dataset.icon).toBe('fileText')
    await act(async () => void store.set('[]'))
    expect(document.querySelectorAll('[data-icon]').length).toBe(0)
  })

  test("takes the terminal's own ink, ground and accent, not the app's", async () => {
    const before = useTerminalTheme.getState()
    const store = createIconStore()
    await render(<IconLayer store={store} handle={handle} />)
    await act(async () =>
      useTerminalTheme.setState({
        roles: {
          ...FALLBACK_ROLES,
          chrome: {
            ...FALLBACK_ROLES.chrome,
            text: '#112233',
            bg: '#445566',
            accent: '#778899',
            mark: '#ff00ff',
          },
        },
      }),
    )
    try {
      const style = layer().style
      expect(style.getPropertyValue('--ink')).toBe('#112233')
      expect(style.getPropertyValue('--rail-ground')).toBe('#445566')
      expect(style.getPropertyValue('--redwood')).toBe('#778899')
      // A mark at rest is drawn in greys mixed from currentColor (styles.css, .rail-mark); with
      // the app's text colour, a light app's dark ink would vanish on a dark terminal.
      expect(['#112233', 'rgb(17, 34, 51)']).toContain(style.color)
    } finally {
      await act(async () => useTerminalTheme.setState(before))
    }
  })
})
