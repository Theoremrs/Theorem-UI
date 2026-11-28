// SOURCING: bun:test over ./activation, ./vault-ports, ./recovery and ./state:
// EXEC-04 (the sequence, a failed candidate leaves the last working release),
// EXEC-02 (grants are bound to a digest), OWN-03 (data ranges on rollback),
// acceptance A05 and A16, with in-memory records and ports.
import { beforeEach, describe, expect, test } from 'bun:test'
import { activateCandidate } from './activation'
import type { ActivationPorts, RecordAccess } from './activation'
import {
  ActiveInstances,
  InstanceScope,
  activeInstances,
} from './instance-scope'
import { lastWorkingRelease, rollbackTo, setReleaseWriter } from './recovery'
import { dataAccess } from './release'
import { releaseRecords, useReleases } from './store'
import { emptyRecord } from './state'
import type { ModuleRecord } from './state'
import { staticPreview, structuralChecks, vaultResolver } from './vault-ports'
import type { Release } from './types'
import { useModuleGrants, moduleDigest } from '@/lib/modules/grants'

const manifest = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    schema: 'theorem.module/1',
    id: 'vault.notes',
    label: 'Notes',
    implementation: { kind: 'sandboxed-html', entry: 'index.html' },
    ...extra,
  })

const files = (page: string, extra: Record<string, unknown> = {}) => ({
  'Modules/notes/module.json': manifest(extra),
  'Modules/notes/index.html': page,
})

const PAGE = '<!doctype html><body><p>hi</p><script>const a = 1</script></body>'

function memory() {
  const modules = new Map<string, ModuleRecord>()
  const access: RecordAccess = {
    get: (id) => modules.get(id),
    update: (id, change) =>
      modules.set(id, change(modules.get(id) ?? emptyRecord(id))),
  }
  return { modules, access }
}

function ports(over: Partial<ActivationPorts> = {}) {
  const calls = { previewWrites: [] as string[][], stages: [] as string[] }
  const base: ActivationPorts = {
    resolve: vaultResolver(),
    compile: async (release) => {
      calls.stages.push('compile')
      return structuralChecks(release)
    },
    preview: async (release, preview) => {
      calls.stages.push('preview')
      const problems = await staticPreview(release, preview)
      calls.previewWrites.push([...preview.attemptedWrites])
      return problems
    },
    authority: () => ({ grant: undefined, policy: undefined }),
    now: () => 1,
  }
  return { ports: { ...base, ...over }, calls }
}

const run = (
  page: string,
  p: ActivationPorts,
  access: RecordAccess,
  extra: Record<string, unknown> = {},
) =>
  activateCandidate(
    { identity: 'vault.notes', files: files(page, extra) },
    p,
    access,
  )

