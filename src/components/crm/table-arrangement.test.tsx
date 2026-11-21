// SOURCING: bun:test rendering the CRM table as the Index draws it (./test-harness) with React into happy-dom, for what a person arranges in the table and keeps: the column menu and the "+" column, the order, widths and visibility saved per view in localStorage, the Calculate row and its setting, marking a range of rows and exporting them as CSV, resizing by the header edge, and Tab and Backspace in the grid. window.fetch is the in-memory fixture (./fixture)
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
  render,
  waitFor,
} from '../../../test/blocks/render'
import {
  IndexPlaceContext,
  useIndexNavigate,
} from '@/components/index/navigation'
import { AppearanceSettings } from '@/routes/settings/appearance'
import { createFixtureServer, fixtureFetch } from './fixture'
import type { FixtureServer } from './fixture'
import { CALCULATIONS_KEY, setCalculationsShown } from './calculations-setting'
import { CrmTableView } from './index-views'
import { resetCrmWrites, useCrmEdits } from './queries'
import { IndexRecords, mountAt, tableAt } from './test-harness'
import { useRecordLayouts } from '@/components/records/view-state'

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
  setCalculationsShown(false)
  server = createFixtureServer()
  window.fetch = fixtureFetch(server)
})
afterEach(async () => {
  await cleanup()
  window.fetch = realFetch
  window.localStorage.clear()
  useRecordLayouts.setState({ layouts: {} })
})

const settle = () =>
  act(() => new Promise((resolve) => setTimeout(resolve, 15)))
const key = (element: Element, which: string, init: KeyboardEventInit = {}) =>
  act(async () => {
    element.dispatchEvent(
      new KeyboardEvent('keydown', { key: which, bubbles: true, ...init }),
    )
  })
const updates = () =>
  server.state.verbs.filter((call) => call.verb === 'update_one')

/** More people, so a range has somewhere to run. */
const addPeople = (...names: string[]) =>
  names.forEach((name, i) =>
    server.state.nodes.push({
      id: `person:extra-${i}`,
      labels: ['Person'],
      properties: { name, location: 'Lisbon' },
      version: 1,
    }),
  )

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
const cellAt = (container: HTMLElement, row: number, col: number) =>
  container.querySelector<HTMLElement>(
    `[role="gridcell"][data-r="${row}"][data-c="${col}"]`,
  )!

async function people(path = tableAt('person')) {
  const mounted = await mountAt(path, () => <IndexRecords />)
  await waitFor(() =>
    mounted.container.querySelector('[role="grid"] [data-r="1"]'),
  )
  return mounted
}
/** A menu item, once its menu is open. */
const menuItem = (label: string) =>
  waitFor(() =>
    [...document.querySelectorAll('[role^="menuitem"]')].find(
      // The field's glyph is part of its item's text.
      (item) => item.textContent.trim().endsWith(label),
    ),
  )
/** Opens a column's menu and picks from it. */
async function fromColumnMenu(
  container: HTMLElement,
  column: string,
  item: string,
) {
  await click(container.querySelector(`[aria-label="${column} column menu"]`)!)
  await click(await menuItem(item))
}
// Arrangements live in the layouts store (also kept in localStorage, and sent to Theorem); the
// keys keep the old `theorem.crm.view:` spelling so each assertion still names its view.
const saved = () =>
  Object.fromEntries(
    Object.entries(useRecordLayouts.getState().layouts).map(([k, layout]) => [
      `theorem.crm.view:${k}`,
      layout,
    ]),
  )

// The column menu and the "+" column

test('Hide in a column\'s menu hides it, and the "+" column shows it again', async () => {
  const { container } = await people()
  expect(headers(container)).toContain('Email')
  await fromColumnMenu(container, 'Email', 'Hide')
  await waitFor(() => !headers(container).includes('Email'))

  await click(container.querySelector('[aria-label="Show a field"]')!)
  await click(await menuItem('Email'))
  await waitFor(() => headers(container).includes('Email'))
})

test("the identifier column's menu offers only Search and Sort", async () => {
  const { container } = await people()
  await click(container.querySelector('[aria-label="Name column menu"]')!)
  await menuItem('Search')
  const items = [...document.querySelectorAll('[role="menuitem"]')].map((i) =>
    i.textContent.trim(),
  )
  expect(items).toEqual(['Search', 'Sort ascending', 'Sort descending'])
})

