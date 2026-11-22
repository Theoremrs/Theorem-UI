// SOURCING: bun:test rendering the Index panel's records part and Settings' Profile with React into happy-dom, in the router the CRM harness builds (./test-harness). window.fetch is the in-memory CRM fixture (./fixture), wrapped to count record downloads and to refuse reads on demand, as no Theorem is running. Synthetic records only
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from 'bun:test'
import {
  buttonNamed,
  cleanup,
  click,
  waitFor,
} from '../../../test/blocks/render'
import { createFixtureServer, fixtureFetch } from './fixture'
import { ProfileSettings } from './profile-settings'
import { RecordsSection } from './crm-panel'
import { resetCrmWrites } from './queries'
import { mountAt } from './test-harness'

const page = (
  window as unknown as { happyDOM: { setURL: (url: string) => void } }
).happyDOM
beforeAll(() => page.setURL('http://localhost:3000/'))
afterAll(() => page.setURL('about:blank'))

const realFetch = window.fetch
let recordReads: number
/** GraphQL operations (by a word in the query) that answer with an error. */
let refused: Set<string>
let peopleRefused: boolean

beforeEach(() => {
  resetCrmWrites()
  recordReads = 0
  refused = new Set()
  peopleRefused = false
  const crm = fixtureFetch(createFixtureServer())
  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = String(
      input instanceof Request
        ? await input.clone().text()
        : (init?.body ?? ''),
    )
    if (body.includes('find_many')) {
      recordReads += 1
      if (peopleRefused)
        return Response.json({ errors: [{ message: 'unavailable' }] })
    }
    for (const word of refused)
      if (body.includes(word))
        return Response.json({ errors: [{ message: 'unavailable' }] })
    return crm(input, init)
  }) as typeof fetch
})
afterEach(async () => {
  await cleanup()
  window.fetch = realFetch
})

test('the Index panel lists the types without downloading any record', async () => {
  const { container } = await mountAt('/index', () => (
    <nav>
      <RecordsSection />
    </nav>
  ))
  await waitFor(() => container.textContent.includes('People'))
  // Give any stray read time to start.
  await new Promise((resolve) => setTimeout(resolve, 50))
  expect(recordReads).toBe(0)
})

test('the panel says when the data model could not be read, and reads it again on request', async () => {
  refused.add('dataModel')
  const { container } = await mountAt('/index', () => (
    <nav>
      <RecordsSection />
    </nav>
  ))
  const alert = await waitFor(
    () => container.querySelector('[role="alert"]'),
    5000,
  )
  expect(alert.textContent).toContain('could not be read')
  expect(container.textContent).not.toContain('Loading')
  refused.delete('dataModel')
  await click(buttonNamed(alert, 'Try again')!)
  await waitFor(() => container.textContent.includes('People'), 5000)
  expect(container.querySelector('[role="alert"]')).toBeNull()
})

test('Profile says when the data model could not be read, and reads it again on request', async () => {
  refused.add('dataModel')
  const { container } = await mountAt('/settings/profile', () => (
    <ProfileSettings />
  ))
  const alert = await waitFor(
    () => container.querySelector('[role="alert"]'),
    5000,
  )
  expect(alert.textContent).toContain('could not be read')
  expect(container.textContent).not.toContain('Loading')
  refused.delete('dataModel')
  await click(buttonNamed(container, 'Try again')!)
  await waitFor(
    () =>
      container.textContent.includes('Theorem reads') ||
      container.textContent.includes('Not set'),
    5000,
  )
})

test('Profile does not tell a person to add themselves when the People read failed', async () => {
  peopleRefused = true
  const { container } = await mountAt('/settings/profile', () => (
    <ProfileSettings />
  ))
  const alert = await waitFor(
    () => container.querySelector('[role="alert"]'),
    5000,
  )
  expect(alert.textContent).toContain('could not be read')
  expect(container.textContent).not.toContain('Add yourself')
  peopleRefused = false
  await click(buttonNamed(container, 'Try again')!)
  await waitFor(
    () =>
      container.textContent.includes('Theorem reads') ||
      container.textContent.includes('Not set'),
    5000,
  )
})
