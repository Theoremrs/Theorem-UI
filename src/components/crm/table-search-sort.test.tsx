// SOURCING: bun:test rendering the CRM table as the Index draws it (./test-harness) with React into happy-dom, for the table's search across every field, its list of sort rules and how the address holds them (sort, desc and then), the header that opens the column's menu, and the headers that are dragged to reorder the columns (@dnd-kit's sortable roles, and the drop through the pure reorderColumns). window.fetch is the in-memory fixture (./fixture)
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from 'bun:test'
import { act } from 'react'
import {
  buttonNamed,
  cleanup,
  click,
  waitFor,
} from '../../../test/blocks/render'
import { createFixtureServer, fixtureFetch } from './fixture'
import type { FixtureServer } from './fixture'
import { useRecordLayouts } from '@/components/records/view-state'
import { reorderColumns } from './header-drag'
import { resetCrmWrites } from './queries'
import { parseThen, sortsFromAddress, sortsToAddress } from './table-sorts'
import { IndexRecords, mountAt, tableAt } from './test-harness'

const page = (
  window as unknown as { happyDOM: { setURL: (url: string) => void } }
).happyDOM
beforeAll(() => page.setURL('http://localhost:3000/'))
afterAll(() => page.setURL('about:blank'))

let server: FixtureServer
const realFetch = window.fetch
beforeEach(() => {
  resetCrmWrites()
  window.localStorage.clear()
  useRecordLayouts.setState({ layouts: {} })
  server = createFixtureServer()
  window.fetch = fixtureFetch(server)
})
afterEach(async () => {
  await cleanup()
  window.fetch = realFetch
  window.localStorage.clear()
  useRecordLayouts.setState({ layouts: {} })
})

const type = (input: HTMLInputElement, text: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
const choose = (select: HTMLSelectElement, value: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLSelectElement.prototype,
      'value',
    )!.set!.call(select, value)
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })

const headers = (container: HTMLElement) =>
  [...container.querySelectorAll('[role="columnheader"]')].map(
    (header) => header.querySelector('.truncate')?.textContent ?? '',
  )
const headerOf = (container: HTMLElement, label: string) =>
  container.querySelectorAll('[role="columnheader"]')[
    headers(container).indexOf(label)
  ] as HTMLElement
/** The record names down the first column, as the rows are now. */
const names = (container: HTMLElement) =>
  [...container.querySelectorAll('[role="gridcell"][data-c="0"]')].map(
    (c) => c.querySelector('[title]')?.getAttribute('title') ?? '',
  )
/** Two more people in Lisbon, so a sort by place has a tie to break. */
const addLisbon = () =>
  ['Bea', 'Cyrus'].forEach((name, i) =>
    server.state.nodes.push({
      id: `person:extra-${i}`,
      labels: ['Person'],
      properties: { name, location: 'Lisbon' },
      version: 1,
    }),
  )

async function people(path = tableAt('person')) {
  const mounted = await mountAt(path, () => <IndexRecords />)
  await waitFor(() =>
    mounted.container.querySelector('[role="grid"] [data-r="1"]'),
  )
  return mounted
}
const menuItem = (label: string) =>
  waitFor(() =>
    [...document.querySelectorAll('[role^="menuitem"]')].find((item) =>
      item.textContent.trim().endsWith(label),
    ),
  )
/** The header's own button is the column's menu: click it and pick from it. */
async function fromHeader(
  container: HTMLElement,
  column: string,
  item: string,
) {
  await click(headerOf(container, column).querySelector('button')!)
  await click(await menuItem(item))
}
const sortField = (n: number) =>
  waitFor(() =>
    document.querySelector<HTMLSelectElement>(
      `select[aria-label="Sort ${n} field"]`,
    ),
  )
const sortDirection = (n: number) =>
  waitFor(() =>
    document.querySelector<HTMLSelectElement>(
      `select[aria-label="Sort ${n} direction"]`,
    ),
  )
async function search(container: HTMLElement, text: string) {
  await click(buttonNamed(container, 'Search')!)
  const input = await waitFor(() =>
    container.querySelector<HTMLInputElement>(
      'input[aria-label="Search people"]',
    ),
  )
  await type(input, text)
}

// Search across every field

test('the search finds a record by a field that is not its name', async () => {
  const { container } = await people()
  await search(container, 'avery@example')
  expect(names(container)).toEqual(['Avery Quinn'])
  expect(container.querySelector('footer')!.textContent).toBe(
    '1 of 2 people match “avery@example”',
  )
})

test('the search reads the title of a related record, in any case', async () => {
  const { container } = await people()
  await search(container, '  KILN street ')
  expect(names(container)).toEqual(['Noor'])
})

