// SOURCING: none — tests of which drawn values change where they are
import { expect, test } from 'bun:test'
import type { FieldSpec, ObjectType } from '@/components/records/contract'
import { withDisplayHint } from '@/components/records/model'
import { changesInPlace } from './cells'

const field = (key: string, kind: string, system = false) =>
  ({
    key,
    label: key,
    field_type: { kind },
    required: false,
    system,
  }) as unknown as FieldSpec

const plain = { extensions: {} } as unknown as ObjectType
const rated = {
  extensions: withDisplayHint(plain, 'score', { display: 'rating', max: 5 }),
} as unknown as ObjectType

// Review found that a number drawn as stars no longer took a click: only a
// yes or no was given the handler.
test('a rating changes in place, as a yes or no does', () => {
  expect(changesInPlace(plain, field('done', 'boolean'))).toBe(true)
  expect(changesInPlace(rated, field('score', 'integer'))).toBe(true)
  expect(changesInPlace(plain, field('score', 'integer'))).toBe(false)
  expect(changesInPlace(rated, field('score', 'integer', true))).toBe(false)
})
