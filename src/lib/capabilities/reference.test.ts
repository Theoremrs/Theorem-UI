// SOURCING: bun:test over capabilityContextReference, the envelope a capability module hands the
// composer. The cases that reach it through the page modules are in
// components/pages/capability-modules.test.ts; these pin the selection cap at its edge.
import { expect, test } from 'bun:test'
import { ENVELOPE_SELECTED_MAX, capabilityContextReference } from './reference'

const envelope = {
  instanceId: 'tracker/main',
  collectionKey: 'tasks',
  purpose: 'Track tasks',
  label: 'Project tracker · Next',
  filtered: false,
  truncated: false,
}

const records = (count: number) =>
  Array.from({ length: count }, (_, at) => ({ id: `rec-${at}`, revision: at }))

test('a selection is carried from its first record, and only more than the cap is a cut', () => {
  const full = capabilityContextReference({
    ...envelope,
    selected: records(ENVELOPE_SELECTED_MAX),
  }).location.resource
  expect(full.selected).toEqual(records(ENVELOPE_SELECTED_MAX))
  expect(full.truncated).toBe(false)

  const over = capabilityContextReference({
    ...envelope,
    selected: records(ENVELOPE_SELECTED_MAX + 1),
  }).location.resource
  expect(over.selected).toEqual(records(ENVELOPE_SELECTED_MAX))
  expect(over.truncated).toBe(true)
})

test('rows the view already cut short stay a cut, however few are selected', () => {
  const { resource } = capabilityContextReference({
    ...envelope,
    truncated: true,
    selected: records(2),
  }).location
  expect(resource.selected).toEqual(records(2))
  expect(resource.truncated).toBe(true)
})