test('a column menu sorts through the one sort the address holds', async () => {
  const { container, search } = await people()
  await fromColumnMenu(container, 'Email', 'Sort descending')
  await waitFor(() => search().sort === 'email')
  expect(search().desc).toBe(true)
  expect(headerOf(container, 'Email').getAttribute('aria-sort')).toBe(
    'descending',
  )
  // The Sort menu in the view bar names the same sort.
  expect(buttonNamed(container, 'Sort: Email')).toBeDefined()
})

test("Search in a column menu opens the view bar's search", async () => {
  const { container } = await people()
  await fromColumnMenu(container, 'Email', 'Search')
  await waitFor(() =>
    container.querySelector('input[aria-label="Search people"]'),
  )
})

test('Move left and Move right reorder the columns, and the identifier stays first', async () => {
  const { container } = await people()
  const before = headers(container).filter(Boolean)
  expect(before.slice(0, 3)).toEqual(['Name', 'Also called', 'Email'])
  await fromColumnMenu(container, 'Email', 'Move left')
  await waitFor(() => headers(container)[2] === 'Email')
  expect(headers(container).filter(Boolean).slice(0, 3)).toEqual([
    'Name',
    'Email',
    'Also called',
  ])
  await fromColumnMenu(container, 'Email', 'Move right')
  await waitFor(() => headers(container)[2] === 'Also called')
  // The first column that can move has no Move left.
  await click(
    container.querySelector('[aria-label="Also called column menu"]')!,
  )
  await menuItem('Hide')
  expect(
    [...document.querySelectorAll('[role="menuitem"]')].some(
      (i) => i.textContent.trim() === 'Move left',
    ),
  ).toBe(false)
})

test('the identifier stays pinned: its cell sticks beside the checkbox column', async () => {
  const { container } = await people()
  const first = cellAt(container, 0, 0)
  expect(first.className).toContain('sticky')
  expect(first.style.left).toBe('32px')
})

// Kept per view

test("the arrangement survives a remount, and is the view's own", async () => {
  const first = await people()
  await fromColumnMenu(first.container, 'Email', 'Hide')
  await fromColumnMenu(first.container, 'Phone', 'Move left')
  await waitFor(() => !headers(first.container).includes('Email'))
  await cleanup()

  const again = await people()
  expect(headers(again.container)).not.toContain('Email')
  expect(headers(again.container).filter(Boolean).slice(0, 3)).toEqual([
    'Name',
    'Phone',
    'Also called',
  ])
  expect(Object.keys(saved())).toEqual([
    'theorem.crm.view:default:records:person:Person',
  ])
  await cleanup()

  // The same type in another Index view (a view program's RecordTable) is not arranged by it.
  function InView() {
    const navigate = useIndexNavigate()
    return (
      <IndexPlaceContext.Provider
        value={{
          search: { view: 'custom:team', scope: { kind: 'home' } },
          navigate,
        }}
      >
        <CrmTableView object="person" />
      </IndexPlaceContext.Provider>
    )
  }
  const custom = await mountAt('/index?view=custom:team', () => <InView />)
  await waitFor(() => custom.container.querySelector('[role="grid"]'))
  expect(headers(custom.container)).toContain('Email')
  await fromColumnMenu(custom.container, 'Phone', 'Hide')
  await waitFor(() => !headers(custom.container).includes('Phone'))
  expect(Object.keys(saved()).sort()).toEqual([
    'theorem.crm.view:custom:team:Person',
    'theorem.crm.view:default:records:person:Person',
  ])
  await cleanup()

  // A table in a page's module names its own key.
  const module = await mountAt('/index', () => (
    <CrmTableView object="person" viewKey="module:page-1/records" />
  ))
  await waitFor(() => module.container.querySelector('[role="grid"]'))
  expect(headers(module.container)).toContain('Email')
  expect(headers(module.container)).toContain('Phone')
})

