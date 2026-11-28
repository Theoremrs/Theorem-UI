// SOURCING: bun:test over app-compute.ts, against a fake of the backend's
// compute routes that keeps their rules: reads need no CSRF, writes need a
// current CSRF token and an Idempotency-Key, refusals carry `error.code`.
import { expect, test } from 'bun:test'
import { COMPUTE_ROUTE, ComputeRefused, appCompute } from './app-compute'

function backend(token = 'csrf-2') {
  const seen: Array<{
    url: string
    headers: Record<string, string>
    body?: unknown
  }> = []
  const request = async (input: string, init: RequestInit) => {
    const headers = Object.fromEntries(new Headers(init.headers).entries())
    const body = init.body ? JSON.parse(String(init.body)) : undefined
    seen.push({ url: input, headers, body })
    if (input.endsWith('/outputs/loss'))
      return new Response(new Uint8Array([137, 80, 78, 71]), {
        headers: { 'content-type': 'image/png' },
      })
    if (input.includes('/outputs/'))
      return Response.json(
        {
          error: {
            code: 'not_found',
            message: 'job cj_1 has no output named missing',
          },
        },
        { status: 404 },
      )
    const action = (body as { action: string }).action
    if (action === 'status')
      return Response.json({ id: 'cj_1', state: 'succeeded' })
    if (headers['x-csrf-token'] !== token)
      return Response.json(
        { error: { code: 'csrf_token_invalid' } },
        { status: 403 },
      )
    if (!headers['idempotency-key'])
      return Response.json(
        { error: { code: 'idempotency_key_required' } },
        { status: 400 },
      )
    return Response.json({ id: 'cj_2', state: 'succeeded', rerun_of: 'cj_1' })
  }
  return { seen, request }
}

test('a rerun is a write: it carries CSRF and a key, and retries once with a fresh token', async () => {
  const { seen, request } = backend()
  const compute = appCompute({
    request,
    csrf: async (fresh) => (fresh ? 'csrf-2' : 'csrf-1'),
  })
  const view = await compute.call({
    action: 'rerun',
    job: 'cj_1',
    params: { steps: 5 },
  })
  expect(view).toEqual({ id: 'cj_2', state: 'succeeded', rerun_of: 'cj_1' })
  expect(seen.map((s) => s.url)).toEqual([
    `${COMPUTE_ROUTE}/calls`,
    `${COMPUTE_ROUTE}/calls`,
  ])
  const [first, retry] = seen
  expect(first?.headers['idempotency-key']).toBeString()
  expect(retry?.headers['idempotency-key']).toBe(
    first?.headers['idempotency-key'],
  )
  expect(retry?.body).toEqual({
    action: 'rerun',
    job: 'cj_1',
    params: { steps: 5 },
  })
})

test('a status read sends no CSRF', async () => {
  const { seen, request } = backend()
  let asked = false
  const compute = appCompute({
    request,
    csrf: async () => {
      asked = true
      return 'csrf-2'
    },
  })
  expect(await compute.call({ action: 'status', job: 'cj_1' })).toEqual({
    id: 'cj_1',
    state: 'succeeded',
  })
  expect(asked).toBe(false)
  expect(seen[0]?.headers['x-csrf-token']).toBeUndefined()
})

test('an output comes back as bytes with its media type; a refusal keeps its code', async () => {
  const { request } = backend()
  const compute = appCompute({ request, csrf: async () => 'csrf-2' })
  const loss = await compute.output('cj_1', 'loss')
  expect(loss.mediaType).toBe('image/png')
  expect([...loss.bytes]).toEqual([137, 80, 78, 71])
  const refused = await compute
    .output('cj_1', 'missing')
    .catch((error: unknown) => error)
  expect(refused).toBeInstanceOf(ComputeRefused)
  expect((refused as ComputeRefused).code).toBe('not_found')
  expect((refused as ComputeRefused).status).toBe(404)
})
