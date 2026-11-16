// SOURCING: bun:test rendering the CRM's record views as the Index draws them (a type's table, a record's page, the records home, the record open beside a view, and the records part of the Index panel) with React into happy-dom, inside a router that knows the Index's place (./test-harness). window.fetch is the in-memory fixture (./fixture), which answers each record verb as the server does, as no Theorem is running
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
import { useComposerReferences } from '@/components/chat/composer-references'
import {
  RECORDS_HOME_VIEW_ID,
  recordPageViewId,
  recordsViewId,
} from '@/components/index/programs'
import { ProfileSettings } from './profile-settings'
import { FIXTURE_TYPE, createFixtureServer, fixtureFetch } from './fixture'
import type { FixtureServer } from './fixture'
import { resetCrmWrites } from './queries'
import {
  IndexRecords,
  homeAt,
  itemOf,
  mountAt,
  pageAt,
  tableAt,
} from './test-harness'

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
  useComposerReferences.setState({ references: [] })
  serve()
})
afterEach(async () => {
  await cleanup()
  window.fetch = realFetch
})

const view = (path: string) => mountAt(path, () => <IndexRecords />)
const settle = () =>
  act(() => new Promise((resolve) => setTimeout(resolve, 15)))
const key = (element: Element, which: string, init: KeyboardEventInit = {}) =>
  act(async () => {
    element.dispatchEvent(
      new KeyboardEvent('keydown', { key: which, bubbles: true, ...init }),
    )
  })
const type = (input: HTMLInputElement, text: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
const updates = () =>
  server.state.verbs.filter((call) => call.verb === 'update_one')

/** The column labels, without the field-type glyph beside each. */
const columns = (container: HTMLElement) =>
  [...container.querySelectorAll('[role="columnheader"]')].map(
    (header) => header.querySelector('.truncate')?.textContent ?? '',
  )

/** The cell under a column's header, in the first row. */
function cell(container: HTMLElement, column: string) {
  const headers = columns(container)
  const index = headers.indexOf(column)
  if (index < 0)
    throw new Error(`no column called ${column}: ${headers.join(', ')}`)
  const row = container
    .querySelectorAll('[role="rowgroup"]')[1]!
    .querySelector('[role="row"]')!
  return row.querySelectorAll('[role="gridcell"]')[index] as HTMLElement
}
const commitments = async (path = tableAt('commitment')) => {
  const mounted = await view(path)
  await waitFor(() =>
    mounted.container.querySelector('[role="grid"] [data-r="0"]'),
  )
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
  const { container, search } = await view(homeAt())
  const add = await waitFor(() =>
    buttonNamed(container, 'Add people, organizations, commitments…'),
  )
  expect(container.querySelector('[role="grid"]')).toBeNull()
  await click(add)
  // Once they exist, the records home shows the first type's table in place.
  await waitFor(() => container.querySelector('[role="grid"]'))
  expect(container.querySelector('h1')!.textContent).toBe('People')
  expect(search().view).toBe(RECORDS_HOME_VIEW_ID)
  expect(server.state.installed).toBe(true)
})

test('a workspace set up before Relationships existed keeps its records and is offered the new type', async () => {
  serve({ missing: ['Relationship'] })
  // It is not sent back to the first-run screen: the records home is still the table.
  const home = await view(homeAt())
  await waitFor(() => home.container.querySelector('[role="grid"]'))
  expect(home.container.querySelector('h1')!.textContent).toBe('People')
  await cleanup()

  const { container } = await mountAt(tableAt('person'), () => (
    <IndexRecords panel />
  ))
  const add = await waitFor(() =>
    buttonNamed(container, 'Add the Relationship type'),
  )
  const rows = () =>
    [...container.querySelectorAll('nav button')].map((row) => row.textContent)
  expect(rows().some((row) => row.startsWith('Relationships'))).toBe(false)
  await click(add)
  await waitFor(() => rows().some((row) => row.startsWith('Relationships')))
  expect(buttonNamed(container, 'Add the Relationship type')).toBeUndefined()
  expect(server.state.missing.size).toBe(0)
})