test('a view that picks its fields starts from them, and a saved arrangement replaces them', async () => {
  const picked = () =>
    mountAt('/index', () => (
      <CrmTableView
        object="person"
        fields={['name', 'role', 'email']}
        viewKey="module:picked"
      />
    ))
  const first = await picked()
  await waitFor(() => first.container.querySelector('[role="grid"]'))
  expect(headers(first.container).filter(Boolean)).toEqual([
    'Name',
    'Role',
    'Email',
  ])
  await fromColumnMenu(first.container, 'Email', 'Move left')
  await waitFor(() => headers(first.container)[2] === 'Email')
  await cleanup()
  const again = await picked()
  await waitFor(() => again.container.querySelector('[role="grid"]'))
  expect(headers(again.container).filter(Boolean)).toEqual([
    'Name',
    'Email',
    'Role',
  ])
})

test('nothing is saved until the arrangement is changed, and Reset arrangement forgets it', async () => {
  const { container } = await people()
  expect(saved()).toEqual({})
  await fromColumnMenu(container, 'Email', 'Hide')
  await waitFor(() => !headers(container).includes('Email'))
  expect(Object.keys(saved())).toHaveLength(1)

  await click(buttonNamed(container, 'Options')!)
  await click(await menuItem('Reset arrangement'))
  await waitFor(() => headers(container).includes('Email'))
  expect(saved()).toEqual({})
})

test('a saved arrangement of the wrong shape is ignored, field by field', async () => {
  window.localStorage.setItem(
    'theorem.crm.view:default:records:person:Person',
    JSON.stringify({
      columnOrder: 'name',
      columnSizing: { email: 'wide' },
      columnVisibility: { phone: false, role: 'no' },
      aggregates: { name: 'average', email: 'bogus' },
    }),
  )
  const { container } = await people()
  expect(headers(container)).not.toContain('Phone')
  expect(headers(container)).toContain('Role')
  expect(headers(container).filter(Boolean).slice(0, 3)).toEqual([
    'Name',
    'Also called',
    'Email',
  ])
})

test('storage that cannot be used leaves the table working', async () => {
  const getItem = Storage.prototype.getItem
  const setItem = Storage.prototype.setItem
  Storage.prototype.getItem = () => {
    throw new Error('blocked')
  }
  Storage.prototype.setItem = () => {
    throw new Error('blocked')
  }
  try {
    const { container } = await people()
    await fromColumnMenu(container, 'Email', 'Hide')
    await waitFor(() => !headers(container).includes('Email'))
  } finally {
    Storage.prototype.getItem = getItem
    Storage.prototype.setItem = setItem
  }
})

// Calculate

test('the Calculate row is not there until the setting is on, then follows it', async () => {
  const { container } = await people()
  expect(container.querySelector('[data-crm-region="calculations"]')).toBeNull()
  expect(container.querySelector('footer')!.textContent).toBe('2 people')

  await act(async () => setCalculationsShown(true))
  await waitFor(() =>
    container.querySelector('[data-crm-region="calculations"]'),
  )
  // The count stays where it was.
  expect(container.querySelector('footer')!.textContent).toBe('2 people')

  await act(async () => setCalculationsShown(false))
  await waitFor(
    () => !container.querySelector('[data-crm-region="calculations"]'),
  )
  expect(window.localStorage.getItem(CALCULATIONS_KEY)).toBe('off')
})

test('Settings, Appearance has the switch, off at first, kept on this device', async () => {
  const { container } = await render(<AppearanceSettings />)
  const toggle = container.querySelector<HTMLElement>(
    '[role="switch"][aria-label="Calculations under record tables"]',
  )!
  expect(toggle.getAttribute('aria-checked')).toBe('false')
  await click(toggle)
  await waitFor(() => toggle.getAttribute('aria-checked') === 'true')
  expect(window.localStorage.getItem(CALCULATIONS_KEY)).toBe('on')
  await click(toggle)
  await waitFor(() => toggle.getAttribute('aria-checked') === 'false')
  expect(window.localStorage.getItem(CALCULATIONS_KEY)).toBe('off')
})

