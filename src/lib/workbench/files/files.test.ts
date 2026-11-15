// SOURCING: none — bun:test over ./files with the stub host in ../environment/test-host
import { describe, expect, test } from 'bun:test'
import {
  HttpError,
  op,
  stubHost,
  testEnvironment,
  FakeLive,
} from '../environment/test-host'
import { createFiles, rowsOf } from './files'

const ALL = [
  op('workspace.files.list'),
  op('workspace.files.read'),
  op('workspace.files.create'),
  op('workspace.files.rename'),
  op('workspace.files.delete'),
]

async function setup(operations = ALL, extra: { copy?: boolean } = {}) {
  const host = stubHost(operations, extra)
  const live = new FakeLive()
  const { environment } = testEnvironment(host, live)
  await environment.settled()
  return { host, live, files: createFiles(environment), environment }
}

describe('listing', () => {
  test('reads the per-directory shape into rows with what the host gives', async () => {
    const { host, files } = await setup()
    host.on('filesList', () => ({
      entries: [
        { name: 'src', kind: 'directory' },
        {
          name: 'a.txt',
          kind: 'file',
          size: 12,
          mtime_ms: 1700,
          ignored: true,
        },
        { name: 'link', kind: 'symlink', hidden: false },
      ],
    }))
    const done = await files.list({ requestId: 'r1', path: 'pkg/' })
    expect(done).toMatchObject({
      outcome: 'accepted',
      workspaceId: 'w1',
      requestId: 'r1',
    })
    if (done.outcome !== 'accepted') throw new Error('not accepted')
    expect(done.value.path).toBe('pkg')
    expect(done.value.rows).toEqual(
      [
        { name: 'src', path: 'pkg/src', kind: 'directory' },
        {
          name: 'a.txt',
          path: 'pkg/a.txt',
          kind: 'file',
          size: 12,
          modified: 1700,
          ignored: true,
        },
        { name: 'link', path: 'pkg/link', kind: 'symlink', hidden: false },
      ].map((row) => expect.objectContaining(row)),
    )
    expect(host.calls[host.calls.length - 1]?.request).toMatchObject({
      body: { path: 'pkg' },
      'Idempotency-Key': 'r1',
    })
  })

  test('reads the whole-tree shape into the same rows, with its extra fields', () => {
    const rows = rowsOf(
      {
        directories: [
          { path: 'src', kind: 'directory' },
          { path: 'src/deep', kind: 'directory' },
        ],
        files: [
          { path: 'main.ts', kind: 'file', size: 5 } as never,
          { path: 'src/deep/a.txt', kind: 'file' },
        ],
      },
      '',
    )
    expect(
      rows.map(({ name, path, kind, size }) => ({ name, path, kind, size })),
    ).toEqual([
      { name: 'src', path: 'src', kind: 'directory', size: undefined },
      { name: 'main.ts', path: 'main.ts', kind: 'file', size: 5 },
    ])
    expect(
      rowsOf(
        { directories: [{ path: 'src/deep', kind: 'directory' }] },
        'src',
      )[0],
    ).toMatchObject({
      name: 'deep',
      path: 'src/deep',
    })
  })

  test('an empty directory is an accepted empty list; an outage is never an empty project', async () => {
    const { host, files } = await setup()
    const empty = await files.list({ requestId: 'r1', path: '' })
    expect(empty).toMatchObject({ outcome: 'accepted', value: { rows: [] } })
    host.on('filesList', () => {
      throw new HttpError(502)
    })
    expect(await files.list({ requestId: 'r2', path: '' })).toMatchObject({
      outcome: 'failed',
      requestId: 'r2',
    })
  })

  test('a path that leaves the workspace is refused before anything is sent', async () => {
    const { host, files } = await setup()
    for (const path of ['../etc', 'a/../../b', '/etc/passwd']) {
      expect(await files.list({ requestId: 'r', path })).toMatchObject({
        outcome: 'refused',
        code: 'outside_workspace',
      })
    }
    expect(host.count('filesList')).toBe(0)
  })
})

