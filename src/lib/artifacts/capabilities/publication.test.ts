// The capability records reach Theorem as the OpenUI library record does:
// read the digest Theorem holds and PUT this build's records only when it
// differs. fetch is stubbed; no Theorem runs here.
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { sha256Hex } from '@/lib/blocks/last-run'
import { CAPABILITIES_PATH, syncCapabilityRecords } from './publication'
import { INTERFACE_RECORDS } from './records'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

type Call = { method: string; path: string; headers: Headers; body?: string }

function stubTheorem(published: () => Response) {
  const calls: Call[] = []
  const spy = spyOn(globalThis, 'fetch').mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : undefined
    const path = new URL(String(request?.url ?? input), window.location.origin).pathname
    const method = init?.method ?? request?.method ?? 'GET'
    const body = typeof init?.body === 'string' ? init.body : undefined
    calls.push({ method, path, headers: new Headers(init?.headers), body })
    if (path === '/api/chat/v1/bootstrap') return json({ schema: 'theorem.chat.bootstrap.v1', csrfToken: 'csrf' })
    if (path === CAPABILITIES_PATH && method === 'GET') return published()
    if (path === CAPABILITIES_PATH && method === 'PUT') {
      const sent = JSON.parse(body ?? '{}') as { digest: string; records: Array<{ id: string }> }
      return json({ digest: sent.digest, ids: sent.records.map((record) => record.id) })
    }
    return json({}, 404)
  }) as typeof fetch)
  return { calls, restore: () => spy.mockRestore() }
}

const page = (window as unknown as { happyDOM: { setURL: (url: string) => void } }).happyDOM
beforeAll(() => page.setURL('http://localhost:3000/'))
afterAll(() => page.setURL('about:blank'))

let restore = () => {}
afterEach(() => restore())

describe('capability record publication', () => {
  test('publishes every record, digest-addressed, when Theorem has none', async () => {
    const theorem = stubTheorem(() => json({ code: 'not_found' }, 404))
    restore = theorem.restore
    const held = await syncCapabilityRecords()
    const put = theorem.calls.find((call) => call.method === 'PUT')
    expect(put?.path).toBe('/api/artifacts/v1/capabilities')
    expect(put?.headers.get('X-CSRF-Token')).toBe('csrf')
    const sent = JSON.parse(put?.body ?? '{}')
    expect(sent.digest).toBe(await sha256Hex(JSON.stringify(INTERFACE_RECORDS)))
    expect(sent.records).toHaveLength(INTERFACE_RECORDS.length)
    expect(held.ids).toContain('format:observable')
  })

  test('leaves matching records alone', async () => {
    const digest = await sha256Hex(JSON.stringify(INTERFACE_RECORDS))
    const theorem = stubTheorem(() => json({ digest, ids: [] }))
    restore = theorem.restore
    await syncCapabilityRecords()
    expect(theorem.calls.some((call) => call.method === 'PUT')).toBe(false)
  })

  test('publishes again over a stale digest', async () => {
    const theorem = stubTheorem(() => json({ digest: 'old', ids: [] }))
    restore = theorem.restore
    await syncCapabilityRecords()
    expect(theorem.calls.some((call) => call.method === 'PUT')).toBe(true)
  })
})
