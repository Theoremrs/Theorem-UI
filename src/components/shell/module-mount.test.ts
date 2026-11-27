// SOURCING: bun:test over moduleComponentOf: a contribution with no component
// code mounts through the module runtime only when it names a module.
import { expect, test } from 'bun:test'
import { moduleComponentOf } from './module-mount'

test('only a contribution naming a module gets a mounting component', () => {
  expect(moduleComponentOf({ label: 'x' })).toBeUndefined()
  expect(
    moduleComponentOf({ label: 'x', meta: { moduleId: 3 } }),
  ).toBeUndefined()
  expect(
    typeof moduleComponentOf({ label: 'x', meta: { moduleId: 'acme.crm' } }),
  ).toBe('function')
})