test('a Count is calculated over the records loaded, and kept for the view', async () => {
  setCalculationsShown(true)
  const first = await people()
  const row = () =>
    first.container.querySelector<HTMLElement>(
      '[data-crm-region="calculations"]',
    )!
  await click(row().querySelector('[aria-label="Calculate Name"]')!)
  await click(await menuItem('Count'))
  await click(await menuItem('Count all'))
  await waitFor(() => row().textContent.includes('Count all2'))
  expect(Object.values(saved())[0]).toMatchObject({
    aggregates: { name: 'count' },
  })
  await cleanup()

  const again = await people()
  await waitFor(() =>
    again.container
      .querySelector('[data-crm-region="calculations"]')
      ?.textContent.includes('Count all2'),
  )
})

test('when not every record is loaded, the calculation says so', async () => {
  setCalculationsShown(true)
  const answered = window.fetch
  // The server holds more than it sends.
  window.fetch = (async (...args: Parameters<typeof fetch>) => {
    const response = await answered(...args)
    const text = await response.clone().text()
    if (!text.includes('"invokeRecordVerb"') || !text.includes('"count":2'))
      return response
    return new Response(text.replace('"count":2', '"count":9'), response)
  }) as typeof fetch
  const { container } = await people()
  await waitFor(() =>
    container.querySelector('footer')!.textContent.includes('first 2 of 9'),
  )
  const row = container.querySelector<HTMLElement>(
    '[data-crm-region="calculations"]',
  )!
  await click(row.querySelector('[aria-label="Calculate Name"]')!)
  await click(await menuItem('Count'))
  await click(await menuItem('Count all'))
  await waitFor(() => row.textContent.includes('of 2 loaded'))
})

// Marking and exporting

test('Shift-click marks every row between the last one marked and this one', async () => {
  addPeople('Bea', 'Cyrus', 'Dara', 'Eli')
  const { container } = await mountAt(tableAt('person'), () => <IndexRecords />)
  await waitFor(() => container.querySelector('[data-r="5"]'))
  const box = (name: string) =>
    container.querySelector(`[aria-label="Select ${name}"]`)!
  const marked = () =>
    [...container.querySelectorAll('[role="row"][aria-selected="true"]')].map(
      (row) =>
        row.querySelector('[data-c="0"] [title]')!.getAttribute('title')!,
    )
  await click(box('Bea'))
  await act(async () => {
    box('Dara').dispatchEvent(
      new MouseEvent('click', { bubbles: true, shiftKey: true }),
    )
  })
  await waitFor(() => marked().length === 3)
  expect(marked().sort()).toEqual(['Bea', 'Cyrus', 'Dara'])
  expect(container.textContent).toContain('3 selected')
})

type Download = { blob: Blob; name: string }
/** Catches the file the table hands to the browser to save. */
function catchDownload() {
  const downloads: Download[] = []
  const create = URL.createObjectURL
  const revoke = URL.revokeObjectURL
  const clicked = HTMLAnchorElement.prototype.click
  URL.createObjectURL = (blob: Blob | MediaSource) => {
    downloads.push({ blob: blob as Blob, name: '' })
    return 'blob:test'
  }
  URL.revokeObjectURL = () => {}
  HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
    downloads.at(-1)!.name = this.download
  }
  return {
    downloads,
    restore() {
      URL.createObjectURL = create
      URL.revokeObjectURL = revoke
      HTMLAnchorElement.prototype.click = clicked
    },
  }
}

test('Export writes the marked rows as CSV, with the columns shown, in order', async () => {
  const caught = catchDownload()
  try {
    const { container } = await people()
    await fromColumnMenu(container, 'Notes', 'Hide')
    await fromColumnMenu(container, 'Location', 'Move left')
    await click(container.querySelector('[aria-label="Select Noor"]')!)
    await click(buttonNamed(container, 'Export')!)
    expect(caught.downloads).toHaveLength(1)
    expect(caught.downloads[0]!.name).toBe('People.csv')
    const rows = (await caught.downloads[0]!.blob.text()).trim().split('\n')
    const head = rows[0]!.split(',')
    expect(head.slice(0, 2)).toEqual(['Name', 'Also called'])
    expect(head).not.toContain('Notes')
    expect(head.indexOf('Location')).toBe(head.indexOf('Role') - 1)
    // Only the marked row, related records by name.
    expect(rows).toHaveLength(2)
    expect(rows[1]).toContain('Noor')
    expect(rows[1]).not.toContain('Avery')
    expect(rows[1]).toContain('Runs the glaze workshop with me')
  } finally {
    caught.restore()
  }
})

