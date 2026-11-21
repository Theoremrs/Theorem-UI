// SOURCING: bun:test over the CRM's reading of a built-in Commitment's `task` and `draft` fields and the add row's words, and React into happy-dom inside the Index's test router (./test-harness) for the link a field draws
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { cleanup, waitFor } from '../../../test/blocks/render'
import type { FieldSpec, ObjectType } from '@/components/records/contract'
import { decodeLifeContext } from './api'
import { CrmFieldValue } from './cells'
import { addMissingWords } from './crm-panel'
import { fixtureTypes } from './fixture'
import { madeKind } from './made-links'
import { indexAt, mountAt } from './test-harness'

const page = (
  window as unknown as { happyDOM: { setURL: (url: string) => void } }
).happyDOM
beforeAll(() => page.setURL('http://localhost:3000/'))
afterAll(() => page.setURL('about:blank'))
afterEach(() => cleanup())

const text = (key: string): FieldSpec => ({
  key,
  label: key,
  field_type: { kind: 'text' },
  required: false,
  system: false,
  span: false,
  facet: false,
})
const commitment = (): ObjectType => {
  const type = fixtureTypes().find((t) => t.name_singular === 'Commitment')!
  return { ...type, fields: [...type.fields, text('task'), text('draft')] }
}

test("a built-in Commitment's task and draft name what Theorem made", () => {
  const type = commitment()
  expect(madeKind(type, text('task'))).toBe('task')
  expect(madeKind(type, text('draft'))).toBe('draft')
  expect(madeKind(type, text('due'))).toBeUndefined()
  // A Commitment someone declared by hand keeps plain text.
  const own = { ...type, extensions: {} }
  expect(madeKind(own, text('task'))).toBeUndefined()
  const person = fixtureTypes().find((t) => t.name_singular === 'Person')!
  expect(madeKind(person, text('task'))).toBeUndefined()
})

test('a commitment shows its task as a link to the work item, not its id', async () => {
  const type = commitment()
  const record = {
    id: 'commitment:materials',
    version: 9,
    labels: ['Commitment'],
    values: { task: 'wi_42' },
    relations: {},
  }
  const { container } = await mountAt(indexAt({}), () => (
    <CrmFieldValue
      type={type}
      record={record}
      field={text('task')}
      value="wi_42"
    />
  ))
  const link = await waitFor(() => container.querySelector('a'))
  expect(link.textContent).toBe('Open the task')
  expect(decodeURIComponent(link.getAttribute('href')!)).toContain(
    'item=work:wi_42',
  )
  expect(container.textContent).not.toContain('wi_42')
})

test('the add row names what it adds', () => {
  expect(addMissingWords(['Relationship'], [])).toBe(
    'Add the Relationship type',
  )
  expect(addMissingWords(['Goal', 'Constraint'], [])).toBe(
    'Add 2 new record types',
  )
  const outdated = { nameSingular: 'Commitment', missingFields: ['task'] }
  expect(addMissingWords([], [outdated])).toBe('Add new fields to Commitment')
  expect(
    addMissingWords([], [outdated, { ...outdated, nameSingular: 'Goal' }]),
  ).toBe('Add new fields to 2 record types')
  expect(addMissingWords(['Relationship'], [outdated])).toBe(
    'Update the record types',
  )
})

test('the status reads which installed types lack fields', () => {
  const life = decodeLifeContext({
    installed: true,
    types: [
      { name_singular: 'Person', declared: true, missing_fields: [] },
      {
        name_singular: 'Commitment',
        declared: true,
        missing_fields: ['task', 'draft', 7],
      },
      { name_singular: 'Goal', declared: false },
    ],
  })
  expect(life.outdated).toEqual([
    { nameSingular: 'Commitment', missingFields: ['task', 'draft'] },
  ])
  expect(life.missing).toEqual(['Goal'])
})
