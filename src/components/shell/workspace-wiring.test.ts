// SOURCING: bun:test over the wiring that joins the releases owner to the
// shell's recovery page, and over the active release's files that the module
// runtime runs (OWN-02, EXEC-05).
import { afterEach, expect, test } from 'bun:test'
import { activeReleaseText } from '@/components/pages/running-release'
import { useReleases } from '@/lib/releases/store'
import { emptyRecord } from '@/lib/releases/state'
import type { Release } from '@/lib/releases/types'
import { recoveryActions } from '@/lib/shell/recovery'
import { connectReleaseRecovery } from './workspace-wiring'

const release = (id: string): Release => ({
  releaseId: id,
  identity: 'vault.notes',
  sourceDigest: id,
  manifestDigest: id,
  grantDigest: id,
  entryPoints: [],
  dependencies: [],
  host: { api: 'theorem.module/1', minVersion: 1 },
  data: { reads: { min: 1, max: 1 }, writes: { min: 1, max: 1 } },
  provenance: { kind: 'user-authored' },
  requested: { read: [], write: [], state: [], net: [] },
  version: 1,
  files: {
    'Modules/notes/module.json': `{"v":"${id}"}`,
    'Modules/notes/index.html': `<p>${id}</p>`,
  },
  at: 1,
})

const seed = (working: string[]) =>
  useReleases.setState({
    modules: {
      'vault.notes': {
        ...emptyRecord('vault.notes'),
        releases: [release('old'), release('new')],
        activeId: 'new',
        working,
        revision: 2,
      },
    },
  })

afterEach(() => useReleases.setState({ modules: {} }))

const rollbacks = () =>
  recoveryActions().filter((one) => one.id.startsWith('releases.rollback.'))

test('the recovery page offers the last working release, and follows the records', () => {
  useReleases.setState({ modules: {} })
  const disconnect = connectReleaseRecovery()
  expect(rollbacks()).toEqual([])
  seed(['old', 'new'])
  expect(rollbacks().map((one) => one.id)).toEqual([
    'releases.rollback.vault.notes',
  ])
  // Only the active release worked: there is nothing earlier to go back to.
  seed(['new'])
  expect(rollbacks()).toEqual([])
  seed(['old', 'new'])
  disconnect()
  expect(rollbacks()).toEqual([])
})

test('the running files are the active release’s own copy', () => {
  expect(
    activeReleaseText(release('old').files, 'Modules/notes', 'index.html'),
  ).toEqual({ manifest: '{"v":"old"}', source: '<p>old</p>' })
  // A release without the entry runs nothing of its own; the vault's serve.
  expect(
    activeReleaseText(release('old').files, 'Modules/notes', 'main.html'),
  ).toBeUndefined()
  expect(
    activeReleaseText(undefined, 'Modules/notes', 'index.html'),
  ).toBeUndefined()
})