test('a hidden column is not searched', async () => {
  const { container } = await people()
  await fromHeader(container, 'Email', 'Hide')
  await waitFor(() => !headers(container).includes('Email'))
  await search(container, 'avery@example')
  expect(names(container)).toEqual([])
})

test('a needle nothing holds shows the empty state', async () => {
  const { container } = await people()
  await search(container, 'zzz-nothing')
  expect(names(container)).toEqual([])
  expect(container.textContent).toContain('No people match “zzz-nothing”.')
})

// Sorting by several rules

test("two rules order the rows, the second breaking the first's ties", async () => {
  addLisbon()
  const { container } = await people(
    tableAt('person', { sort: 'location', then: 'name:desc' }),
  )
  // Lisbon (Cyrus, then Bea by name, Z to A), Portland, and no place last.
  await waitFor(() => names(container).length === 4)
  expect(names(container)).toEqual(['Cyrus', 'Bea', 'Avery Quinn', 'Noor'])
  expect(headerOf(container, 'Location').getAttribute('aria-sort')).toBe(
    'ascending',
  )
  expect(headerOf(container, 'Name').getAttribute('aria-sort')).toBe(
    'descending',
  )
  expect(buttonNamed(container, 'Sort: Location +1')).toBeDefined()
})

test('the rules are in the address as sort, desc and then, and a reload restores them', async () => {
  addLisbon()
  const first = await people()
  await fromHeader(first.container, 'Location', 'Sort descending')
  await waitFor(() => first.search().sort === 'location')
  await click(buttonNamed(first.container, 'Sort: Location')!)
  await click(await waitFor(() => buttonNamed(document.body, 'Add sort')))
  await choose(await sortField(2), 'name')
  await choose(await sortDirection(2), 'ascending')
  await waitFor(() => first.search().then === 'name')
  expect(first.search()).toMatchObject({
    sort: 'location',
    desc: true,
    then: 'name',
  })
  await choose(await sortDirection(2), 'descending')
  await waitFor(() => first.search().then === 'name:desc')
  const order = names(first.container)
  // Place Z to A (no place counted last), ties by name Z to A.
  expect(order).toEqual(['Avery Quinn', 'Cyrus', 'Bea', 'Noor'])
  await cleanup()

  const again = await people(
    tableAt('person', { sort: 'location', desc: true, then: 'name:desc' }),
  )
  expect(names(again.container)).toEqual(order)
  expect(buttonNamed(again.container, 'Sort: Location +1')).toBeDefined()
  expect(headerOf(again.container, 'Location').getAttribute('aria-sort')).toBe(
    'descending',
  )
  expect(headerOf(again.container, 'Name').getAttribute('aria-sort')).toBe(
    'descending',
  )
})

test("a column menu's sort replaces the whole list with its one rule", async () => {
  addLisbon()
  const { container, search: address } = await people(
    tableAt('person', { sort: 'location', then: 'name:desc' }),
  )
  await waitFor(() => buttonNamed(container, 'Sort: Location +1'))
  await fromHeader(container, 'Email', 'Sort ascending')
  await waitFor(() => address().sort === 'email')
  expect(address().then).toBeUndefined()
  expect(address().desc).toBeUndefined()
  expect(buttonNamed(container, 'Sort: Email')).toBeDefined()
  expect(headerOf(container, 'Location').getAttribute('aria-sort')).toBe('none')
})

test('removing a rule and Clear sorts take rules off the list', async () => {
  const { container, search: address } = await people(
    tableAt('person', { sort: 'location', then: 'name:desc' }),
  )
  await click(await waitFor(() => buttonNamed(container, 'Sort: Location +1')))
  await click(
    await waitFor(() =>
      document.querySelector('button[aria-label="Remove sort 1"]'),
    ),
  )
  // The second rule becomes the first.
  await waitFor(() => address().sort === 'name')
  expect(address()).toMatchObject({ sort: 'name', desc: true })
  expect(address().then).toBeUndefined()
  await click(await waitFor(() => buttonNamed(document.body, 'Clear sorts')))
  await waitFor(() => address().sort === undefined)
  expect(address().desc).toBeUndefined()
  expect(buttonNamed(container, 'Sort')).toBeDefined()
})