test('the records home opens the first listed type', async () => {
  const { container, search } = await view(homeAt())
  await waitFor(() => container.querySelector('[role="grid"]'))
  expect(container.querySelector('h1')!.textContent).toBe('People')
  expect(search().view).toBe(RECORDS_HOME_VIEW_ID)
})

test('a type that does not exist is said, not drawn as an empty table', async () => {
  const { container } = await view(tableAt('unicorn'))
  await waitFor(() =>
    container.textContent.includes('There is no record type called “unicorn”.'),
  )
  expect(container.querySelector('[role="grid"]')).toBeNull()
})

// The table

test('a type is a grid: a header with its count, one row per record, relations by name', async () => {
  const { container } = await commitments()
  expect(container.querySelector('h1')!.textContent).toBe('Commitments')
  expect(container.textContent).toContain('All Commitments')
  const grid = container.querySelector('[role="grid"]')!
  expect(grid.getAttribute('aria-label')).toBe('All Commitments')
  expect(columns(container).slice(1, 4)).toEqual([
    'Commitment',
    'Owed by',
    'Owed to',
  ])
  expect(cell(container, 'Commitment').textContent).toContain(
    'Send Noor the materials list',
  )
  // A relation shows the related record's name, once People have loaded.
  await waitFor(() => cell(container, 'Owed to').textContent.includes('Noor'))
  expect(cell(container, 'Due').textContent).toBe('Friday')
  expect(container.querySelector('footer')!.textContent).toBe('1 commitment')
  // Exactly one cell is in the tab order; the rest are reached with the arrows.
  expect(grid.querySelectorAll('[role="gridcell"][tabindex="0"]')).toHaveLength(
    1,
  )
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
    server.state.nodes.find((node) => node.id === 'commitment:materials')!
      .properties.due,
  ).toBe('Thursday')

  await click(buttonNamed(alert, 'Reload')!)
  // Reloading shows what it is now and keeps the edit for the person to decide.
  const held = await waitFor(() => buttonNamed(container, 'Save my change'))
  expect(container.querySelector('[role="alert"]')!.textContent).toContain(
    'Thursday',
  )
  await click(held)
  await waitFor(() => updates().length === 2)
  expect(updates()[1]!.input).toMatchObject({
    due: 'Monday',
    expected_revision: 10,
  })
  await waitFor(() => !container.querySelector('[role="alert"]'))
  expect(cell(container, 'Due').textContent).toBe('Monday')
})

test('an editor left open saves against the revision it opened on, not one read since', async () => {
  const { container, client } = await commitments()
  const input = await editDue(container, 'Monday')
  // Someone else saves the field, and the table re-reads while the editor is open.
  server.changeElsewhere('commitment:materials', { due: 'Thursday' })
  await act(() => client.refetchQueries())
  await key(input, 'Enter')
  const alert = await waitFor(() => container.querySelector('[role="alert"]'))
  expect(alert.textContent).toContain('changed since')
  expect(updates()).toHaveLength(1)
  expect(updates()[0]!.input).toMatchObject({
    due: 'Monday',
    expected_revision: 9,
  })
  // Their value is still what is saved.
  expect(
    server.state.nodes.find((node) => node.id === 'commitment:materials')!
      .properties.due,
  ).toBe('Thursday')
})

