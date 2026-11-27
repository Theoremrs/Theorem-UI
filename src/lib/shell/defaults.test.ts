// SOURCING: bun:test over the Defaults rows: candidates and reasons from
// resolveHandler, ambiguity left for the person, a missing preference named,
// and choose / restore / hide acting only when called.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import {
  registerContribution,
  useHandlerPreferences,
} from '@/lib/contributions/registry'
import '@/components/shell/builtin-chrome'
import {
  chooseHandler,
  defaultsRows,
  hideableBuiltins,
  restoreDefault,
  setBuiltinHidden,
} from './defaults'

const removes: Array<() => void> = []
const add = (...args: Parameters<typeof registerContribution>) =>
  removes.push(registerContribution(...args))
const row = (key: string) => defaultsRows().find((one) => one.key === key)
const acme = { kind: 'extension', extensionId: 'acme' } as const

beforeEach(() => {
  useHandlerPreferences.getState().resetAll()
  add({
    kind: 'open-handler',
    id: 'theorem.open.markdown',
    label: 'Editor',
    serves: ['file:md'],
  })
})
afterEach(() => {
  while (removes.length) removes.pop()!()
})

test('a role with one handler serves it as the only candidate', () => {
  expect(row('open-handler:file:md')).toMatchObject({
    current: 'theorem.open.markdown',
    reason: 'only-candidate',
    status: 'default',
  })
})

test('an installed handler is a candidate but never selected on its own', () => {
  add(
    {
      kind: 'open-handler',
      id: 'acme.open.md',
      label: 'Acme',
      serves: ['file:md'],
      priority: 99,
    },
    acme,
  )
  const result = row('open-handler:file:md')!
  expect(result.current).toBe('theorem.open.markdown')
  expect(result.status).toBe('ambiguous')
  expect(result.candidates.map((one) => one.id)).toEqual([
    'theorem.open.markdown',
    'acme.open.md',
  ])
  expect(useHandlerPreferences.getState().byServes).toEqual({})
})

test('choosing records the preference; restoring drops it', () => {
  add(
    {
      kind: 'open-handler',
      id: 'acme.open.md',
      label: 'Acme',
      serves: ['file:md'],
    },
    acme,
  )
  chooseHandler(row('open-handler:file:md')!, 'acme.open.md')
  expect(row('open-handler:file:md')).toMatchObject({
    current: 'acme.open.md',
    reason: 'person-preference',
    status: 'chosen',
    hasPreference: true,
  })
  restoreDefault(row('open-handler:file:md')!)
  expect(row('open-handler:file:md')).toMatchObject({
    current: 'theorem.open.markdown',
    status: 'ambiguous',
    hasPreference: false,
  })
})

test('a choice whose handler was uninstalled is shown as missing, not silently dropped', () => {
  useHandlerPreferences.getState().prefer('byServes', 'file:md', 'acme.gone')
  expect(row('open-handler:file:md')).toMatchObject({
    status: 'missing',
    missingPreference: 'acme.gone',
    current: 'theorem.open.markdown',
  })
  useHandlerPreferences.getState().prefer('byServes', 'file:old', 'acme.gone')
  expect(row('orphan:file:old')).toMatchObject({
    status: 'orphaned',
    missingPreference: 'acme.gone',
  })
})

test('the shell row lists the shipped shell and an installed one, and selects only on choice', () => {
  add({ kind: 'shell', id: 'acme.shell.compact', label: 'Compact' }, acme)
  expect(row('shell')).toMatchObject({
    current: 'theorem.shell.default',
    status: 'default',
  })
  expect(row('shell')!.candidates.map((one) => one.id)).toContain(
    'acme.shell.compact',
  )
  chooseHandler(row('shell')!, 'acme.shell.compact')
  expect(useHandlerPreferences.getState().shell).toBe('acme.shell.compact')
  restoreDefault(row('shell')!)
  expect(useHandlerPreferences.getState().shell).toBeUndefined()
})

test('a built-in can be hidden and restored, except Home', () => {
  const nav = hideableBuiltins()
  expect(nav.find((one) => one.id === 'theorem.nav.home')).toBeUndefined()
  const notes = nav.find((one) => one.id === 'theorem.nav.notes')!
  setBuiltinHidden(notes.id, true)
  expect(hideableBuiltins().find((one) => one.id === notes.id)?.hidden).toBe(
    true,
  )
  setBuiltinHidden(notes.id, false)
  expect(hideableBuiltins().find((one) => one.id === notes.id)?.hidden).toBe(
    false,
  )
})
