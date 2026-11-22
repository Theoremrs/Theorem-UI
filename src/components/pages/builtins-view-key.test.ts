// SOURCING: none — tests of the saved-arrangement key a records module gives its table
import { expect, test } from 'bun:test'
import { moduleViewKey } from './builtins'

test('pages made from one template do not share a table arrangement', () => {
  expect(moduleViewKey('page-a', 'records')).not.toBe(
    moduleViewKey('page-b', 'records'),
  )
  expect(moduleViewKey('page-a', 'records')).toBe('module:page-a:records')
})

test('outside a page the key is the module path, as before', () => {
  expect(moduleViewKey(undefined, 'records')).toBe('module:records')
})
