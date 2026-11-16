// SOURCING: bun:test rendering the CRM's screens with React into happy-dom, inside a router that knows the CRM's places (./test-harness). window.fetch is the in-memory fixture (./fixture), which answers each record verb as the server does, as no Theorem is running
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import { act } from 'react'
import { buttonNamed, cleanup, click, waitFor } from '../../../test/blocks/render'
import { useComposerReferences } from '@/components/chat/composer-references'
import { CrmPanel } from './crm-panel'
import { CrmView } from './crm-view'
import { FIXTURE_TYPE, createFixtureServer, fixtureFetch } from './fixture'
import type { FixtureServer } from './fixture'
import { useCrmPreview } from './navigation'
import { resetCrmWrites } from './queries'
import { mountAt } from './test-harness'

const page = (
  window as unknown as { happyDOM: { setURL: (url: string) => void } }
).happyDOM
beforeAll(() => page.setURL('http://localhost:3000/'))
afterAll(() => page.setURL('about:blank'))

let server: FixtureServer
const realFetch = window.fetch
const serve = (options?: Parameters<typeof createFixtureServer>[0]) => {
  server = createFixtureServer(options)
  window.fetch = fixtureFetch(server)
}
beforeEach(() => {
  resetCrmWrites()
  useCrmPreview.setState({ preview: {} })
  useComposerReferences.setState({ references: [] })
  serve()
})
afterEach(async () => {
  await cleanup()
  window.fetch = realFetch
})

const view = (path: string) => mountAt(path, () => <CrmView />)
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 15)))
const key = (element: Element, which: string, init: KeyboardEventInit = {}) =>
  act(async () => {
    element.dispatchEvent(new KeyboardEvent('keydown', { key: which, bubbles: true, ...init }))
  })
