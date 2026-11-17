// SOURCING: none — bun:test over ./checkpoint's local store with fault injection: a database that
// throws what the browser throws, and the package's own shared-database protocol over a Web Locks
// manager with the platform's queueing rules
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
// @ts-expect-error -- the package's internal entry point has no declarations; it is what `open(name, { shared: true })` calls
import { openShared } from '../../../../node_modules/@rustyreddb/browser/src/shared.js'
import {
  CorruptRecord,
  checkpointDirectory,
  createCheckpoints,
  createLocalStore,
  storageOutcome,
} from './checkpoint'
import type { LayoutDocument } from './layout'
import { domError, fakeLocks, memoryDatabase } from './test-storage'

const DOC: LayoutDocument = { current: { dock: 1 }, namedLayouts: {} }

describe('every storage failure is a stated outcome, never a saved one', () => {
  const write = (fail: unknown) => {
    const database = memoryDatabase()
    database.failWrite = fail
    const store = createLocalStore({
      directory: 'd',
      open: async () => database,
    })
    return store.write('L', 'id', { a: 1 })
  }

  test('quota exceeded, by the DOMException name alone or by the message', async () => {
    expect(await write(domError('QuotaExceededError'))).toMatchObject({
      outcome: 'refused',
      code: 'storage_quota_exceeded',
    })
    expect(
      await write(new Error('the storage quota is exhausted')),
    ).toMatchObject({
      outcome: 'refused',
      code: 'storage_quota_exceeded',
    })
  })

  test('denied: the browser will not give persistent storage', async () => {
    expect(await write(domError('SecurityError', 'denied'))).toMatchObject({
      outcome: 'refused',
      code: 'storage_denied',
    })
    expect(await write(domError('NotAllowedError'))).toMatchObject({
      outcome: 'refused',
      code: 'storage_denied',
    })
  })

  test('blocked: another handle holds the file', async () => {
    expect(await write(domError('NoModificationAllowedError'))).toMatchObject({
      outcome: 'refused',
      code: 'storage_blocked',
    })
    expect(
      await write(new Error('the database is blocked by another tab')),
    ).toMatchObject({
      outcome: 'refused',
      code: 'storage_blocked',
    })
  })

  test('unavailable: the file system is missing, closed or unsupported', async () => {
    for (const error of [
      domError('NotSupportedError'),
      new TypeError('navigator.storage.getDirectory is not a function'),
      Object.assign(new Error('x'), { code: 'chunk_store_browser_storage' }),
      Object.assign(new Error('closed'), { code: 'database_closed' }),
    ]) {
      expect(await write(error)).toMatchObject({
        outcome: 'refused',
        code: 'storage_unavailable',
      })
    }
  })

  test('a database that will not open is unavailable and is tried again on the next call', async () => {
    let attempts = 0
    const store = createLocalStore({
      directory: 'd',
      open: async () => {
        attempts += 1
        if (attempts === 1) throw domError('SecurityError', 'opaque origin')
        return memoryDatabase()
      },
    })
    expect(await store.write('L', 'id', {})).toMatchObject({
      outcome: 'refused',
      code: 'storage_denied',
    })
    expect((await store.write('L', 'id', {})).outcome).toBe('accepted')
  })

  test('a transaction that fails is failed with the reason; one whose commit is unknown is uncertain', async () => {
    expect(await write(new Error('transaction aborted'))).toEqual({
      outcome: 'failed',
      reason: 'transaction aborted',
    })
    expect(
      (await write(new Error('chunk_store_browser_commit_state_unknown')))
        .outcome,
    ).toBe('uncertain')
  })

  test('a payload over the limit is refused as too large', async () => {
    expect(
      await write(new Error('chunk_store_browser_payload_too_large')),
    ).toMatchObject({ outcome: 'refused', code: 'checkpoint_too_large' })
  })

  test('a read that throws is stated too', async () => {
    const database = memoryDatabase()
    database.failRead = domError('NotFoundError')
    const store = createLocalStore({
      directory: 'd',
      open: async () => database,
    })
    expect(await store.read('id')).toMatchObject({
      outcome: 'refused',
      code: 'storage_unavailable',
    })
  })

  test('storageOutcome never returns accepted', () => {
    for (const error of [
      undefined,
      'text',
      {},
      new Error('x'),
      domError('Y'),
    ]) {
      expect(storageOutcome(error).outcome).not.toBe('accepted')
    }
  })
})

describe('a corrupt record is refused, not read', () => {
  const kept = (properties: Record<string, unknown>) => {
    const database = memoryDatabase()
    database.nodes.set('theorem-workbench:checkpoint:w1', {
      id: 'theorem-workbench:checkpoint:w1',
      labels: ['WorkbenchCheckpoint'],
      properties,
    })
    return createCheckpoints({ directory: 'd', open: async () => database })
  }

  test('unreadable JSON', async () => {
    const checkpoints = kept({
      baseRevision: 1,
      document: '{not json',
      savedAtMs: 1,
    })
    expect(await checkpoints.read('w1')).toMatchObject({
      outcome: 'refused',
      code: 'checkpoint_corrupt',
    })
  })

  test('a shape this version does not write', async () => {
    const checkpoints = kept({ baseRevision: 'one', document: 7 })
    expect(await checkpoints.read('w1')).toMatchObject({
      outcome: 'refused',
      code: 'checkpoint_corrupt',
    })
  })

  test('a corrupt record is replaced by the next good write', async () => {
    const checkpoints = kept({ baseRevision: 1, document: '{', savedAtMs: 1 })
    await checkpoints.write('w1', { baseRevision: 2, document: DOC })
    expect(await checkpoints.read('w1')).toMatchObject({
      outcome: 'accepted',
      value: { baseRevision: 2 },
    })
  })

  test('the wasm naming corruption is the same refusal', () => {
    expect(storageOutcome(new Error('chunk checksum mismatch'))).toMatchObject({
      outcome: 'refused',
      code: 'checkpoint_corrupt',
    })
    expect(storageOutcome(new CorruptRecord('x'))).toMatchObject({
      code: 'checkpoint_corrupt',
    })
  })
})

