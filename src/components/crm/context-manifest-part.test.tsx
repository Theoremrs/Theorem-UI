// SOURCING: bun:test rendering the `context_manifest` part with React into happy-dom, from the fixture's part (./fixture), which has the server's shape
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import type { ComponentProps } from 'react'
import { cleanup, click, waitFor } from '../../../test/blocks/render'
import { ContextManifestPart } from './context-manifest-part'
import { createFixtureServer, fixtureFetch, fixtureManifestPart } from './fixture'
import { decodeManifestPart, manifestSummary } from './manifest'
import { mountAt } from './test-harness'

const page = (
  window as unknown as { happyDOM: { setURL: (url: string) => void } }
).happyDOM
beforeAll(() => page.setURL('http://localhost:3000/'))
afterAll(() => page.setURL('about:blank'))

const realFetch = window.fetch
beforeEach(() => {
  window.fetch = fixtureFetch(createFixtureServer())
})
afterEach(async () => {
  await cleanup()
  window.fetch = realFetch
})

type PartProps = ComponentProps<typeof ContextManifestPart>
const part = (data: unknown) =>
  mountAt('/', () => (
    <ContextManifestPart {...({ data, name: 'theorem-context_manifest' } as PartProps)} />
  ))

/** The payload as the page receives it: the part without its envelope. */
const payload = () => {
  const { manifest, delivery } = fixtureManifestPart()
  return { manifest, delivery }
}

async function opened(data: unknown) {
  const view = await part(data)
  await click(view.container.querySelector('button')!)
  await waitFor(() => view.container.textContent.includes('Used in this response'))
  // The types arrive from the schema register; labels follow.
  await waitFor(() => view.container.textContent.includes('Held back: Email'))
  return view
}

test('closed, it says how many saved records were used and how many were held back', async () => {
  const { container } = await part(payload())
  const trigger = container.querySelector('button')!
  expect(trigger.textContent).toContain('Used 5 saved records · 1 held back')
  expect(trigger.getAttribute('aria-expanded')).toBe('false')
  expect(container.textContent).not.toContain('Send Noor the materials list')
})

test('open, each record is named with its type, its saved revision and why it was used', async () => {
  const { container } = await opened(payload())
  const rows = [...container.querySelectorAll('ul[aria-label="Saved records used"] > li')].map(
    (row) => row.textContent,
  )
  expect(rows).toHaveLength(5)
  expect(rows[0]).toContain('Avery Quinn · Person · revision 3')
  expect(rows[0]).toContain('This is you')
  expect(rows[0]).toContain('Held back: Email')
  expect(rows[1]).toContain('Noor · Person · revision 4')
  expect(rows[1]).toContain('Your message says “Noor”')
  expect(rows[2]).toContain('Send Noor the materials list · Commitment · revision 9')
  expect(rows[2]).toContain('Its owed to is Noor')
  expect(rows[2]).toContain('Given with the value it replaced: Due')
  expect(rows[3]).toContain('Shortened to fit: Description')
  expect(rows[4]).toContain('It always applies to you (applies to)')
  expect(container.textContent).toContain(
    'about 310 tokens — estimate: serialized characters / 4',
  )
})

test('a used record links to its page in the CRM', async () => {
  const { container } = await opened(payload())
  const link = [...container.querySelectorAll('a')].find(
    (a) => a.textContent === 'Send Noor the materials list',
  )!
  expect(decodeURIComponent(link.getAttribute('href')!)).toBe(
    '/crm/commitments/commitment:materials',
  )
})

test('a held-back record is named by its type and the reason, never by a value', async () => {
  const data = payload()
  // Whatever else arrives on a held-back entry is not shown.
  Object.assign(data.manifest.withheld[0]!, {
    label: 'Planning call with Noor',
    summary: 'We talked about the kiln budget',
  })
  const { container } = await opened(data)
  const held = container.querySelector('section[aria-label="Held back"]')!
  expect(held.textContent).toContain('An interaction: it is private to you.')
  expect(container.textContent).not.toContain('Planning call')
  expect(container.textContent).not.toContain('kiln budget')
  expect(container.textContent).not.toContain('record_private')
})

test('names that match several records, records left out and what could not be read are said', async () => {
  const data = payload()
  Object.assign(data.manifest, {
    included: [],
    withheld: [],
    ambiguous: [{ phrase: 'Sam', record_ids: ['person:sam-1', 'person:sam-2'] }],
    over_budget: 2,
    degraded: ['scan_limited:Person', 'time_limit', 'something_new'],
    you: { state: 'unbound' },
  })
  const view = await part(data)
  expect(view.container.querySelector('button')!.textContent).toContain(
    'Used no saved records · 2 left out for length',
  )
  expect(view.container.querySelector('button')!.textContent).toContain('Incomplete')
  await click(view.container.querySelector('button')!)
  const text = await waitFor(
    () => view.container.textContent.includes('Used in this response') && view.container.textContent,
  )
  expect(text).toContain('“Sam” matches 2 saved records')
  expect(text).toContain('2 more records bear on this and were left out')
  expect(text).toContain('Only some Person records were looked through')
  expect(text).toContain('took too long and stopped early')
  expect(text).toContain('Saved records were not read completely for this reply.')
  expect(text).not.toContain('scan_limited')
  expect(text).not.toContain('something_new')
  // No tokens were sent for records, so no figure is claimed.
  expect(text).not.toContain('tokens')
})

test('the manifest is read at the top of the payload, or nested under payload', () => {
  const data = payload()
  expect(manifestSummary(decodeManifestPart(data)!)).toBe('Used 5 saved records · 1 held back')
  expect(decodeManifestPart({ payload: data })?.included).toHaveLength(5)
  expect(decodeManifestPart(fixtureManifestPart())?.estimatedTokens).toBe(310)
})

test('a part that is not this manifest, or says nothing, draws nothing', async () => {
  expect(decodeManifestPart({ manifest: { schema: 'something.else' } })).toBeUndefined()
  expect(decodeManifestPart(null)).toBeUndefined()
  const nothing = payload()
  Object.assign(nothing.manifest, { included: [], withheld: [] })
  const { container } = await part(nothing)
  expect(container.querySelector('button')).toBeNull()
})

test('a record with no saved revision is not listed as used', () => {
  const data = payload()
  delete (data.manifest.included[0] as { revision?: number }).revision
  const manifest = decodeManifestPart(data)!
  expect(manifest.included.map((record) => record.label)).not.toContain('Avery Quinn')
  expect(manifestSummary(manifest)).toBe('Used 4 saved records · 1 held back')
})