const type = (input: HTMLInputElement, text: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
const updates = () => server.state.verbs.filter((call) => call.verb === 'update_one')

/** The column labels, without the field-type glyph beside each. */
const columns = (container: HTMLElement) =>
  [...container.querySelectorAll('[role="columnheader"]')].map(
    (header) => header.querySelector('.truncate')?.textContent ?? '',
  )

/** The cell under a column's header, in the first row. */
function cell(container: HTMLElement, column: string) {
  const headers = columns(container)
  const index = headers.indexOf(column)
  if (index < 0) throw new Error(`no column called ${column}: ${headers.join(', ')}`)
  const row = container.querySelectorAll('[role="rowgroup"]')[1]!.querySelector('[role="row"]')!
  return row.querySelectorAll('[role="gridcell"]')[index] as HTMLElement
}
const commitments = async (path = '/crm/commitments') => {
  const mounted = await view(path)
  await waitFor(() => mounted.container.querySelector('[role="grid"] [data-r="0"]'))
  return mounted
}
/** Opens the Due cell's editor and types into it. */
async function editDue(container: HTMLElement, text: string) {
  const due = cell(container, 'Due')
  await act(async () => due.focus())
  await key(due, 'Enter')
  const input = await waitFor(() => due.querySelector('input'))
  await type(input, text)
  return input
}

// First run

test('before the types exist, it says what will be added and adds them on request', async () => {
  serve({ installed: false })
  const { container, path } = await view('/crm')
  const add = await waitFor(() => buttonNamed(container, 'Add people, organizations, commitments…'))
  expect(container.querySelector('[role="grid"]')).toBeNull()
  await click(add)
  // Once they exist, /crm is the first type's table.
  await waitFor(() => path() === '/crm/people')
  await waitFor(() => container.querySelector('[role="grid"]'))
  expect(server.state.installed).toBe(true)
})

test('/crm opens the first listed type', async () => {
  const { path } = await view('/crm')
  await waitFor(() => path() === '/crm/people')
})

test('a type that does not exist is said, not drawn as an empty table', async () => {
  const { container } = await view('/crm/unicorns')
  await waitFor(() => container.textContent.includes('There is no record type called “unicorns”.'))
  expect(container.querySelector('[role="grid"]')).toBeNull()
})

// The table

test('a type is a grid: a header with its count, one row per record, relations by name', async () => {
  const { container } = await commitments()
  expect(container.querySelector('h1')!.textContent).toBe('Commitments')
  expect(container.textContent).toContain('All Commitments')
  const grid = container.querySelector('[role="grid"]')!
  expect(grid.getAttribute('aria-label')).toBe('All Commitments')
  expect(columns(container).slice(1, 4)).toEqual(['Commitment', 'Owed by', 'Owed to'])
  expect(cell(container, 'Commitment').textContent).toContain('Send Noor the materials list')
  // A relation shows the related record's name, once People have loaded.
  await waitFor(() => cell(container, 'Owed to').textContent.includes('Noor'))
  expect(cell(container, 'Due').textContent).toBe('Friday')
  expect(container.querySelector('footer')!.textContent).toBe('1 commitment')
  // Exactly one cell is in the tab order; the rest are reached with the arrows.
  expect(grid.querySelectorAll('[role="gridcell"][tabindex="0"]')).toHaveLength(1)
})

test('Enter saves an edit against the revision that was read', async () => {
  const { container } = await commitments()
  const input = await editDue(container, 'Monday')
  await key(input, 'Enter')
  await waitFor(() => updates().length === 1)
  expect(updates()[0]!.input).toMatchObject({
    id: 'commitment:materials',
    due: 'Monday',
    expected_revision: 9,
  })
  await waitFor(() => cell(container, 'Due').textContent === 'Monday')
})

test('Escape cancels an edit: nothing is sent and the saved value is back', async () => {
  const { container } = await commitments()
  const input = await editDue(container, 'Monday')
  await key(input, 'Escape')
  await settle()
  expect(cell(container, 'Due').querySelector('input')).toBeNull()
  expect(cell(container, 'Due').textContent).toBe('Friday')
  expect(updates()).toHaveLength(0)
  // The cell keeps the cursor, so the keyboard carries on from it.
  await waitFor(() => document.activeElement === cell(container, 'Due'))
})

test('a record changed elsewhere is not overwritten: the edit stays, with Reload', async () => {
  const { container } = await commitments()
  server.changeElsewhere('commitment:materials', { due: 'Thursday' })
  const input = await editDue(container, 'Monday')
  await key(input, 'Enter')
  const alert = await waitFor(() => container.querySelector('[role="alert"]'))
  expect(alert.textContent).toContain('changed since')
  // What was typed is still on screen, marked as not saved.
  expect(cell(container, 'Due').textContent).toContain('Monday')
  expect(alert.textContent).toContain('Monday')
  expect(
    server.state.nodes.find((node) => node.id === 'commitment:materials')!.properties.due,
  ).toBe('Thursday')

  await click(buttonNamed(alert, 'Reload')!)
  // Reloading shows what it is now and keeps the edit for the person to decide.
  const held = await waitFor(() => buttonNamed(container, 'Save my change'))
  expect(container.querySelector('[role="alert"]')!.textContent).toContain('Thursday')
  await click(held)
  await waitFor(() => updates().length === 2)
  expect(updates()[1]!.input).toMatchObject({ due: 'Monday', expected_revision: 10 })
  await waitFor(() => !container.querySelector('[role="alert"]'))
  expect(cell(container, 'Due').textContent).toBe('Monday')
})

test('"Add new" creates the record and puts the cursor in its name', async () => {
  const { container } = await commitments()
  await click(buttonNamed(container, 'Add new')!)
  const input = await waitFor(() =>
    container.querySelector<HTMLInputElement>('[data-add-row] input'),
  )
  await type(input, 'Book the kiln')
  await key(input, 'Enter')
  await waitFor(() => server.state.verbs.some((call) => call.verb === 'create_one'))
  const created = server.state.verbs.find((call) => call.verb === 'create_one')!
  expect(created.input).toMatchObject({ title: 'Book the kiln' })
  const added = await waitFor(() =>
    [...container.querySelectorAll<HTMLElement>('[role="gridcell"][data-c="0"]')].find((c) =>
      c.textContent.includes('Book the kiln'),
    ),
  )
  await waitFor(() => document.activeElement === added)
  expect(container.querySelector('footer')!.textContent).toBe('2 commitments')
})

test('Escape in the "Add new" row creates nothing', async () => {
  const { container } = await commitments()
  await click(buttonNamed(container, 'Add new')!)
  const input = await waitFor(() =>
    container.querySelector<HTMLInputElement>('[data-add-row] input'),
  )
  await type(input, 'Book the kiln')
  await key(input, 'Escape')
  await settle()
  expect(server.state.verbs.some((call) => call.verb === 'create_one')).toBe(false)
  expect(buttonNamed(container, 'Add new')).toBeDefined()
})

test('the filter narrows by name and the footer says so', async () => {
  const { container } = await view('/crm/people')
  await waitFor(() => container.querySelector('[role="grid"] [data-r="1"]'))
  await click(buttonNamed(container, 'Filter')!)
  const input = await waitFor(() =>
    container.querySelector<HTMLInputElement>('input[aria-label^="Filter people"]'),
  )
  await type(input, 'noo')
  expect(container.querySelectorAll('[role="gridcell"][data-c="0"]')).toHaveLength(1)
  expect(container.querySelector('footer')!.textContent).toBe('1 of 2 people match “noo”')
})

test('a column header sorts, and says which way', async () => {
  const { container } = await view('/crm/people')
  await waitFor(() => container.querySelector('[role="grid"] [data-r="1"]'))
  const names = () =>
    [...container.querySelectorAll('[role="gridcell"][data-c="0"]')].map((c) => c.textContent.trim())
  const header = container.querySelectorAll('[role="columnheader"]')[columns(container).indexOf('Name')]!
  await click(header.querySelector('button')!)
  expect(header.getAttribute('aria-sort')).toBe('ascending')
  const ascending = names()
  await click(header.querySelector('button')!)
  expect(header.getAttribute('aria-sort')).toBe('descending')
  expect(names()).toEqual([...ascending].reverse())
})

// What this sign-in may do

test('a type that can be read but not changed says so, and offers no editing', async () => {
  serve({ readOnly: ['commitments'] })
  const { container } = await commitments()
  expect(container.textContent).toContain(
    'This sign-in can read Commitments but not change them',
  )
  expect(buttonNamed(container, 'Add new')).toBeUndefined()
  expect(buttonNamed(container, /New record/)).toBeUndefined()
  const due = cell(container, 'Due')
  expect(due.getAttribute('aria-readonly')).toBe('true')
  await act(async () => due.focus())
  await key(due, 'Enter')
  expect(due.querySelector('input')).toBeNull()
})

test('a type that cannot be read is said plainly, with no table and no request for it', async () => {
  serve({ unreadable: ['commitments'] })
  const { container } = await view('/crm/commitments')
  await waitFor(() =>
    container.textContent.includes('Commitments are not available to this sign-in.'),
  )
  expect(container.querySelector('[role="grid"]')).toBeNull()
  expect(
    server.state.verbs.some((call) => call.objectTypeId === FIXTURE_TYPE.commitment),
  ).toBe(false)
})

// The preview

test('a row opens the preview: saved revision, private switch, and the ways on', async () => {
  const { container, path } = await commitments()
  await click(cell(container, 'Commitment'))
  const preview = await waitFor(() => container.querySelector('aside'))
  expect(preview.getAttribute('aria-label')).toBe('Commitment: Send Noor the materials list')
  expect(preview.textContent).toContain('Saved revision 9')
  expect(preview.textContent).toContain('Private to me')
  expect(buttonNamed(preview, 'Ask Theorem')).toBeDefined()
  expect(buttonNamed(preview, 'Delete')).toBeDefined()
  // "This is me" belongs to people only.
  expect(buttonNamed(preview, 'This is me')).toBeUndefined()
  await click(buttonNamed(preview, 'Open')!)
  await waitFor(() => decodeURIComponent(path()) === '/crm/commitments/commitment:materials')
})

test('"Private to me" saves at the record\'s revision and marks the row', async () => {
  const { container } = await commitments()
  await click(cell(container, 'Commitment'))
  const preview = await waitFor(() => container.querySelector('aside'))
  await click(preview.querySelector('[role="switch"]')!)
  await waitFor(() => updates().length === 1)
  expect(updates()[0]!.input).toMatchObject({ context_use: 'private', expected_revision: 9 })
  const grid0 = container.querySelector('[role="grid"]'); const sec0 = container.querySelector('section')
  await settle(); console.log('DBG', container.querySelector('aside') === preview, container.querySelector('[role="grid"]') === grid0, container.querySelector('section') === sec0, container.firstElementChild?.tagName)
  await waitFor(() => preview.textContent.includes('Saved revision 10'))
  expect(preview.textContent).toContain('Theorem does not read or use this record')
  // The lock on the row has words, not only a mark.
  await waitFor(() => cell(container, 'Commitment').textContent.includes('Private'))
})

test('"This is me" marks a person as you', async () => {
  serve({ self: 'unbound' })
  const { container } = await view('/crm/people')
  const noor = await waitFor(() =>
    [...container.querySelectorAll<HTMLElement>('[role="gridcell"][data-c="0"]')].find((c) =>
      c.textContent.includes('Noor'),
    ),
  )
  await click(noor)
  const preview = await waitFor(() => container.querySelector('aside'))
  await click(buttonNamed(preview, 'This is me')!)
  await waitFor(() => preview.textContent.includes('This record is you'))
  expect(server.state.self).toBe('person:noor')
  expect(noor.textContent).toContain('You')
})

test('"Ask Theorem" puts the record in the next message, by id and type', async () => {
  const { container, path } = await commitments()
  await click(cell(container, 'Commitment'))
  const preview = await waitFor(() => container.querySelector('aside'))
  await click(buttonNamed(preview, 'Ask Theorem')!)
  const [reference] = useComposerReferences.getState().references
  expect(reference).toMatchObject({
    label: 'Send Noor the materials list',
    location: {
      resource: { kind: 'record', objectId: 'commitment:materials', objectType: 'Commitment' },
    },
  })
  await waitFor(() => path() === '/')
})

test('deleting asks first, and names the revision it deletes', async () => {
  const { container } = await commitments()
  await click(cell(container, 'Commitment'))
  const preview = await waitFor(() => container.querySelector('aside'))
  await click(buttonNamed(preview, 'Delete')!)
  const confirm = await waitFor(() => buttonNamed(document.body, 'Delete commitment'))
  expect(server.state.verbs.some((call) => call.verb === 'delete_one')).toBe(false)
  await click(confirm)
  await waitFor(() => server.state.verbs.some((call) => call.verb === 'delete_one'))
  expect(server.state.verbs.find((call) => call.verb === 'delete_one')!.input).toMatchObject({
    id: 'commitment:materials',
    expected_revision: 9,
  })
  await waitFor(() => !container.querySelector('aside'))
  expect(container.querySelector('footer')!.textContent).toBe('0 commitments')
})

// The record page

test('a record page has its properties, its changes and what it is tied to', async () => {
  const { container } = await view('/crm/commitments/commitment%3Amaterials')
  await waitFor(() => container.textContent.includes('Saved revision 9'))
  const tabs = [...container.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent)
  expect(tabs).toEqual(['Timeline', 'Related'])
  const timeline = await waitFor(() =>
    container.querySelector('ol[aria-label="Changes, newest first"]'),
  )
  expect(timeline.textContent).toContain('Avery changed Due from Wednesday to Friday')
  expect(timeline.textContent).toContain('revision 8 → 9')

  await click(container.querySelectorAll('[role="tab"]')[1]!)
  const related = await waitFor(() =>
    container.querySelector('section[aria-label="People, Owed to"]'),
  )
  expect(related.textContent).toContain('Noor')
})

test('a record that is not there says so', async () => {
  const { container } = await view('/crm/commitments/commitment%3Agone')
  await waitFor(() => container.textContent.includes('This commitment is not here.'))
})

// The panel

test('the panel lists the types in order, with counts, the current one marked, and you', async () => {
  const { container } = await mountAt('/crm/commitments', () => <CrmPanel switcher={null} />)
  await waitFor(() => container.querySelector('nav button')?.textContent === 'Avery QuinnYou')
  const rows = [...container.querySelectorAll('nav button')].map((row) => row.textContent)
  expect(rows[0]).toBe('Avery QuinnYou')
  expect(rows.slice(1, 8).map((row) => row.replace(/\d+$/, ''))).toEqual([
    'People',
    'Organizations',
    'Activities',
    'Commitments',
    'Interactions',
    'Goals',
    'Constraints',
  ])
  expect(rows.at(-1)).toBe('Data model')
  await waitFor(() =>
    [...container.querySelectorAll('nav button')].some((row) => row.textContent === 'People2'),
  )
  const current = container.querySelector('nav [aria-current="page"]')!
  expect(current.textContent).toContain('Commitments')
})

test('with nobody marked as you, the panel says how to do it', async () => {
  serve({ self: 'unbound' })
  const { container } = await mountAt('/crm/people', () => <CrmPanel switcher={null} />)
  await waitFor(() => container.textContent.includes('choose “This is me”'))
})