// A name is changed, then changed back while the first change is still on
// its way. The first save can land after the second editor closes, or while
// it is open; either way the second change is sent, after the first.
for (const firstLands of [
  'after the second is entered',
  'while the second editor is open',
] as const)
  test(`a name changed and changed back ends as it began (the first save lands ${firstLands})`, async () => {
    // Hold every update until the test lets it through.
    const answered = window.fetch
    let release = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    window.fetch = (async (...args: Parameters<typeof fetch>) => {
      const [input, init] = args
      const body =
        input instanceof Request
          ? await input.clone().text()
          : String(init?.body ?? '')
      if (body.includes('update_one')) await held
      return answered(...args)
    }) as typeof fetch
    const land = async () => {
      await act(async () => release())
      await settle()
      await settle()
    }

    const { container } = await view(pageAt('person', 'person:noor'))
    const title = () =>
      container.querySelector<HTMLElement>('button[title^="Rename"]')
    const open = async () => {
      await click(await waitFor(title))
      return waitFor(() =>
        container.querySelector<HTMLInputElement>('input[aria-label="Name"]'),
      )
    }
    const enter = async (input: HTMLInputElement, text: string) => {
      await type(input, text)
      await key(input, 'Enter')
    }
    await enter(await open(), 'Noor B')
    const again = await open()
    if (firstLands === 'while the second editor is open') {
      await land()
      await waitFor(() => updates().length === 1)
    }
    await enter(again, 'Noor')
    await land()

    await waitFor(() => updates().length === 2)
    expect(updates().map((call) => call.input.name)).toEqual(['Noor B', 'Noor'])
    // The second names the revision the first produced.
    expect(updates()[1]!.input.expected_revision).toBe(
      Number(updates()[0]!.input.expected_revision) + 1,
    )
    await waitFor(
      () =>
        server.state.nodes.find((node) => node.id === 'person:noor')!.properties
          .name === 'Noor',
    )
    await waitFor(() => title()?.textContent === 'Noor')
  })