describe('one account, one store', () => {
  test('the directory is per account', () => {
    expect(checkpointDirectory('t1:p1')).not.toBe(checkpointDirectory('t2:p1'))
    expect(checkpointDirectory('t1:p1')).toBe('theorem-workbench.t1_p1')
  })

  test('a record that reached this store from another account is not read', async () => {
    const nodes = new Map()
    const first = createLocalStore({
      directory: 'd',
      account: 't1:p1',
      open: async () => memoryDatabase(nodes),
    })
    await first.write('L', 'id', { secret: 'a' })
    const second = createLocalStore({
      directory: 'd',
      account: 't2:p2',
      open: async () => memoryDatabase(nodes),
    })
    expect(await second.read('id')).toMatchObject({
      outcome: 'refused',
      code: 'wrong_account',
    })
    expect(await first.read('id')).toEqual({
      outcome: 'accepted',
      value: { secret: 'a' },
    })
  })

  test('a retired store closes its database and refuses every later call as account_changed', async () => {
    const database = memoryDatabase()
    const store = createLocalStore({
      directory: 'd',
      account: 't1:p1',
      open: async () => database,
    })
    await store.write('L', 'id', { a: 1 })
    await store.retire('Another account is signed in')
    expect(database.closed).toBe(1)
    for (const done of [
      await store.read('id'),
      await store.write('L', 'id', { a: 2 }),
      await store.clear('id'),
    ]) {
      expect(done).toMatchObject({
        outcome: 'refused',
        code: 'account_changed',
      })
    }
    // What it kept stays on disk, under the account that wrote it.
    expect(database.nodes.has('id')).toBe(true)
  })
})

describe('one owner per account across tabs (R16)', () => {
  const original = Object.getOwnPropertyDescriptor(navigator, 'locks')
  beforeAll(() => {
    Object.defineProperty(navigator, 'locks', {
      value: fakeLocks(),
      configurable: true,
    })
  })
  afterAll(() => {
    if (original) Object.defineProperty(navigator, 'locks', original)
    else delete (navigator as { locks?: unknown }).locks
  })

  /** The file: what survives an owner closing. Each owner that opens it is counted. */
  function file() {
    const nodes = new Map()
    const owners: ReturnType<typeof memoryDatabase>[] = []
    const openExclusive = async () => {
      const database = memoryDatabase(nodes)
      const call = (method: string, args: Record<string, unknown>) =>
        method === 'getNode'
          ? database.getNode(args.id as string)
          : method === 'mutate'
            ? database.mutate(args)
            : Promise.resolve({})
      owners.push(database)
      return Object.assign(database, { _call: call, subscribe: () => () => {} })
    }
    return { nodes, owners, openExclusive }
  }

  const tab = (name: string, source: ReturnType<typeof file>) =>
    createLocalStore({
      directory: name,
      account: 't1:p1',
      open: async () => await openShared(name, source.openExclusive),
    })

  test('two tabs open one database: one holds the file, the other goes through it and sees its checkpoint', async () => {
    const source = file()
    const first = tab('acct-1', source)
    const second = tab('acct-1', source)
    expect((await first.write('L', 'draft', { text: 'hello' })).outcome).toBe(
      'accepted',
    )
    // The second tab never opens the file: it asks the first, over the channel.
    expect(await second.read('draft')).toEqual({
      outcome: 'accepted',
      value: { text: 'hello' },
    })
    expect(source.owners).toHaveLength(1)
    await first.dispose()
    await second.dispose()
  })

  test('when the owner closes, the waiting tab takes the file over and nothing was lost', async () => {
    const source = file()
    const first = tab('acct-2', source)
    const second = tab('acct-2', source)
    await first.write('L', 'draft', { text: 'kept' })
    await second.read('draft')
    await first.dispose()
    // Give the lock queue its turn: the second tab becomes the owner and opens the same file.
    for (let i = 0; i < 20 && source.owners.length < 2; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    expect(source.owners).toHaveLength(2)
    expect(await second.read('draft')).toEqual({
      outcome: 'accepted',
      value: { text: 'kept' },
    })
    await second.dispose()
  })

  test('different accounts are different databases with their own owners', async () => {
    const source = file()
    const other = file()
    const first = tab('acct-3', source)
    const second = tab('acct-4', other)
    await first.write('L', 'draft', { text: 'mine' })
    expect(await second.read('draft')).toEqual({
      outcome: 'accepted',
      value: undefined,
    })
    expect(source.owners).toHaveLength(1)
    expect(other.owners).toHaveLength(1)
    await first.dispose()
    await second.dispose()
  })
})
