// SOURCING: bun:test driving runBulkUpdate with the real write queue (useCrmWrites) inside a React tree in happy-dom; window.fetch is the in-memory fixture (./fixture) with its update verb held, to make an inline save and a bulk update overlap
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from 'bun:test'
import { act, useEffect } from 'react'
import { cleanup, waitFor } from '../../../test/blocks/render'
import { findRecords } from './api'
import { runBulkUpdate } from './bulk-update'
import { createFixtureServer, fixtureFetch, fixtureTypes } from './fixture'
import type { FixtureServer } from './fixture'
import { resetCrmWrites, useCrmWrites } from './queries'
import type { CrmWrites } from './queries'
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

const person = fixtureTypes().find((t) => t.name_singular === 'Person')!
const location = person.fields.find((f) => f.key === 'location')!
const saved = (id: string) => server.state.nodes.find((n) => n.id === id)!

let writes: CrmWrites
function Probe() {
  const current = useCrmWrites(person)
  useEffect(() => {
    writes = current
  })
  return null
}
const settle = () =>
  act(() => new Promise((resolve) => setTimeout(resolve, 15)))

/** Hold the update whose body mentions `who` until released. */
function holdUpdateOf(who: string) {
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
    if (body.includes('update_one') && body.includes(who)) await held
    return answered(...args)
  }) as typeof fetch
  return () => act(async () => release())
}

test('a bulk value that matches the cache is still written when an inline save is about to change it', async () => {
  await mountAt('/', () => <Probe />)
  const { records } = await findRecords(person.object_type_id)
  const avery = records.find((r) => r.id === 'person:avery')!
  expect(avery.values.location).toBe('Portland')
  const release = holdUpdateOf('person:avery')

  // Portland to Lisbon is still saving when Portland is asked for.
  const inline = writes.save(avery, location, 'Lisbon')
  await settle()
  const bulk = runBulkUpdate(
    person,
    [avery],
    { location: 'Portland' },
    writes.patchWhere,
  )
  await settle()
  await release()
  const [outcome] = await bulk
  await inline

  expect(outcome!.result).toBe('updated')
  expect(saved('person:avery').properties.location).toBe('Portland')
})

test('an inline save made after Apply is not written over by the bulk value', async () => {
  await mountAt('/', () => <Probe />)
  const { records } = await findRecords(person.object_type_id)
  const avery = records.find((r) => r.id === 'person:avery')!
  const noor = records.find((r) => r.id === 'person:noor')!
  const release = holdUpdateOf('person:avery')

  const bulk = runBulkUpdate(
    person,
    [avery, noor],
    { location: 'Lisbon' },
    writes.patchWhere,
  )
  // Avery's write is slow; meanwhile Noor is edited in the table.
  await settle()
  const inline = writes.save(noor, location, 'Berlin')
  await settle()
  await release()
  await waitFor(async () => (await Promise.race([bulk, null])) !== null)
  await bulk
  await inline

  expect(saved('person:avery').properties.location).toBe('Lisbon')
  expect(saved('person:noor').properties.location).toBe('Berlin')
})