describe('unavailable environments', () => {
  test('refuse without sending, naming the cause', async () => {
    const host = stubHost([])
    host.on('open', () => {
      throw new HttpError(403, { title: 'Not allowed here' })
    })
    const { environment } = testEnvironment(host)
    const files = createFiles(environment)
    const done = await files.list({ requestId: 'r1', path: '' })
    expect(done).toEqual({
      workspaceId: 'w1',
      requestId: 'r1',
      outcome: 'refused',
      code: 'environment_unavailable',
      reason: 'Not allowed here',
    })
    expect(host.count('filesList')).toBe(0)
  })

  test('an operation the host lists as not granted is a missing capability', async () => {
    const { host, files } = await setup([
      op('workspace.files.delete', { granted: false }),
    ])
    expect(await files.delete({ requestId: 'r', path: 'a.txt' })).toMatchObject(
      {
        outcome: 'refused',
        code: 'missing_capability',
      },
    )
    expect(host.count('filesDelete')).toBe(0)
  })
})

describe('reading', () => {
  test('returns the text with the host revision when it sends one', async () => {
    const { host, files } = await setup()
    host.on('filesRead', () => ({
      encoding: 'utf8',
      contents: 'héllo',
      etag: 'abc',
    }))
    expect(await files.read({ requestId: 'r', path: 'a.txt' })).toMatchObject({
      outcome: 'accepted',
      value: { path: 'a.txt', text: 'héllo', revision: 'abc' },
    })
  })

  test('says a binary file is not text, and a missing or denied path as the host does', async () => {
    const { host, files } = await setup()
    host.on('filesRead', () => ({ encoding: 'base64', contents: 'AAEC' }))
    expect(await files.read({ requestId: 'r', path: 'a.bin' })).toMatchObject({
      outcome: 'refused',
      code: 'binary_file',
    })
    host.on('filesRead', () => {
      throw new HttpError(409, { code: 'not_found' })
    })
    expect(await files.read({ requestId: 'r', path: 'gone' })).toMatchObject({
      outcome: 'refused',
      code: 'not_found',
    })
    host.on('filesRead', () => {
      throw new HttpError(403)
    })
    expect(await files.read({ requestId: 'r', path: 'secret' })).toMatchObject({
      outcome: 'refused',
      code: 'forbidden',
    })
  })
})

describe('writing', () => {
  test('creates a file or folder once, keyed by the request, with the SDK retries off', async () => {
    const { host, files } = await setup()
    expect(
      await files.create({
        requestId: 'c1',
        path: 'a/b.txt',
        kind: 'file',
        text: 'x',
      }),
    ).toMatchObject({
      outcome: 'accepted',
      value: { path: 'a/b.txt' },
    })
    await files.create({ requestId: 'c2', path: 'a/dir', kind: 'directory' })
    const [file, directory] = host.calls.filter(
      (call) => call.name === 'filesCreate',
    )
    expect(file?.request).toMatchObject({
      body: { path: 'a/b.txt', contents: 'x' },
      'Idempotency-Key': 'c1',
    })
    expect(directory?.request).toMatchObject({
      body: { path: 'a/dir', directory: true },
    })
    expect(file?.options).toEqual({ maxRetries: 0 })
  })

  test('a write whose answer was lost is uncertain, and is not sent again', async () => {
    const { host, files } = await setup()
    for (const lost of [
      new HttpError(undefined),
      new Error('network connection lost'),
      new HttpError(504),
      new HttpError(408),
    ]) {
      host.on('filesRename', () => {
        throw lost
      })
      const done = await files.rename({ requestId: 'r', from: 'a', to: 'b' })
      expect(done).toMatchObject({
        outcome: 'uncertain',
        workspaceId: 'w1',
        requestId: 'r',
      })
    }
    expect(host.count('filesRename')).toBe(4)
  })

  test('a refusal is a refusal: nothing was applied', async () => {
    const { host, files } = await setup()
    host.on('filesCreate', () => {
      throw new HttpError(409, {
        code: 'already_exists',
        detail: 'a.txt already exists',
      })
    })
    expect(
      await files.create({ requestId: 'r', path: 'a.txt', kind: 'file' }),
    ).toMatchObject({
      outcome: 'refused',
      code: 'already_exists',
      reason: 'a.txt already exists',
    })
    host.on('filesDelete', () => {
      throw new HttpError(401)
    })
    expect(await files.delete({ requestId: 'r', path: 'a.txt' })).toMatchObject(
      { outcome: 'refused', code: 'signed_out' },
    )
  })

  test('renames and deletes through the host', async () => {
    const { host, files } = await setup()
    expect(
      await files.rename({ requestId: 'r1', from: './a', to: 'b/' }),
    ).toMatchObject({ outcome: 'accepted', value: { from: 'a', to: 'b' } })
    expect(await files.delete({ requestId: 'r2', path: 'b' })).toMatchObject({
      outcome: 'accepted',
      value: { path: 'b' },
    })
    expect(
      host.calls.find((call) => call.name === 'filesRename')?.request,
    ).toMatchObject({ body: { from: 'a', to: 'b' } })
  })
})