describe('activation', () => {
  test('a valid candidate becomes active and the first release is a recovery target', async () => {
    const { access, modules } = memory()
    const out = await run(PAGE, ports().ports, access)
    expect(out.status).toBe('activated')
    const record = modules.get('vault.notes')!
    expect(record.activeId).toBe(
      out.status === 'activated' ? out.release.releaseId : undefined,
    )
    expect(record.working).toHaveLength(1)
    if (out.status === 'activated')
      expect(out.trace).toEqual([
        'resolve',
        'validate',
        'compile',
        'preview',
        'prepare',
        'activate',
        'dispose',
      ])
  })

  test('A05: an invalid manifest keeps the last working release and does nothing else', async () => {
    const { access, modules } = memory()
    const first = await run(PAGE, ports().ports, access)
    const before = modules.get('vault.notes')!
    const { ports: p, calls } = ports()
    const out = await activateCandidate(
      {
        identity: 'vault.notes',
        files: {
          'Modules/notes/module.json': '{"schema":"nope"}',
          'Modules/notes/index.html': PAGE,
        },
      },
      p,
      access,
    )
    expect(out.status).toBe('failed')
    if (out.status !== 'failed' || first.status !== 'activated')
      throw new Error('unreachable')
    expect(out.stage).toBe('resolve')
    expect(out.retained?.releaseId).toBe(first.release.releaseId)
    expect(out.diagnostics[0]!.message).toContain('module.json')
    expect(out.diagnostics[0]!.hint).toBeTruthy()
    const after = modules.get('vault.notes')!
    expect(after.activeId).toBe(before.activeId)
    expect(after.working).toEqual(before.working)
    expect(after.revision).toBe(before.revision)
    expect(after.candidate?.stage).toBe('resolve')
    expect(calls.stages).toEqual([]) // nothing past resolve ran
  })

  test('A05: a missing dependency fails resolve and nothing is activated', async () => {
    const { access, modules } = memory()
    const { ports: p } = ports({
      resolve: async () => {
        throw new (await import('./dependencies')).DependencyError([
          {
            stage: 'resolve',
            severity: 'error',
            message: 'left-pad: HTTP 404',
            hint: 'Check the package name.',
          },
        ])
      },
    })
    // DependencyError carries diagnostics but is not a StageFailure; it still fails resolve with its message.
    const out = await run(PAGE, p, access)
    expect(out.status).toBe('failed')
    expect(modules.get('vault.notes')?.activeId).toBeUndefined()
  })

  test('A05: a failing initialization stops at preview, with no write performed and the old release kept', async () => {
    const { access, modules } = memory()
    const first = await run(PAGE, ports().ports, access)
    const { ports: p, calls } = ports({
      preview: async (_release, preview) => {
        try {
          preview.denyWrite('write a record')
        } catch {
          // a module that tries to write during init is refused, then fails
        }
        return [
          {
            stage: 'preview',
            severity: 'error',
            message: 'init threw: x is not defined',
          },
        ]
      },
    })
    const out = await run('<body><p>new</p></body>', p, access)
    expect(out.status).toBe('failed')
    if (out.status !== 'failed' || first.status !== 'activated')
      throw new Error('unreachable')
    expect(out.stage).toBe('preview')
    expect(modules.get('vault.notes')!.activeId).toBe(first.release.releaseId)
    expect(calls.previewWrites).toEqual([])
  })

  test('the preview capabilities hold no mutation, state, net or invoke', async () => {
    const { access } = memory()
    let seen: unknown
    const { ports: p } = ports({
      preview: async (_r, preview) => {
        seen = preview.capabilities
        return []
      },
    })
    await run(PAGE, p, access, {
      capabilities: {
        read: ['Notes'],
        write: ['Notes'],
        state: ['app'],
        net: ['example.com'],
        instances: [
          {
            instanceId: 'crm',
            methods: ['query', 'invoke'],
            actions: ['send'],
          },
        ],
      },
    })
    expect(seen).toEqual({
      read: ['Notes'],
      write: [],
      state: [],
      net: [],
      instances: [{ instanceId: 'crm', methods: ['query'], actions: [] }],
    })
  })

  test('a candidate that asks for new permission waits for the grant; the old release keeps running', async () => {
    const { access, modules } = memory()
    const first = await run(PAGE, ports().ports, access)
    const out = await run(PAGE + '<!--v2-->', ports().ports, access, {
      capabilities: { read: [], write: ['Notes'], state: [], net: [] },
    })
    expect(out.status).toBe('awaiting-grant')
    if (out.status !== 'awaiting-grant' || first.status !== 'activated')
      throw new Error('unreachable')
    expect(out.authority.added.write).toEqual(['Notes'])
    expect(modules.get('vault.notes')!.activeId).toBe(first.release.releaseId)
    expect(modules.get('vault.notes')!.candidate?.awaiting).toBe('grant')
  })

  test('EXEC-02: a grant on the old digest is not carried to the new digest', async () => {
    const { access } = memory()
    const asks = {
      capabilities: { read: ['Notes'], write: [], state: [], net: [] },
    }
    const oldDigest = await moduleDigest(manifest(asks), PAGE)
    const grant = {
      digest: oldDigest,
      capabilities: { read: ['Notes'], write: [], state: [], net: [] },
      grantedAt: 1,
    }
    const withGrant = ports({
      authority: () => ({ grant, policy: undefined }),
    }).ports
    const same = await run(PAGE, withGrant, access, asks)
    expect(same.status).toBe('activated') // same digest: no new prompt
    if (same.status === 'activated')
      expect(same.authority).toEqual({ kind: 'granted', by: 'digest' })
    const edited = await run(PAGE + '<!--edit-->', withGrant, access, asks)
    expect(edited.status).toBe('awaiting-grant')
    // An explicit revision policy over the same scope lets the edit run without a prompt.
    const policy = { scope: asks.capabilities, grantedAt: 2 }
    const covered = await run(
      PAGE + '<!--edit-->',
      ports({ authority: () => ({ grant, policy }) }).ports,
      access,
      asks,
    )
    expect(covered.status).toBe('activated')
    if (covered.status === 'activated')
      expect(covered.authority).toEqual({ kind: 'granted', by: 'policy' })
  })

  test('a stale revision refuses the switch instead of replacing a newer one', async () => {
    const { access, modules } = memory()
    const racing: RecordAccess = {
      get: access.get,
      update: (id, change) => {
        // Another activation lands between the candidate's checks and its commit.
        const record = modules.get(id)
        if (record && record.revision === 0 && record.releases.length === 0)
          modules.set(id, { ...record, revision: 5 })
        access.update(id, change)
      },
    }
    // Prime the record so the race triggers on the activate update.
    modules.set('vault.notes', emptyRecord('vault.notes'))
    const out = await run(PAGE, ports().ports, racing)
    expect(out.status).toBe('failed')
    if (out.status === 'failed') {
      expect(out.stage).toBe('activate')
      expect(out.retryable).toBe(true)
    }
  })

  test('activating replaces the instance: the old one is disposed and its late messages refused', async () => {
    const { access } = memory()
    const events: string[] = []
    const old = new InstanceScope('i1', 'old')
    old.own(() => events.push('old-disposed'))
    activeInstances.replace('vault.notes', old)
    const fresh = new InstanceScope('i2', 'new')
    const out = await run(
      PAGE,
      ports({ instantiate: () => fresh }).ports,
      access,
    )
    expect(out.status).toBe('activated')
    expect(events).toEqual(['old-disposed'])
    expect(activeInstances.accepts('vault.notes', old)).toBe(false)
    expect(activeInstances.accepts('vault.notes', fresh)).toBe(true)
    let delivered = 0
    old.guard(() => delivered++)()
    expect(delivered).toBe(0)
    activeInstances.remove('vault.notes')
  })

  test('the same files again are unchanged', async () => {
    const { access } = memory()
    await run(PAGE, ports().ports, access)
    const again = await run(PAGE, ports().ports, access)
    expect(again.status).toBe('unchanged')
  })
})

