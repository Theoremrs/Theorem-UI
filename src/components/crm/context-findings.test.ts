// SOURCING: bun:test over the CRM's context policy reader (./model), the context manifest summary (./manifest) and the bounded record search (./api) against the in-memory fixture (./fixture), as no Theorem is running
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { SEARCH_LIMIT, searchRecords, searchSpellings } from './api'
import {
  FIXTURE_TYPE,
  createFixtureServer,
  fixtureFetch,
  fixtureTypes,
} from './fixture'
import type { FixtureServer } from './fixture'
import { decodeManifestPart, manifestSummary } from './manifest'
import { contextPolicy } from './model'

const types = fixtureTypes()

test('a Relationship type with a tie in its context setting is used in answers', () => {
  const relationship = types.find(
    (type) => type.object_type_id === FIXTURE_TYPE.relationship,
  )!
  const reading = contextPolicy(relationship)
  expect(reading.state).toBe('available')
  expect(reading.policy?.tie).toEqual({
    from: ['from_person', 'from_organization'],
    to: ['to_person', 'to_organization'],
    relation: 'relation',
  })
  const policy = (tie: unknown) =>
    contextPolicy({
      extensions: {
        'theorem.context': { version: 1, assistance: 'available', tie },
      },
    }).state
  // A tie the server could not read is held back, never guessed at.
  expect(policy({ from: ['a'], to: ['b'] })).toBe('unreadable')
  expect(policy({ from: 'a', to: ['b'], relation: 'r' })).toBe('unreadable')
  expect(policy({ from: ['a'], to: ['b'], relation: 'r', more: 1 })).toBe(
    'unreadable',
  )
  expect(policy('tie')).toBe('unreadable')
})

const summary = (manifest: Record<string, unknown>) => {
  const part = {
    manifest: {
      schema: 'theorem.life_context_manifest.v1',
      included: [],
      withheld: [],
      ...manifest,
    },
    lookUp: { names: ['Nobody'] },
  }
  return manifestSummary(decodeManifestPart(part)!)
}

test('a look-up that supplied nothing says "found none" only when nothing was kept out or failed', () => {
  expect(summary({})).toBe('Looked up saved records and found none')
  const held = summary({
    withheld: [{ record_id: 'interaction:private', reason: 'private' }],
  })
  expect(held).not.toContain('found none')
  expect(held).toContain('none were supplied')
  expect(held).toContain('1 held back')
  const over = summary({ over_budget: 3 })
  expect(over).not.toContain('found none')
  expect(over).toContain('3 left out for length')
  const failed = summary({ degraded: ['read_failed'] })
  expect(failed).not.toContain('found none')
  expect(failed).toContain('could not all be read')
})

test('the spellings a case-sensitive search tries', () => {
  expect(searchSpellings('noor had')).toEqual([
    'noor had',
    'Noor Had',
    'Noor had',
  ])
  expect(searchSpellings('Noor')).toEqual(['Noor', 'noor'])
  // Typed in capitals, the lowercase and capitalised spellings are tried too.
  expect(searchSpellings('NOOR')).toEqual(['NOOR', 'noor', 'Noor'])
})

let server: FixtureServer
const realFetch = window.fetch
beforeEach(() => {
  server = createFixtureServer()
  window.fetch = fixtureFetch(server)
  ;(
    window as unknown as { happyDOM: { setURL: (url: string) => void } }
  ).happyDOM.setURL('http://localhost:3000/')
})
afterEach(() => {
  window.fetch = realFetch
})

test('a record search reads a bounded page filtered on the title, never every page', async () => {
  const found = await searchRecords(FIXTURE_TYPE.person, 'name', ' noo ')
  expect(found.length).toBeGreaterThan(0)
  const reads = server.state.verbs.filter((v) => v.verb === 'find_many')
  expect(reads.length).toBeGreaterThan(0)
  for (const read of reads) {
    expect(read.input.limit).toBe(SEARCH_LIMIT)
    expect(read.input.offset).toBeUndefined()
    expect(read.input.filters).toEqual([
      {
        field_key: 'name',
        operator: 'contains',
        value: expect.stringMatching(/^[Nn]oo$/),
      },
    ])
  }
  // Each spelling is one read; an empty query is one unfiltered bounded page.
  expect(
    reads.map((r) => (r.input.filters as { value: string }[])[0]!.value),
  ).toEqual(searchSpellings('noo'))
  server.state.verbs.length = 0
  await searchRecords(FIXTURE_TYPE.person, 'name', '', 5)
  expect(server.state.verbs.map((v) => v.input)).toEqual([{ limit: 5 }])
})

test('a search typed in capitals finds the record a lowercase one does', async () => {
  const names = (records: { values: Record<string, unknown> }[]) =>
    records.map((r) => r.values.name).sort()
  const lower = await searchRecords(FIXTURE_TYPE.person, 'name', 'noor')
  expect(names(lower)).toContain('Noor')
  // The fixture filters by exact case, so every record found names Noor.
  for (const name of names(lower)) expect(String(name)).toContain('Noor')
  const upper = await searchRecords(FIXTURE_TYPE.person, 'name', 'NOOR')
  expect(names(upper)).toEqual(names(lower))
  // Typed as it is stored, only that spelling and its lowercase are tried.
  const exact = await searchRecords(FIXTURE_TYPE.person, 'name', 'Noor')
  expect(names(exact)).toEqual(names(lower))
})