test('with no rows marked, Export in Options writes the rows the filter leaves, in the sort order', async () => {
  const caught = catchDownload()
  try {
    // The search reads every field, so the needle is one only these two hold
    // ("e" is also in Noor's role); it was "e", over names alone, before.
    addPeople('Bea Quill')
    const { container } = await mountAt(
      tableAt('person', { q: 'qu', sort: 'name', desc: true }),
      () => <IndexRecords />,
    )
    await waitFor(() => container.querySelector('[data-r="1"]'))
    await click(buttonNamed(container, 'Options')!)
    await click(await menuItem('Export as CSV'))
    const rows = (await caught.downloads[0]!.blob.text()).trim().split('\n')
    // Bea Quill and Avery Quinn contain "qu"; Noor does not. Z to A.
    expect(rows.slice(1).map((row) => row.split(',')[0])).toEqual([
      'Bea Quill',
      'Avery Quinn',
    ])
  } finally {
    caught.restore()
  }
})

// Resizing

test('dragging the header edge resizes the column, within its minimum, and the width is kept', async () => {
  const { container } = await people()
  const email = headerOf(container, 'Email')
  const width = () => Number.parseInt(email.style.width)
  const start = width()
  const handle = email.querySelector<HTMLElement>('.cursor-e-resize')!
  await act(async () => {
    handle.dispatchEvent(
      new MouseEvent('mousedown', { bubbles: true, clientX: 500 }),
    )
  })
  await act(async () => {
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: 560 }))
  })
  await act(async () => {
    document.dispatchEvent(new MouseEvent('mouseup', { clientX: 560 }))
  })
  await waitFor(() => width() === start + 60)
  expect(Object.values(saved())[0]).toMatchObject({
    columnSizing: { email: start + 60 },
  })

  // Dragged far left it stops at the minimum.
  await act(async () => {
    handle.dispatchEvent(
      new MouseEvent('mousedown', { bubbles: true, clientX: 500 }),
    )
  })
  await act(async () => {
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: 0 }))
  })
  await act(async () => {
    document.dispatchEvent(new MouseEvent('mouseup', { clientX: 0 }))
  })
  await waitFor(() => width() === 104)
  // The checkbox column has no handle.
  expect(
    container
      .querySelectorAll('[role="columnheader"]')[0]!
      .querySelector('.cursor-e-resize'),
  ).toBeNull()
})

// Keys

test('Tab and Shift+Tab move across the cells, and leave the grid at the ends', async () => {
  const { container } = await people()
  const first = cellAt(container, 0, 0)
  await act(async () => first.focus())
  await key(first, 'Tab')
  await waitFor(() => document.activeElement === cellAt(container, 0, 1))
  await key(cellAt(container, 0, 1), 'Tab', { shiftKey: true })
  await waitFor(() => document.activeElement === cellAt(container, 0, 0))
  // At the start Shift+Tab is left to the browser, which takes focus out of the grid.
  const event = new KeyboardEvent('keydown', {
    key: 'Tab',
    shiftKey: true,
    bubbles: true,
    cancelable: true,
  })
  await act(async () => {
    cellAt(container, 0, 0).dispatchEvent(event)
  })
  expect(event.defaultPrevented).toBe(false)
})

test('Tab in an open editor saves and moves right', async () => {
  const { container } = await people()
  const location = headerOf(container, 'Location')
  const col = headers(container).indexOf('Location') - 1
  const cell = cellAt(container, 0, col)
  await act(async () => cell.focus())
  await key(cell, 'Enter')
  const input = await waitFor(() => cell.querySelector('input'))
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!.call(input, 'Porto')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await key(input, 'Tab')
  await waitFor(() => updates().length === 1)
  expect(updates()[0]!.input).toMatchObject({ location: 'Porto' })
  await waitFor(() => document.activeElement === cellAt(container, 0, col + 1))
  expect(location).toBeDefined()
})

