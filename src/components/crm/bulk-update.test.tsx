// SOURCING: bun:test rendering the CRM table with React into happy-dom, inside a router that knows the CRM's places (./test-harness). window.fetch is the in-memory fixture (./fixture), which answers each record verb as the server does, as no Theorem is running
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
import { CrmView } from './crm-view'
import { createFixtureServer, fixtureFetch } from './fixture'
import type { FixtureServer } from './fixture'
import { resetCrmWrites } from './queries'
import { mountAt } from './test-harness'

const page = (
  window as unknown as { happyDOM: { setURL: (url: string) => void } }
).happyDOM
beforeAll(() => page.setURL('http://localhost:3000/'))
afterAll(() => page.setURL('about:blank'))

let server: FixtureServer
const realFetch = window.fetch
beforeEach(() => {
  resetCrmWrites()
  server = createFixtureServer()
  window.fetch = fixtureFetch(server)
})
afterEach(async () => {
  await cleanup()
  window.fetch = realFetch
})

const settle = () =>
  act(() => new Promise((resolve) => setTimeout(resolve, 15)))
const key = (element: Element, which: string) =>
  act(async () => {
    element.dispatchEvent(
      new KeyboardEvent('keydown', { key: which, bubbles: true }),
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
const saved = (id: string) => server.state.nodes.find((node) => node.id === id)!

const people = async () => {
  const mounted = await mountAt('/crm/people', () => <CrmView />)
  await waitFor(() =>
    mounted.container.querySelector('[role="grid"] [data-r="1"]'),
  )
  return mounted
}
const mark = (container: HTMLElement, name: string) =>
  click(container.querySelector(`[aria-label="Select ${name}"]`)!)
/** The panel, once it is open. */
const panel = (container: HTMLElement) =>
  waitFor(() =>
    container.querySelector<HTMLElement>('[data-crm-region="bulk-update"]'),
  )
const labelled = (within: Element, label: string) =>
  within.querySelector<HTMLElement>(`[aria-label="${label}"]`)
/** Opens the panel on the marked rows and gives Location a value. */
async function setLocation(container: HTMLElement, place: string) {
  await click(buttonNamed(container, 'Update')!)
  const aside = await panel(container)
  await click(labelled(aside, 'Set Location')!)
  const input = await waitFor(() => aside.querySelector('input'))
  await type(input, place)
  await key(input, 'Enter')
  return aside
}

test('marking rows writes nothing, and the panel names how many it will change', async () => {
  const { container } = await people()
  await mark(container, 'Avery Quinn')
  await mark(container, 'Noor')
  await click(buttonNamed(container, 'Update')!)
  const aside = await panel(container)

  expect(aside.getAttribute('aria-label')).toBe('Update 2 people')
  // The table is still there, with its rows still marked.
  expect(
    container.querySelectorAll('[role="row"][aria-selected="true"]').length,
  ).toBe(2)
  // Nothing to apply until a field is given a value.
  expect(buttonNamed(aside, 'Apply')!.hasAttribute('disabled')).toBe(true)
  expect(labelled(aside, 'Set Name')).toBeNull()
  expect(server.state.verbs.some((call) => call.verb !== 'find_many')).toBe(
    false,
  )

  // Cancel closes it; nothing was sent and the marks stay.
  await click(buttonNamed(aside, 'Cancel')!)
  await waitFor(
    () => !container.querySelector('[data-crm-region="bulk-update"]'),
  )
  expect(updates().length).toBe(0)
  expect(
    container.querySelectorAll('[role="row"][aria-selected="true"]').length,
  ).toBe(2)
})

test('Apply writes once to each record that differs, at the revision read, and reports each', async () => {
  const { container } = await people()
  await mark(container, 'Avery Quinn')
  await mark(container, 'Noor')
  // Avery is already in Portland; Noor has no location.
  const aside = await setLocation(container, 'Portland')
  await waitFor(() => aside.textContent.includes('Changes 1 of 2'))
  expect(updates().length).toBe(0)

  await click(buttonNamed(aside, 'Apply')!)
  await waitFor(() => aside.getAttribute('aria-label') === 'Update finished')
  expect(updates().map((call) => call.input)).toEqual([
    { id: 'person:noor', location: 'Portland', expected_revision: 4 },
  ])
  expect(saved('person:noor').properties.location).toBe('Portland')
  expect(aside.textContent).toContain('1 updated, 1 already had these values.')
  const results = [...aside.querySelectorAll('li')].map(
    (item) => item.textContent,
  )
  expect(results).toEqual([
    'Avery QuinnNo change needed',
    'NoorUpdated · revision 4 to 5',
  ])

  // Done: nothing was refused, so nothing stays marked.
  await click(buttonNamed(aside, 'Done')!)
  await waitFor(
    () => !container.querySelector('[data-crm-region="bulk-update"]'),
  )
  expect(
    container.querySelectorAll('[role="row"][aria-selected="true"]').length,
  ).toBe(0)
})

test('a record that changed elsewhere is left alone and said so; the rest are updated', async () => {
  const { container } = await people()
  await mark(container, 'Avery Quinn')
  await mark(container, 'Noor')
  server.changeElsewhere('person:noor', { phone: '555-0199' })
  const aside = await setLocation(container, 'Lisbon')
  await click(buttonNamed(aside, 'Apply')!)
  await waitFor(() => aside.getAttribute('aria-label') === 'Update finished')

  expect(saved('person:avery').properties.location).toBe('Lisbon')
  expect(saved('person:noor').properties.location).toBeUndefined()
  expect(saved('person:noor').properties.phone).toBe('555-0199')
  const report = aside.querySelector('[role="alert"]')!
  expect(report.textContent).toBe('1 updated, 1 not updated.')
  // The refused record comes first, with the reason.
  const first = aside.querySelector('li')!
  expect(first.textContent).toContain('Noor')
  expect(first.textContent).toContain('Not updated')
  expect(first.textContent).toContain('changed since')

  // Reading it again leaves only that record marked, with the value kept.
  await click(buttonNamed(aside, 'Read again')!)
  await waitFor(() => aside.getAttribute('aria-label') === 'Update 1 person')
  const marked = container.querySelectorAll(
    '[role="row"][aria-selected="true"]',
  )
  expect(marked.length).toBe(1)
  expect(marked[0]!.textContent).toContain('Noor')
  await waitFor(() => aside.textContent.includes('Changes 1 of 1'))
  await click(buttonNamed(aside, 'Apply')!)
  await waitFor(() => aside.getAttribute('aria-label') === 'Update finished')
  expect(saved('person:noor').properties).toMatchObject({
    location: 'Lisbon',
    phone: '555-0199',
  })
  expect(updates().at(-1)!.input).toEqual({
    id: 'person:noor',
    location: 'Lisbon',
    expected_revision: 5,
  })
})

test('a row marked after Apply is pressed is not part of that update', async () => {
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

  const { container } = await people()
  await mark(container, 'Avery Quinn')
  const aside = await setLocation(container, 'Lisbon')
  await click(buttonNamed(aside, 'Apply')!)
  await waitFor(() => aside.textContent.includes('Updating 1 of 1'))
  await mark(container, 'Noor')
  await act(async () => release())
  await settle()
  await waitFor(() => aside.getAttribute('aria-label') === 'Update finished')

  expect(updates().map((call) => call.input.id)).toEqual(['person:avery'])
  expect(aside.querySelectorAll('li').length).toBe(1)
  expect(saved('person:noor').properties.location).toBeUndefined()
})
