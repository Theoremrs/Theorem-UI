// SOURCING: bun:test over the host's recovery actions, the failure record and
// the hook other workstreams plug into.
import { beforeEach, expect, test } from 'bun:test'
import { useHandlerPreferences } from '@/lib/contributions/registry'
import { useFailures, recordFailure } from './failures'
import {
  resetLayoutStoreForTest,
  saveLayout,
  useLayoutStore,
} from './layout-store'
import {
  recoveryActions,
  registerRecoveryAction,
  resetDefaultHandlers,
  resetLayoutChecked,
  restoreShippedShell,
  useRecoveryActions,
} from './recovery'

beforeEach(() => {
  useHandlerPreferences.getState().resetAll()
  useFailures.getState().clear()
  resetLayoutStoreForTest()
})

test('restoring the shipped shell clears only the shell choice', () => {
  useHandlerPreferences.getState().selectShell('acme.shell.broken')
  useHandlerPreferences.getState().prefer('byServes', 'file:md', 'acme.open.md')
  expect(restoreShippedShell().ok).toBe(true)
  expect(useHandlerPreferences.getState().shell).toBeUndefined()
  expect(useHandlerPreferences.getState().byServes).toEqual({
    'file:md': 'acme.open.md',
  })
})

test('resetting handlers clears choices and hidden built-ins but keeps the shell choice', () => {
  useHandlerPreferences.getState().selectShell('acme.shell.x')
  useHandlerPreferences.getState().prefer('byServes', 'file:md', 'acme.open.md')
  useHandlerPreferences.getState().setHidden('theorem.nav.notes', true)
  resetDefaultHandlers()
  const state = useHandlerPreferences.getState()
  expect(state.byServes).toEqual({})
  expect(state.hidden).toEqual([])
  expect(state.shell).toBe('acme.shell.x')
})

test('a layout reset is refused on a stale revision and otherwise keeps every layout aside', () => {
  saveLayout('p1', 'desktop', { vendor: { panels: {} } })
  const seen = useLayoutStore.getState().revision
  saveLayout('p1', 'desktop', { vendor: { panels: {} } })
  expect(resetLayoutChecked(seen).ok).toBe(false)
  expect(resetLayoutChecked(useLayoutStore.getState().revision).ok).toBe(true)
  expect(useLayoutStore.getState().preserved).toHaveLength(1)
})

test('another workstream can plug an action in, and it sorts after the host actions', () => {
  const remove = registerRecoveryAction({
    id: 'theorem.releases.last-working',
    label: 'Select the last working release',
    description: 'x',
    run: () => ({ ok: true, message: 'ok' }),
  })
  const ids = recoveryActions().map((action) => action.id)
  expect(ids.slice(0, 2)).toEqual([
    'theorem.recovery.restore-shell',
    'theorem.recovery.reset-handlers',
  ])
  expect(ids).toContain('theorem.releases.last-working')
  remove()
  expect(
    useRecoveryActions.getState().actions.map((action) => action.id),
  ).not.toContain('theorem.releases.last-working')
})

test('failures are recorded with their area and contribution, newest last, and capped', () => {
  recordFailure('shell', new Error('boom'), 'acme.shell.x')
  expect(useFailures.getState().failures[0]).toMatchObject({
    area: 'shell',
    contributionId: 'acme.shell.x',
    message: 'boom',
  })
  for (let n = 0; n < 60; n++) recordFailure('handler', new Error(`e${n}`))
  expect(useFailures.getState().failures).toHaveLength(50)
  expect(useFailures.getState().failures.at(-1)!.message).toBe('e59')
})
