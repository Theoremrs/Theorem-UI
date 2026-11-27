// SOURCING: bun:test over safe mode and the host's view of the contribution
// registry: with it on, installed contributions, an installed shell and the
// person's preferences are not seen, so the shipped chrome serves.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import {
  registerContribution,
  useHandlerPreferences,
} from '@/lib/contributions/registry'
import { registerBuiltinChrome } from '@/components/shell/builtin-chrome'
import {
  hostContributionsOf,
  hostResolveHandler,
  navEntries,
  selectedShell,
} from './host-registry'
import {
  admitsSource,
  isSafeMode,
  leaveSafeMode,
  useSafeMode,
  userExtensionsEnabled,
  wantsSafeMode,
} from './safe-mode'

const removes: Array<() => void> = []
const add = (...args: Parameters<typeof registerContribution>) =>
  removes.push(registerContribution(...args))

beforeEach(() => {
  // Other test files empty the shared registry; put the shipped chrome back.
  registerBuiltinChrome()
  useSafeMode.setState({ active: false, via: null })
  useHandlerPreferences.getState().resetAll()
})
afterEach(() => {
  while (removes.length) removes.pop()!()
  leaveSafeMode()
})

const extension = { kind: 'extension', extensionId: 'acme' } as const

test('the query flag asks for safe mode', () => {
  expect(wantsSafeMode('?safe=1')).toBe(true)
  expect(wantsSafeMode('?safe=0')).toBe(false)
  expect(wantsSafeMode('')).toBe(false)
})

test('safe mode admits the host and refuses every other source', () => {
  expect(admitsSource(extension, false)).toBe(true)
  expect(admitsSource(extension, true)).toBe(false)
  expect(admitsSource({ kind: 'module', moduleId: 'acme' }, true)).toBe(false)
  expect(admitsSource({ kind: 'builtin' }, true)).toBe(true)
  useSafeMode.getState().enter('manual')
  expect(isSafeMode()).toBe(true)
  expect(userExtensionsEnabled()).toBe(false)
})

test('safe mode leaves extension navigation, shells and handlers out', () => {
  add(
    {
      kind: 'nav-entry',
      id: 'acme.nav.crm',
      label: 'CRM',
      meta: { to: '/crm' },
    },
    extension,
  )
  add({ kind: 'shell', id: 'acme.shell.compact', label: 'Compact' }, extension)
  add(
    {
      kind: 'open-handler',
      id: 'acme.open.csv',
      label: 'CSV',
      serves: ['file:csv'],
    },
    extension,
  )
  add({
    kind: 'open-handler',
    id: 'theorem.open.csv',
    label: 'Table',
    serves: ['file:csv'],
  })
  useHandlerPreferences.getState().selectShell('acme.shell.compact')
  useHandlerPreferences
    .getState()
    .prefer('byServes', 'file:csv', 'acme.open.csv')

  expect(navEntries(false).map((one) => one.id)).toContain('acme.nav.crm')
  expect(selectedShell(undefined, false)?.id).toBe('acme.shell.compact')
  expect(hostResolveHandler('open-handler', 'file:csv').handler?.id).toBe(
    'acme.open.csv',
  )

  useSafeMode.getState().enter('query')
  expect(navEntries().map((one) => one.id)).not.toContain('acme.nav.crm')
  expect(navEntries().length).toBeGreaterThan(0)
  expect(selectedShell()).toBeUndefined()
  expect(
    hostContributionsOf('shell').every((one) => one.source.kind === 'builtin'),
  ).toBe(true)
  const resolved = hostResolveHandler('open-handler', 'file:csv')
  expect(resolved.handler?.id).toBe('theorem.open.csv')
  expect(resolved.candidates.map((one) => one.id)).toEqual(['theorem.open.csv'])
})
