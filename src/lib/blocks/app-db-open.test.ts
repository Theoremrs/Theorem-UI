// SOURCING: bun:test over the two ways an App's database is opened
// (app-db.ts), with @rustyreddb/browser mocked so what each opener hands the
// engine can be read back. A check of an App runs its databases in memory and
// on screen writes them to this origin's private file system; the rules that
// decide whose records they are must be the same in both, which the engine's
// own defaults do not give. The real engine needs a worker and a file, so this
// is the level the pair is checked at: the settings, not a commit.
import { expect, mock, test } from 'bun:test'
import { APP_HISTORY_DAYS, openAppDatabase, openInMemory } from './app-db'

const opened: Array<{ via: string; settings: Record<string, unknown> }> = []
mock.module('@rustyreddb/browser', () => ({
  open: async (directory: string, settings: Record<string, unknown>) => {
    opened.push({ via: 'open', settings: { ...settings, directory } })
    return {}
  },
  inMemory: async (settings: Record<string, unknown>) => {
    opened.push({ via: 'inMemory', settings: { ...settings } })
    return {}
  },
}))
mock.module('@rustyreddb/browser/rustyred.wasm?url', () => ({
  default: 'rustyred.wasm',
}))

test('an App database is opened by the same rules wherever it lives', async () => {
  await openAppDatabase('theorem-app.doc.crm')
  await openInMemory('theorem-app.check.crm')
  expect(opened.map(({ via }) => via)).toEqual(['open', 'inMemory'])
  const [live, check] = opened
  // The engine defaults `controlEvents` and `ownershipMarkers` to true, so a
  // memory database that forgot them would refuse an App's own `ownership`
  // field while the App on screen accepts it, and would keep history the App
  // never asked for.
  const rules = {
    controlEvents: false,
    historyDays: APP_HISTORY_DAYS,
    ownershipMarkers: false,
  }
  for (const settings of [live?.settings, check?.settings])
    for (const [rule, value] of Object.entries(rules))
      expect(settings?.[rule]).toBe(value)
  // Only a database in this origin's file system is shared between its tabs.
  expect(live?.settings.shared).toBe(true)
  expect(Object.hasOwn(check?.settings ?? {}, 'shared')).toBe(false)
  // Each brings its own worker and wasm, which is how the engine runs at all.
  for (const settings of [live?.settings, check?.settings]) {
    expect(typeof settings?.wasm).toBe('string')
    expect(typeof settings?.worker).toBe('function')
  }
})
