// SOURCING: bun:test over ./bundle: OWN-04 export and import, secrets and
// grants excluded, digests checked, identity conflicts explicit, retained data
// rebound by identity and never another user's.
import { describe, expect, test } from 'bun:test'
import { exportBundle, planImport, withoutSecrets } from './bundle'
import { buildRelease } from './release'
import { emptyRecord } from './state'
import { emptyOwned, saveSettings } from './ownership'

const files = {
  'Modules/notes/module.json':
    '{"schema":"theorem.module/1","id":"vault.notes","label":"N","implementation":{"kind":"sandboxed-html"}}',
  'Modules/notes/index.html': '<body>x</body>',
}
const release = () =>
  buildRelease({
    identity: 'vault.notes',
    files,
    manifestPath: 'Modules/notes/module.json',
    entryPoints: ['Modules/notes/index.html'],
    dependencies: [],
    requested: { read: [], write: [], state: [], net: [] },
    at: 1,
  })

const mine = {
  name: 'tasks',
  provider: 'rustyred-opfs',
  owner: 'me',
  schemaVersion: 1,
  ref: 'opfs:tasks',
}
const theirs = {
  ...mine,
  name: 'theirs',
  owner: 'someone-else',
  ref: 'opfs:theirs',
}

describe('export', () => {
  test('holds source, digests and chosen data references; no grants, secrets or unselected data', async () => {
    const owned = saveSettings(emptyOwned('vault.notes'), {
      density: 'compact',
      apiKey: 'sk-123',
      nested: { password: 'p', ok: 1 },
    })
    const { bundle, omitted } = exportBundle({
      release: await release(),
      manifestPath: 'Modules/notes/module.json',
      owned,
      availableData: [mine, theirs],
      selected: ['tasks'],
    })
    expect(bundle.files).toEqual(files)
    expect(bundle.settings).toEqual({ density: 'compact', nested: { ok: 1 } })
    expect(bundle.data.map((d) => d.name)).toEqual(['tasks'])
    expect(JSON.stringify(bundle)).not.toContain('sk-123')
    expect(omitted.join('\n')).toContain('apiKey')
    expect(omitted.join('\n')).toContain('data theirs (not selected)')
    expect(omitted.join('\n')).toContain('grants')
  })

  test('secret-looking keys are found at any depth', () => {
    expect(withoutSecrets({ a: [{ token: 1, b: 2 }] })).toEqual({
      kept: { a: [{ b: 2 }] },
      omitted: ['a[0].token'],
    })
  })
})

describe('import', () => {
  const exported = async () =>
    exportBundle({
      release: await release(),
      manifestPath: 'Modules/notes/module.json',
      availableData: [mine, theirs],
      selected: ['tasks', 'theirs'],
    }).bundle

  test("a fresh bundle is ready, and another user's data is listed but not attached", async () => {
    const plan = await planImport(await exported(), { userId: 'me' })
    expect(plan.status).toBe('ready')
    if (plan.status !== 'ready') return
    expect(plan.rebind.references.map((d) => d.name)).toEqual(['tasks'])
    expect(plan.rebind.foreign.map((d) => d.name)).toEqual(['theirs'])
    expect(plan.diagnostics[0]!.message).toContain('belong to someone else')
  })

  test('altered files are refused', async () => {
    const bundle = await exported()
    bundle.files['Modules/notes/index.html'] = '<body>tampered</body>'
    expect((await planImport(bundle, { userId: 'me' })).status).toBe('refused')
  })

  test('something that is not a bundle is refused with a reason', async () => {
    const plan = await planImport({ schema: 'x' }, { userId: 'me' })
    expect(plan.status).toBe('refused')
  })

  test('a newer host requirement is refused', async () => {
    const bundle = await exported()
    bundle.release.host.minVersion = 99
    expect((await planImport(bundle, { userId: 'me' })).status).toBe('refused')
  })

  test('the same code already installed makes no duplicate', async () => {
    const rel = await release()
    const record = { ...emptyRecord('vault.notes'), releases: [rel] }
    const plan = await planImport(await exported(), { userId: 'me', record })
    expect(plan).toMatchObject({
      status: 'already-installed',
      releaseId: rel.releaseId,
    })
  })

  test('different code under an installed identity is an explicit choice, never a silent duplicate', async () => {
    const bundle = await exported()
    const other = await buildRelease({
      identity: 'vault.notes',
      files: { ...files, 'Modules/notes/index.html': '<body>y</body>' },
      manifestPath: 'Modules/notes/module.json',
      entryPoints: ['Modules/notes/index.html'],
      dependencies: [],
      requested: { read: [], write: [], state: [], net: [] },
    })
    const record = {
      ...emptyRecord('vault.notes'),
      releases: [other],
      dataVersion: 1,
    }
    const plan = await planImport(bundle, {
      userId: 'me',
      record,
      taken: new Set(['vault.notes']),
    })
    expect(plan.status).toBe('conflict')
    if (plan.status !== 'conflict') return
    expect(plan.options).toEqual(['new-release', 'install-as-copy'])
    expect(plan.copyIdentity).toBe('vault.notes-copy')
    expect(plan.rebind.retained).toEqual({
      dataVersion: 1,
      access: 'read-write',
    })
  })

  test('retained data newer than the bundle can read refuses the import and keeps the data', async () => {
    const record = { ...emptyRecord('vault.notes'), dataVersion: 5 }
    const plan = await planImport(await exported(), { userId: 'me', record })
    expect(plan.status).toBe('refused')
  })
})