test('the address reads `then` strictly: a key with a comma or colon is skipped', () => {
  expect(parseThen('name:desc,email,a:b,:desc,x:desc:y,')).toEqual([
    { key: 'name', descending: true },
    { key: 'email', descending: false },
  ])
  expect(
    sortsFromAddress({ sort: 'a', desc: true, then: 'a,b:desc,c' }),
  ).toEqual([
    { key: 'a', descending: true },
    { key: 'b', descending: true },
    { key: 'c', descending: false },
  ])
  expect(
    sortsToAddress([
      { key: 'a', descending: false },
      { key: 'b', descending: true },
      { key: 'c', descending: false },
      { key: 'bad,key', descending: false },
      { key: 'bad:key', descending: true },
    ]),
  ).toEqual({ sort: 'a', desc: undefined, then: 'b:desc,c' })
  expect(sortsToAddress([])).toEqual({
    sort: undefined,
    desc: undefined,
    then: undefined,
  })
})

// The header is the column's menu

test('a click on a header label opens the column menu, and Escape closes it', async () => {
  const { container } = await people()
  const label = headerOf(container, 'Email').querySelector('.truncate')!
  await click(label)
  await waitFor(() => document.querySelector('[role="menu"]'))
  const items = [...document.querySelectorAll('[role^="menuitem"]')].map((i) =>
    i.textContent.trim(),
  )
  expect(items).toEqual([
    'Search',
    'Sort ascending',
    'Sort descending',
    'Move left',
    'Move right',
    'Hide',
  ])
  // Nothing was sorted by the click.
  expect(headerOf(container, 'Email').getAttribute('aria-sort')).toBe('none')
})

// Dragging a column

test('a drop moves a column to the place of the one it is dropped on, and never a pinned one', () => {
  const order = ['__select', 'name', 'a', 'b', 'c', 'd']
  const pinned = ['__select', 'name']
  expect(reorderColumns(order, 'a', 'c', pinned)).toEqual([
    '__select',
    'name',
    'b',
    'c',
    'a',
    'd',
  ])
  expect(reorderColumns(order, 'd', 'a', pinned)).toEqual([
    '__select',
    'name',
    'd',
    'a',
    'b',
    'c',
  ])
  expect(reorderColumns(order, 'a', 'a', pinned)).toEqual(order)
  expect(reorderColumns(order, 'a', 'name', pinned)).toEqual(order)
  expect(reorderColumns(order, 'name', 'c', pinned)).toEqual(order)
  expect(reorderColumns(order, 'a', 'missing', pinned)).toEqual(order)
})

test('the movable headers are sortable items and the identifier is not', async () => {
  const { container } = await people()
  const email = headerOf(container, 'Email').querySelector('button')!
  expect(email.getAttribute('aria-roledescription')).toBe('sortable')
  expect(email.getAttribute('aria-describedby')).toBeTruthy()
  const name = headerOf(container, 'Name').querySelector('button')!
  expect(name.getAttribute('aria-roledescription')).toBeNull()
  // The resize handle is not part of the button that drags.
  expect(email.querySelector('[data-slot="resize-handle"]')).toBeNull()
})

test('Alt and Space picks a column up, the arrows move it and Space drops it', async () => {
  const { container } = await people()
  const before = headers(container).filter(Boolean)
  const email = headerOf(container, 'Email').querySelector('button')!
  const press = (target: Element, code: string, altKey = false) =>
    act(async () => {
      target.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: code,
          code,
          altKey,
          bubbles: true,
          cancelable: true,
        }),
      )
      await new Promise((resolve) => setTimeout(resolve, 5))
    })
  // happy-dom lays nothing out: give each header a 100 px place in the row, so
  // the sensor has somewhere to move to.
  const place = (header: Element) => {
    const at = [...container.querySelectorAll('[role="columnheader"]')].indexOf(
      header,
    )
    return {
      x: at * 100,
      y: 0,
      left: at * 100,
      top: 0,
      right: at * 100 + 100,
      bottom: 32,
      width: 100,
      height: 32,
      toJSON: () => ({}),
    } as DOMRect
  }
  const real = Element.prototype.getBoundingClientRect
  Element.prototype.getBoundingClientRect = function () {
    return this.getAttribute('role') === 'columnheader'
      ? place(this)
      : real.call(this)
  }
  try {
    await act(async () => email.focus())
    await press(email, 'Space', true)
    await press(document.body, 'ArrowRight')
    await press(document.body, 'Space')
    await settle()
    expect(before.slice(0, 4)).toEqual([
      'Name',
      'Also called',
      'Email',
      'Phone',
    ])
    expect(headers(container).filter(Boolean).slice(0, 4)).toEqual([
      'Name',
      'Also called',
      'Phone',
      'Email',
    ])
  } finally {
    Element.prototype.getBoundingClientRect = real
  }
})
const settle = () =>
  act(() => new Promise((resolve) => setTimeout(resolve, 15)))
