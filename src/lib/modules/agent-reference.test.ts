// SOURCING: bun:test over componentContextReference, as module-agent.tsx calls it with a module's
// summary output: a value that is not text crosses as JSON, and one longer than the envelope carries
// is cut and says so, so a turn's context stays bounded whatever a module publishes.
import { expect, test } from 'bun:test'
import {
  ENVELOPE_SUMMARY_MAX,
  componentContextReference,
} from './agent-reference'

const envelope = {
  moduleId: 'vault.focus',
  selectedComponentId: 'focus-1',
  label: 'Focus',
  description: 'Shows open tasks that fit the minutes you have.',
  instances: ['tracker/main'],
}

test('a summary that is not text crosses as JSON, and none is left out', () => {
  const counted = componentContextReference({
    ...envelope,
    summary: { fits: 2 },
  })
  expect(counted.location.resource.summary).toBe('{"fits":2}')
  expect(counted.location.resource.summaryTruncated).toBeUndefined()
  const none = componentContextReference(envelope)
  expect('summary' in none.location.resource).toBe(false)
  expect('pageId' in none.location.resource).toBe(false)
})

test('a summary longer than the envelope carries is cut, and the envelope says so', () => {
  const long = 'x'.repeat(ENVELOPE_SUMMARY_MAX + 5)
  const { resource } = componentContextReference({
    ...envelope,
    pageId: 'Desk',
    summary: long,
  }).location
  expect(resource.summary).toHaveLength(ENVELOPE_SUMMARY_MAX)
  expect(resource.summaryTruncated).toBe(true)
  expect(resource.pageId).toBe('Desk')
})
