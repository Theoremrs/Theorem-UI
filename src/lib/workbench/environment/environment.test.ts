// SOURCING: none — bun:test over ./environment with the stub host in ./test-host
import { describe, expect, test } from 'bun:test'
import { availabilityOf } from './result'
import { FakeLive, HttpError, op, stubHost, testEnvironment } from './test-host'

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('opening the workspace', () => {
  test('opens it, reads the advertised operations and names the host', async () => {
    const host = stubHost([
      op('workspace.files.list'),
      op('workspace.files.copy', { granted: false, reason: 'Copy is off' }),
    ])
    const { environment } = testEnvironment(host)
    expect(await environment.settled()).toEqual({ status: 'available' })
    expect(
      host.calls.find((call) => call.name === 'open')?.request,
    ).toMatchObject({
      workspace_id: 'w1',
      'X-CSRF-Token': 'token',
    })
    expect(environment.identity).toMatchObject({
      workspaceId: 'w1',
      label: 'test-host 1.2.3',
      version: '1.2.3',
    })
    expect(environment.has('workspace.files.list')).toBe(true)
    expect(environment.has('workspace.files.copy')).toBe(false)
    expect(environment.operation('workspace.files.copy')).toEqual({
      state: 'unavailable',
      reason: 'Copy is off',
    })
    expect(environment.operation('scm.status')).toEqual({ state: 'unlisted' })
    expect(environment.operations()).toEqual([
      { name: 'workspace.files.list', state: { state: 'available' } },
      {
        name: 'workspace.files.copy',
        state: { state: 'unavailable', reason: 'Copy is off' },
      },
    ])
  })

  test('is unavailable while opening, and says so', async () => {
    const { environment } = testEnvironment(stubHost([]))
    expect(environment.availability).toMatchObject({
      status: 'unavailable',
      cause: 'opening',
    })
    await environment.settled()
  })

  test('a host that fails to open is unavailable with a typed cause, then recovers on retry', async () => {
    const host = stubHost([])
    let healthy = false
    host.on('open', () => {
      if (!healthy) throw new HttpError(503, { detail: 'The host is starting' })
      return { workspace_id: 'w1', active: true, durable: true }
    })
    const { environment } = testEnvironment(host)
    expect(await environment.settled()).toEqual({
      status: 'unavailable',
      cause: 'host_unreachable',
      reason: 'The host is starting',
    })
    const seen: string[] = []
    environment.subscribe(
      (event) =>
        event.type === 'availability' && seen.push(event.availability.status),
    )
    healthy = true
    environment.retry()
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(environment.availability).toEqual({ status: 'available' })
    expect(seen).toEqual(['available'])
  })

  test('availability names its cause from the status, not a thrown string', () => {
    const cause = (error: unknown) => {
      const availability = availabilityOf(error)
      return availability.status === 'unavailable'
        ? availability.cause
        : 'available'
    }
    expect(cause(new HttpError(401))).toBe('signed_out')
    expect(cause(new HttpError(403))).toBe('forbidden')
    expect(cause(new HttpError(404))).toBe('unsupported')
    expect(cause(new HttpError(501))).toBe('unsupported')
    expect(cause(new HttpError(503, { code: 'theorem_unconfigured' }))).toBe(
      'unconfigured',
    )
    expect(cause(new HttpError(502))).toBe('host_unreachable')
    expect(cause(new HttpError(undefined))).toBe('host_unreachable')
    expect(cause(new Error('fetch failed'))).toBe('host_unreachable')
    expect(cause(new HttpError(500))).toBe('host_error')
  })

  test('a missing or ungranted operation is a missing capability, and an unlisted one only when it must be advertised', async () => {
    const host = stubHost([
      op('workspace.files.list'),
      op('workspace.files.rename', { ready: false }),
    ])
    const { environment } = testEnvironment(host)
    await environment.settled()
    expect(environment.availabilityFor('workspace.files.list')).toEqual({
      status: 'available',
    })
    expect(environment.availabilityFor('workspace.files.rename')).toMatchObject(
      { status: 'unavailable', cause: 'missing_capability' },
    )
    expect(environment.availabilityFor('workspace.files.copy')).toEqual({
      status: 'available',
    })
    expect(
      environment.availabilityFor('workspace.files.copy', true),
    ).toMatchObject({
      status: 'unavailable',
      cause: 'missing_capability',
      reason: expect.stringContaining('does not advertise'),
    })
  })

  test('capabilities that cannot be read leave the workspace open with nothing listed', async () => {
    const host = stubHost([])
    host.on('capabilities', () => {
      throw new HttpError(404)
    })
    const { environment } = testEnvironment(host)
    expect(await environment.settled()).toEqual({ status: 'available' })
    expect(environment.operation('workspace.files.list')).toEqual({
      state: 'unlisted',
    })
  })
})