describe('copying', () => {
  test('is refused with the reason when the host does not advertise it', async () => {
    const { host, files } = await setup(ALL, { copy: true })
    const done = await files.copy({ requestId: 'r', from: 'a', to: 'b' })
    expect(done).toMatchObject({
      outcome: 'refused',
      code: 'missing_capability',
      reason: expect.stringContaining('does not advertise'),
    })
    expect(host.count('filesCopy')).toBe(0)
  })

  test('is sent when advertised', async () => {
    const { host, files } = await setup([...ALL, op('workspace.files.copy')], {
      copy: true,
    })
    expect(
      await files.copy({ requestId: 'r', from: 'a', to: 'b' }),
    ).toMatchObject({ outcome: 'accepted', value: { from: 'a', to: 'b' } })
    expect(
      host.calls.find((call) => call.name === 'filesCopy')?.request,
    ).toMatchObject({ body: { from: 'a', to: 'b' } })
  })

  test('over an existing target copies beside it, swaps, and removes the old one', async () => {
    const { host, files } = await setup([...ALL, op('workspace.files.copy')], {
      copy: true,
    })
    expect(
      await files.copy({ requestId: 'r', from: 'a', to: 'b', overwrite: true }),
    ).toMatchObject({ outcome: 'accepted' })
    expect(
      host.calls
        .map((call) => call.name)
        .filter((name) => name !== 'open' && name !== 'capabilities'),
    ).toEqual(['filesCopy', 'filesRename', 'filesRename', 'filesDelete'])
    const keys = host.calls
      .filter((call) => call.name.startsWith('files'))
      .map((call) => call.request['Idempotency-Key'])
    expect(new Set(keys).size).toBe(keys.length)
  })

  test('advertised by a host this client cannot call is refused as such, not sent by hand', async () => {
    const { host, files } = await setup([...ALL, op('workspace.files.copy')])
    expect(
      await files.copy({ requestId: 'r', from: 'a', to: 'b' }),
    ).toMatchObject({ outcome: 'refused', code: 'client_cannot_copy' })
    expect(host.calls.some((call) => call.name.includes('Copy'))).toBe(false)
  })
})

describe('watching a directory', () => {
  test('hears only changes to its direct children, and says when events may be lost', async () => {
    const { live, files } = await setup()
    const heard: unknown[] = []
    const stop = files.watch('src/', (event) => heard.push(event))
    live.emit('file.changed', {
      path: 'src/a.ts',
      change: 'changed',
      directory: false,
    })
    live.emit('file.changed', {
      path: 'src/deep/b.ts',
      change: 'created',
      directory: false,
    })
    live.emit('file.changed', {
      path: 'other/c.ts',
      change: 'deleted',
      directory: false,
    })
    live.emit('file.changed', {
      path: 'top.ts',
      change: 'created',
      directory: false,
    })
    live.emit('file.changed', { path: '.', change: 'changed', directory: true })
    expect(heard).toEqual([
      {
        kind: 'changed',
        workspaceId: 'w1',
        path: 'src/a.ts',
        change: 'changed',
        directory: false,
      },
      { kind: 'resync', workspaceId: 'w1', reason: 'events_lost' },
    ])
    stop()
  })

  test('the root watcher hears top-level entries, and a reconnect says to list again', async () => {
    const { live, files } = await setup()
    const heard: { kind: string; reason?: string; path?: string }[] = []
    const stop = files.watch('', (event) => heard.push(event))
    live.state('open')
    live.emit('file.changed', {
      path: 'top.ts',
      change: 'created',
      directory: false,
    })
    live.emit('file.changed', {
      path: 'src/a.ts',
      change: 'created',
      directory: false,
    })
    live.state('reconnecting')
    live.state('open')
    expect(heard).toEqual([
      expect.objectContaining({ kind: 'changed', path: 'top.ts' }),
      { kind: 'resync', workspaceId: 'w1', reason: 'reconnected' },
    ])
    stop()
  })

  test('shares one live stream across watchers and closes it with the last', async () => {
    const { live, files } = await setup()
    const a = files.watch('a', () => undefined)
    const b = files.watch('b', () => undefined)
    a()
    expect(live.closed).toBe(0)
    b()
    expect(live.closed).toBe(1)
  })
})