test('Backspace empties the cell by the revision-checked write the editor makes', async () => {
  const { container } = await people()
  const col = headers(container).indexOf('Email') - 1
  const row = names(container).indexOf('Avery Quinn')
  const cell = cellAt(container, row, col)
  expect(cell.textContent).toContain('avery@example.com')
  await act(async () => cell.focus())
  await key(cell, 'Backspace')
  await waitFor(() => updates().length === 1)
  expect(updates()[0]!.input).toMatchObject({
    id: 'person:avery',
    email: null,
    expected_revision: 3,
  })
  await waitFor(() => !cell.textContent.includes('avery@example.com'))
})

test('Backspace on a record changed elsewhere is refused, and the cell says so', async () => {
  const { container } = await people()
  const col = headers(container).indexOf('Email') - 1
  const row = names(container).indexOf('Avery Quinn')
  server.changeElsewhere('person:avery', { email: 'new@example.com' })
  const cell = cellAt(container, row, col)
  await act(async () => cell.focus())
  await key(cell, 'Delete')
  const alert = await waitFor(() => container.querySelector('[role="alert"]'))
  expect(alert.textContent).toContain('changed since')
  expect(
    server.state.nodes.find((n) => n.id === 'person:avery')!.properties.email,
  ).toBe('new@example.com')
})

test('Backspace leaves the name, a required field and an empty cell alone', async () => {
  const { container } = await people()
  const name = cellAt(container, 0, 0)
  await act(async () => name.focus())
  await key(name, 'Backspace')
  // Noor has no email: nothing to empty.
  const email = cellAt(
    container,
    names(container).indexOf('Noor'),
    headers(container).indexOf('Email') - 1,
  )
  await act(async () => email.focus())
  await key(email, 'Backspace')
  await settle()
  expect(updates()).toHaveLength(0)
})

// Review fixes

test('a view that picks its fields offers only those columns in Options and Sort', async () => {
  const mounted = await mountAt('/index', () => (
    <CrmTableView
      object="person"
      fields={['name', 'email']}
      viewKey="module:narrow"
    />
  ))
  await waitFor(() => mounted.container.querySelector('[role="grid"]'))
  await click(buttonNamed(mounted.container, 'Options')!)
  await menuItem('Export as CSV')
  const columns = [...document.querySelectorAll('[role="menuitemcheckbox"]')]
    .map((item) => item.textContent.trim())
    // The Columns group is the one before the Theorem switch.
    .filter((_, i, all) => i < all.indexOf('May use people in answers'))
  expect(columns).toEqual(['Name', 'Email'])
})

test('Calculate totals use saved values, not edits that are not saved', async () => {
  setCalculationsShown(true)
  useRecordLayouts.setState({
    layouts: {
      'default:records:person:Person': {
        aggregates: { role: 'notEmpty' },
        at: 1,
      },
    },
  })
  // Avery has no role; an edit the server refused would give her one.
  useCrmEdits.getState().put({
    recordId: 'person:avery',
    objectTypeId: 'Person',
    fieldKey: 'role',
    value: 'Potter',
    readRevision: 3,
    status: 'failed',
  })
  const { container } = await people()
  const row = container.querySelector<HTMLElement>(
    '[data-crm-region="calculations"]',
  )!
  await waitFor(() => row.textContent.includes('Not empty'))
  expect(row.textContent).toContain('Not empty1')
  useCrmEdits.setState({ edits: {} })
})

test('a search finds a choice by the label its tag shows', async () => {
  server.state.nodes.push({
    id: 'goal:book',
    labels: ['Goal'],
    properties: { title: 'Finish the book', status: 'set_aside' },
    version: 1,
  })
  server.state.nodes.push({
    id: 'goal:run',
    labels: ['Goal'],
    properties: { title: 'Run daily', status: 'active' },
    version: 1,
  })
  const { container } = await mountAt(tableAt('goal'), () => <IndexRecords />)
  await waitFor(() => container.querySelector('[role="grid"] [data-r="1"]'))
  await click(buttonNamed(container, 'Search')!)
  const input = await waitFor(() =>
    container.querySelector<HTMLInputElement>(
      'input[aria-label="Search goals"]',
    ),
  )
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!.call(input, 'set aside')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await waitFor(() => names(container).length === 1)
  expect(names(container)).toEqual(['Finish the book'])
})