describe('scope disposal', () => {
  test('timers, listeners and cleanups end, once, and a throwing cleanup does not stop the rest', async () => {
    const scope = new InstanceScope('i', 'r')
    const target = new EventTarget()
    let hits = 0
    scope.listen(target, 'ping', () => hits++)
    let ticks = 0
    scope.interval(() => ticks++, 5)
    scope.own(() => {
      throw new Error('boom')
    })
    let ran = false
    scope.own(() => (ran = true))
    target.dispatchEvent(new Event('ping'))
    const { failures } = scope.dispose()
    expect(failures).toHaveLength(1)
    expect(ran).toBe(true)
    target.dispatchEvent(new Event('ping'))
    await new Promise((r) => setTimeout(r, 20))
    expect(hits).toBe(1)
    expect(ticks).toBe(0)
    expect(scope.dispose().failures).toEqual([])
    const instances = new ActiveInstances()
    expect(instances.accepts('x', scope)).toBe(false)
  })
})

describe('rollback and recovery (OWN-03, A16)', () => {
  const release = (id: string, data: Release['data']): Release => ({
    releaseId: id,
    identity: 'vault.notes',
    sourceDigest: id,
    manifestDigest: id,
    grantDigest: id,
    entryPoints: [],
    dependencies: [],
    host: { api: 'theorem.module/1', minVersion: 1 },
    data,
    provenance: { kind: 'user-authored' },
    requested: { read: [], write: [], state: [], net: [] },
    version: 1,
    files: { f: id },
    at: 1,
  })

  beforeEach(() => {
    useReleases.setState({ modules: {} })
    setReleaseWriter(undefined)
  })

  const seed = (dataVersion: number) =>
    useReleases.setState({
      modules: {
        'vault.notes': {
          ...emptyRecord('vault.notes'),
          releases: [
            release('old', {
              reads: { min: 1, max: 2 },
              writes: { min: 1, max: 1 },
            }),
            release('new', {
              reads: { min: 1, max: 2 },
              writes: { min: 2, max: 2 },
            }),
          ],
          activeId: 'new',
          working: ['old', 'new'],
          revision: 2,
          dataVersion,
        },
      },
    })

  test('the last working release excludes the active one', () => {
    seed(2)
    expect(lastWorkingRelease('vault.notes')?.releaseId).toBe('old')
    expect(lastWorkingRelease('missing')).toBeUndefined()
  })

  test('A16: after a forward data migration, rolling code back is read-only and does not touch the data', async () => {
    seed(2)
    const restored: string[] = []
    setReleaseWriter({
      restore: async (_id, r) => void restored.push(r.releaseId),
    })
    const out = await rollbackTo('vault.notes', 'old')
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.access).toBe('read-only')
    expect(out.warnings[0]!.message).toContain('can read it but not change it')
    expect(restored).toEqual(['old'])
    const record = releaseRecords.get('vault.notes')!
    expect(record.activeId).toBe('old')
    expect(record.dataVersion).toBe(2) // no schema rollback
    expect(
      record.history.some(
        (h) => h.axis === 'data' && h.summary.includes('read-only'),
      ),
    ).toBe(true)
  })

  test('an older release whose range excludes the database can only export', () => {
    expect(
      dataAccess(
        { data: { reads: { min: 1, max: 1 }, writes: { min: 1, max: 1 } } },
        3,
      ),
    ).toBe('export-only')
    expect(
      dataAccess(
        { data: { reads: { min: 1, max: 3 }, writes: { min: 3, max: 3 } } },
        3,
      ),
    ).toBe('read-write')
    expect(
      dataAccess(
        { data: { reads: { min: 1, max: 1 }, writes: { min: 1, max: 1 } } },
        undefined,
      ),
    ).toBe('read-write')
  })

  test('without an open vault nothing changes', async () => {
    seed(1)
    const out = await rollbackTo('vault.notes', 'old')
    expect(out.ok).toBe(false)
    expect(releaseRecords.get('vault.notes')!.activeId).toBe('new')
  })

  test('a candidate whose data range excludes the database is refused at prepare', async () => {
    const { access, modules } = memory()
    modules.set('vault.notes', {
      ...emptyRecord('vault.notes'),
      dataVersion: 9,
    })
    const out = await run(PAGE, ports().ports, access)
    expect(out.status).toBe('failed')
    if (out.status === 'failed') expect(out.stage).toBe('prepare')
  })
})

describe('grants store is untouched by releases', () => {
  test('building a release never writes a grant', async () => {
    useModuleGrants.setState({ grants: {} })
    const { access } = memory()
    await run(PAGE, ports().ports, access)
    expect(useModuleGrants.getState().grants).toEqual({})
  })
})