describe('the live channel', () => {
  test('is one stream per workspace, counted by holders, closed with the last', async () => {
    const live = new FakeLive()
    let created = 0
    const { environment } = testEnvironment(stubHost([]), live, {
      createLive: () => {
        created += 1
        return live as never
      },
    })
    await environment.settled()
    const a = environment.acquireLive()
    const b = environment.acquireLive()
    await tick()
    expect(created).toBe(1)
    expect(live.started).toBe(1)
    a.on('file.changed', () => undefined)
    expect(live.listenerCount('file.changed')).toBe(1)
    a.release()
    a.release()
    expect(live.closed).toBe(0)
    expect(live.listenerCount('file.changed')).toBe(0)
    b.release()
    expect(live.closed).toBe(1)
    environment.acquireLive().release()
    expect(created).toBe(2)
  })

  test('says to re-read after a reconnect, once, and not on the first open', async () => {
    const live = new FakeLive()
    const { environment } = testEnvironment(stubHost([]), live)
    await environment.settled()
    const lease = environment.acquireLive()
    const reads: string[] = []
    lease.onReconnected(({ reason }) => reads.push(reason))
    live.state('open')
    expect(reads).toEqual([])
    live.state('reconnecting')
    expect(reads).toEqual([])
    live.state('open')
    expect(reads).toEqual(['reconnected'])
    live.state('open')
    expect(reads).toEqual(['reconnected'])
  })

  test('a resync names why the stream could not continue', async () => {
    const live = new FakeLive()
    const { environment } = testEnvironment(stubHost([]), live)
    await environment.settled()
    const lease = environment.acquireLive()
    const reads: string[] = []
    lease.onReconnected(({ reason }) => reads.push(reason))
    live.state('open')
    live.state('resyncing')
    live.resync('cursor_expired')
    live.state('open')
    expect(reads).toEqual(['cursor_expired'])
  })

  test('re-reads capabilities when the host announces new ones', async () => {
    const live = new FakeLive()
    const host = stubHost([op('workspace.files.list')])
    const { environment } = testEnvironment(host, live)
    await environment.settled()
    environment.acquireLive()
    const before = host.count('capabilities')
    live.emit('workspace.capabilities', { workspace_id: 'w1', version: '2' })
    await tick()
    expect(host.count('capabilities')).toBe(before + 1)
  })
})

describe('recovery', () => {
  test('a request the host says is for a workspace it has not opened reopens it and repeats once', async () => {
    const host = stubHost([op('workspace.files.list')])
    const answers = [
      Response.json({ code: 'workspace_not_open' }, { status: 404 }),
      Response.json({ ok: true }),
    ]
    let sent = 0
    const { environment, fetches } = testEnvironment(host, undefined, {
      fetch: async () => {
        sent += 1
        return answers.shift() ?? Response.json({ ok: true })
      },
    })
    await environment.settled()
    const opened = host.count('open')
    const events: string[] = []
    environment.subscribe((event) => events.push(event.type))
    const recovering = fetches[1]!
    const response = await recovering('/api/anything', {
      method: 'POST',
      headers: { 'X-CSRF-Token': 'stale' },
    })
    expect(response.status).toBe(200)
    expect(sent).toBe(2)
    expect(host.count('open')).toBe(opened + 1)
    expect(events).toContain('reopened')
  })

  test('seats a document again from the host', async () => {
    const host = stubHost([])
    const { environment } = testEnvironment(host)
    await environment.settled()
    await environment.seat('src/a.ts')
    expect(
      host.calls.find((call) => call.name === 'seat')?.request,
    ).toMatchObject({ resource_id: 'src/a.ts', workspaceId: 'w1' })
  })

  test('a failed reopen makes the environment unavailable and reports why', async () => {
    const host = stubHost([])
    const { environment } = testEnvironment(host)
    await environment.settled()
    host.on('open', () => {
      throw new HttpError(401)
    })
    await expect(environment.reopen()).rejects.toBeDefined()
    expect(environment.availability).toMatchObject({
      status: 'unavailable',
      cause: 'signed_out',
    })
  })
})