test('"Add new" creates the record and puts the cursor in its name', async () => {
  const { container } = await commitments()
  await click(buttonNamed(container, 'Add new')!)
  const input = await waitFor(() =>
    container.querySelector<HTMLInputElement>('[data-add-row] input'),
  )
  await type(input, 'Book the kiln')
  await key(input, 'Enter')
  await waitFor(() =>
    server.state.verbs.some((call) => call.verb === 'create_one'),
  )
  const created = server.state.verbs.find((call) => call.verb === 'create_one')!
  expect(created.input).toMatchObject({ title: 'Book the kiln' })
  const added = await waitFor(() =>
    [
      ...container.querySelectorAll<HTMLElement>(
        '[role="gridcell"][data-c="0"]',
      ),
    ].find((c) => c.textContent.includes('Book the kiln')),
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
  expect(server.state.verbs.some((call) => call.verb === 'create_one')).toBe(
    false,
  )
  expect(buttonNamed(container, 'Add new')).toBeDefined()
})

test('the filter narrows by name and the footer says so', async () => {
  const { container } = await view(tableAt('person'))
  await waitFor(() => container.querySelector('[role="grid"] [data-r="1"]'))
  await click(buttonNamed(container, 'Filter')!)
  const input = await waitFor(() =>
    container.querySelector<HTMLInputElement>(
      'input[aria-label^="Filter people"]',
    ),
  )
  await type(input, 'noo')
  expect(
    container.querySelectorAll('[role="gridcell"][data-c="0"]'),
  ).toHaveLength(1)
  expect(container.querySelector('footer')!.textContent).toBe(
    '1 of 2 people match “noo”',
  )
})

test('a column header sorts, and says which way', async () => {
  const { container } = await view(tableAt('person'))
  await waitFor(() => container.querySelector('[role="grid"] [data-r="1"]'))
  const names = () =>
    [...container.querySelectorAll('[role="gridcell"][data-c="0"]')].map((c) =>
      c.textContent.trim(),
    )
  const header = container.querySelectorAll('[role="columnheader"]')[
    columns(container).indexOf('Name')
  ]!
  await click(header.querySelector('button')!)
  expect(header.getAttribute('aria-sort')).toBe('ascending')
  const ascending = names()
  await click(header.querySelector('button')!)
  expect(header.getAttribute('aria-sort')).toBe('descending')
  expect(names()).toEqual([...ascending].reverse())
})

test('the Sort menu sorts by the field chosen', async () => {
  const { container } = await commitments()
  await click(buttonNamed(container, 'Sort')!)
  const due = await waitFor(() =>
    [...document.querySelectorAll('[role="menuitemradio"]')].find(
      (candidate) => candidate.textContent.trim() === 'Due',
    ),
  )
  await click(due)
  const header = container.querySelectorAll('[role="columnheader"]')[
    columns(container).indexOf('Due')
  ]!
  expect(header.getAttribute('aria-sort')).toBe('ascending')
  expect(buttonNamed(container, 'Sort: Due')).toBeDefined()
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
  const { container } = await view(tableAt('commitment'))
  await waitFor(() =>
    container.textContent.includes(
      'Commitments are not available to this sign-in.',
    ),
  )
  expect(container.querySelector('[role="grid"]')).toBeNull()
  expect(
    server.state.verbs.some(
      (call) => call.objectTypeId === FIXTURE_TYPE.commitment,
    ),
  ).toBe(false)
})

// Whether Theorem may use a type

test('a type Theorem does not use says so, whether it is switched off or has no setting', async () => {
  const commitmentType = server.state.types.find(
    (candidate) => candidate.object_type_id === FIXTURE_TYPE.commitment,
  )!
  const note = 'Theorem does not use commitments when it answers.'
  let mounted = await commitments()
  expect(mounted.container.textContent).not.toContain(note)
  await cleanup()

  commitmentType.extensions = {
    'theorem.context': { version: 1, assistance: 'excluded' },
  }
  mounted = await commitments()
  expect(mounted.container.textContent).toContain(note)
  await cleanup()

  // No setting at all: the server holds such a type back, so the screen must not say it is used.
  commitmentType.extensions = {}
  mounted = await commitments()
  expect(mounted.container.textContent).toContain(note)
  await cleanup()

  commitmentType.extensions = {
    'theorem.context': { version: 7, assistance: 'available' },
  }
  mounted = await commitments()
  expect(mounted.container.textContent).toContain(
    'Theorem does not use commitments when it answers: this type’s setting could not be read.',
  )
})

test('switching a type off for Theorem saves against the type as it was read', async () => {
  const commitmentType = server.state.types.find(
    (candidate) => candidate.object_type_id === FIXTURE_TYPE.commitment,
  )!
  const anchor = commitmentType.content_anchor
  const before = commitmentType.extensions?.['theorem.context'] as Record<
    string,
    unknown
  >
  const { container } = await commitments()
  await click(buttonNamed(container, 'Options')!)
  const item = await waitFor(() =>
    [...document.querySelectorAll('[role="menuitemcheckbox"]')].find(
      (candidate) =>
        candidate.textContent.includes('May use commitments in answers'),
    ),
  )
  expect(item.getAttribute('aria-checked')).toBe('true')
  await click(item)
  await waitFor(() =>
    container.textContent.includes(
      'Theorem does not use commitments when it answers.',
    ),
  )
  // Only the switch changes; the rest of the setting is sent back as it was read.
  expect(commitmentType.extensions?.['theorem.context']).toEqual({
    ...before,
    assistance: 'excluded',
  })
  expect(commitmentType.content_anchor).not.toBe(anchor)
})

test('keeping one field from Theorem saves only that, and can be undone', async () => {
  const commitmentType = server.state.types.find(
    (candidate) => candidate.object_type_id === FIXTURE_TYPE.commitment,
  )!
  const before = commitmentType.extensions?.['theorem.context'] as Record<
    string,
    unknown
  >
  const { container } = await commitments()
  await click(buttonNamed(container, 'Options')!)
  const due = () =>
    document.querySelector(
      '[role="menuitemcheckbox"][aria-label="Theorem may read Due"]',
    )
  const item = await waitFor(due)
  expect(item.getAttribute('aria-checked')).toBe('true')
  // The field a record is named by cannot be kept back on its own.
  expect(
    document
      .querySelector(
        '[role="menuitemcheckbox"][aria-label="Theorem may read Commitment"]',
      )
      ?.hasAttribute('data-disabled'),
  ).toBe(true)
  await click(item)
  await waitFor(() => due()?.getAttribute('aria-checked') === 'false')
  expect(commitmentType.extensions?.['theorem.context']).toEqual({
    ...before,
    excluded_fields: ['due'],
  })
  await waitFor(() => !due()?.hasAttribute('data-disabled'))
  await click(due()!)
  await waitFor(() => due()?.getAttribute('aria-checked') === 'true')
  expect(commitmentType.extensions?.['theorem.context']).toEqual({
    ...before,
    excluded_fields: [],
  })
})

// The preview

test('a row opens the preview: saved revision, private switch, and the ways on', async () => {
  const { container, search } = await commitments()
  await click(cell(container, 'Commitment'))
  const preview = await waitFor(() => container.querySelector('aside'))
  expect(preview.getAttribute('aria-label')).toBe(
    'Commitment: Send Noor the materials list',
  )
  expect(preview.textContent).toContain('Saved revision 9')
  expect(preview.textContent).toContain('Private to me')
  expect(buttonNamed(preview, 'Ask Theorem')).toBeDefined()
  expect(buttonNamed(preview, 'Delete')).toBeDefined()
  // "This is me" belongs to people only.
  expect(buttonNamed(preview, 'This is me')).toBeUndefined()
  await click(buttonNamed(preview, 'Open')!)
  await waitFor(
    () =>
      search().view === recordPageViewId('Commitment', 'commitment:materials'),
  )
})

test('the preview, the filter and the sort are in the address, and a table opened there shows them', async () => {
  const first = await view(tableAt('person'))
  await waitFor(() =>
    first.container.querySelector('[role="grid"] [data-r="1"]'),
  )
  await click(buttonNamed(first.container, 'Filter')!)
  const input = await waitFor(() =>
    first.container.querySelector<HTMLInputElement>(
      'input[aria-label^="Filter people"]',
    ),
  )
  await type(input, 'noo')
  await click(cell(first.container, 'Name'))
  await waitFor(() => first.container.querySelector('aside'))
  await waitFor(() => first.search().item !== undefined)
  expect(first.search()).toEqual({
    view: recordsViewId('person'),
    q: 'noo',
    item: itemOf('Person', 'person:noor'),
  })
  // Changing the view replaces the entry: it is still one place.
  expect(
    first.visited.every(
      (href) =>
        new URL(href, 'http://localhost').searchParams.get('view') ===
        recordsViewId('person'),
    ),
  ).toBe(true)
  await cleanup()

  // Reloaded, or come back to from the record's page.
  const again = await view(
    tableAt('person', {
      q: 'noo',
      item: itemOf('person', 'person:noor'),
      sort: 'name',
    }),
  )
  const preview = await waitFor(() => again.container.querySelector('aside'))
  expect(preview.getAttribute('aria-label')).toBe('Person: Noor')
  expect(
    again.container.querySelectorAll('[role="gridcell"][data-c="0"]'),
  ).toHaveLength(1)
  expect(
    again.container
      .querySelectorAll('[role="columnheader"]')
      [columns(again.container).indexOf('Name')]!.getAttribute('aria-sort'),
  ).toBe('ascending')
})

test('when the address drops the filter and the sort, so does the table', async () => {
  const { container, router, search } = await view(
    tableAt('person', { q: 'noo', sort: 'name', desc: true }),
  )
  const rows = () =>
    container.querySelectorAll('[role="gridcell"][data-c="0"]').length
  await waitFor(() => rows() === 1)
  // As the navigator does when the type that is already open is chosen again.
  await act(() =>
    router.navigate({
      to: '/index',
      search: { view: recordsViewId('person') },
    } as never),
  )
  await waitFor(() => rows() > 1)
  expect(search().q).toBeUndefined()
  expect(search().sort).toBeUndefined()
  expect(
    container
      .querySelectorAll('[role="columnheader"]')
      [columns(container).indexOf('Name')]!.getAttribute('aria-sort'),
  ).not.toBe('descending')
})

test('"Private to me" saves at the record\'s revision and marks the row', async () => {
  const { container } = await commitments()
  await click(cell(container, 'Commitment'))
  const preview = await waitFor(() => container.querySelector('aside'))
  await click(preview.querySelector('[role="switch"]')!)
  await waitFor(() => updates().length === 1)
  expect(updates()[0]!.input).toMatchObject({
    context_use: 'private',
    expected_revision: 9,
  })
  await waitFor(() => preview.textContent.includes('Saved revision 10'))
  expect(preview.textContent).toContain(
    'Theorem does not read or use this record',
  )
  // The lock on the row has words, not only a mark.
  await waitFor(() =>
    cell(container, 'Commitment').querySelector('[aria-label^="Private"]'),
  )
})

test('a person who is not you carries no "This is me"; who you are is chosen in Settings, Profile', async () => {
  serve({ self: 'unbound' })
  const { container } = await view(tableAt('person'))
  const noor = await waitFor(() =>
    [
      ...container.querySelectorAll<HTMLElement>(
        '[role="gridcell"][data-c="0"]',
      ),
    ].find((c) => c.textContent.includes('Noor')),
  )
  await click(noor)
  const preview = await waitFor(() => container.querySelector('aside'))
  expect(buttonNamed(preview, 'This is me')).toBeUndefined()
  expect(preview.textContent).not.toContain('This record is you')

  // In Settings, Profile: not set, then Noor is chosen.
  const settings = await mountAt('/settings/profile', () => <ProfileSettings />)
  await waitFor(() => settings.container.textContent.includes('Not set'))
  const trigger = await waitFor(() =>
    settings.container.querySelector<HTMLElement>(
      '[aria-label="Your person record"]',
    ),
  )
  await click(trigger)
  const option = await waitFor(() =>
    [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((o) =>
      o.textContent.includes('Noor'),
    ),
  )
  // The select ignores a release that comes straight after it opens.
  await act(() => new Promise((resolve) => setTimeout(resolve, 500)))
  await act(async () => {
    for (const kind of ['pointerdown', 'mousedown', 'pointerup', 'mouseup'])
      option.dispatchEvent(new MouseEvent(kind, { bubbles: true }))
    option.click()
  })
  await waitFor(() => server.state.self === 'person:noor')
  await waitFor(() =>
    settings.container.textContent.includes('Theorem reads “I” and “me”'),
  )
})

test('"Ask Theorem" puts the record in the next message, by id and type', async () => {
  const { container, visited } = await commitments()
  await click(cell(container, 'Commitment'))
  const preview = await waitFor(() => container.querySelector('aside'))
  await click(buttonNamed(preview, 'Ask Theorem')!)
  const [reference] = useComposerReferences.getState().references
  expect(reference).toMatchObject({
    label: 'Send Noor the materials list',
    location: {
      resource: {
        kind: 'record',
        objectId: 'commitment:materials',
        objectType: 'Commitment',
      },
    },
  })
  // The conversation opens. (This harness keeps the CRM mounted, so it then
  // goes back to its first type; the app's shell shows the conversation.)
  await waitFor(() => visited.includes('/'))
})

test('deleting asks first, and names the revision it deletes', async () => {
  const { container } = await commitments()
  await click(cell(container, 'Commitment'))
  const preview = await waitFor(() => container.querySelector('aside'))
  await click(buttonNamed(preview, 'Delete')!)
  const confirm = await waitFor(() =>
    buttonNamed(document.body, 'Delete commitment'),
  )
  expect(server.state.verbs.some((call) => call.verb === 'delete_one')).toBe(
    false,
  )
  await click(confirm)
  await waitFor(() =>
    server.state.verbs.some((call) => call.verb === 'delete_one'),
  )
  expect(
    server.state.verbs.find((call) => call.verb === 'delete_one')!.input,
  ).toMatchObject({
    id: 'commitment:materials',
    expected_revision: 9,
  })
  await waitFor(() => !container.querySelector('aside'))
  expect(container.querySelector('footer')!.textContent).toBe('0 commitments')
})

// The record page

test('a record page has its properties, its changes and what it is tied to', async () => {
  const { container } = await view(pageAt('commitment', 'commitment:materials'))
  await waitFor(() => container.textContent.includes('Saved revision 9'))
  const tabs = [...container.querySelectorAll('[role="tab"]')].map(
    (tab) => tab.textContent,
  )
  expect(tabs).toEqual(['Timeline', 'Related'])
  const timeline = await waitFor(() =>
    container.querySelector('ol[aria-label="Changes, newest first"]'),
  )
  expect(timeline.textContent).toContain(
    'You changed Due from Wednesday to Friday',
  )
  expect(timeline.textContent).toContain('revision 8 → 9')

  await click(container.querySelectorAll('[role="tab"]')[1]!)
  const related = await waitFor(() =>
    container.querySelector('section[aria-label="People, Owed to"]'),
  )
  expect(related.textContent).toContain('Noor')
})

test('a record page shows a note whole; the preview keeps it to its first line', async () => {
  const second = 'She will confirm the kiln booking on Monday.'
  const whole = await view(pageAt('interaction', 'interaction:planning'))
  const properties = await waitFor(() =>
    whole.container.querySelector('[role="list"][aria-label="Properties"]'),
  )
  expect(properties.textContent).toContain(
    'Noor asked for the materials list before she orders glaze.',
  )
  expect(properties.textContent).toContain(second)

  const table = await view(
    tableAt('interaction', {
      item: itemOf('interaction', 'interaction:planning'),
    }),
  )
  const preview = await waitFor(() =>
    table.container.querySelector(
      'aside [role="list"][aria-label="Properties"]',
    ),
  )
  expect(preview.textContent).toContain('Noor asked for the materials list')
  expect(preview.textContent).not.toContain(second)
})

test('a record that is not there says so', async () => {
  const { container } = await view(pageAt('commitment', 'commitment:gone'))
  await waitFor(() =>
    container.textContent.includes('This commitment is not here.'),
  )
})

// The panel

test('the panel lists the types in order, with counts, the current one marked, and you', async () => {
  const { container } = await mountAt(tableAt('commitment'), () => (
    <IndexRecords panel />
  ))
  await waitFor(
    () =>
      container.querySelector('nav button')?.textContent === 'Avery QuinnYou',
  )
  const rows = [...container.querySelectorAll('nav button')].map(
    (row) => row.textContent,
  )
  expect(rows[0]).toBe('Avery QuinnYou')
  expect(rows.slice(1, 9).map((row) => row.replace(/\d+$/, ''))).toEqual([
    'People',
    'Organizations',
    'Relationships',
    'Activities',
    'Commitments',
    'Interactions',
    'Goals',
    'Constraints',
  ])
  // The Index panel itself carries "Data model"; this section ends with the types.
  expect(rows).toHaveLength(9)
  await waitFor(() =>
    [...container.querySelectorAll('nav button')].some(
      (row) => row.textContent === 'People2',
    ),
  )
  const current = container.querySelector('nav [aria-current="page"]')!
  expect(current.textContent).toContain('Commitments')
})

test('with nobody marked as you, the panel says how to do it', async () => {
  serve({ self: 'unbound' })
  const { container } = await mountAt(tableAt('person'), () => (
    <IndexRecords panel />
  ))
  await waitFor(() =>
    container.textContent.includes('in Settings, under Profile'),
  )
})
