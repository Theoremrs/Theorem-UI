import { afterEach, expect, test } from 'bun:test'
import { clientSurfaceTurnOptions } from '@/lib/theorem/client-surface'
import { servePythonRequests } from '@/lib/python/operations'
import { normalUrl, pairingFromHash, setMachinePairing } from './machine'
import {
  MACHINE_COMPUTE,
  MACHINE_OPERATIONS,
  MAX_WAIT_SECONDS,
  answerMachineRequest,
  boundedCall,
} from './operations'

const pairing = {
  url: 'http://127.0.0.1:8083',
  token: 'a'.repeat(64),
}

const answering = (
  status: number,
  body: unknown,
  seen: Array<{ url: string; init: RequestInit }> = [],
) =>
  (async (url: string, init: RequestInit) => {
    seen.push({ url, init })
    return new Response(JSON.stringify(body), { status })
  }) as unknown as typeof fetch

afterEach(() => setMachinePairing(undefined))

test('the call is declared only while this browser is paired', () => {
  const names = () =>
    clientSurfaceTurnOptions().clientOperations.map(
      (operation) => operation.name,
    )
  expect(names()).not.toContain(MACHINE_COMPUTE)
  setMachinePairing(pairing)
  expect(names()).toContain(MACHINE_COMPUTE)
  expect(
    clientSurfaceTurnOptions().clientOperations.length,
  ).toBeLessThanOrEqual(20)
  expect(
    new TextEncoder().encode(MACHINE_OPERATIONS[0].description).length,
  ).toBeLessThanOrEqual(1024)
})

test('a pairing link fills the pairing from the fragment', () => {
  expect(
    pairingFromHash(
      `#machine=http%3A%2F%2F127.0.0.1%3A8083&token=${pairing.token}`,
    ),
  ).toEqual(pairing)
  expect(pairingFromHash('#machine=ftp%3A%2F%2Fhost&token=x')).toBeUndefined()
  expect(
    pairingFromHash('#machine=http%3A%2F%2Fhost&token=short'),
  ).toBeUndefined()
  expect(normalUrl('http://localhost:8083/')).toBe('http://localhost:8083')
})

test('a waiting call waits no longer than the page may', () => {
  expect(boundedCall({ action: 'run', request: {} }).wait_seconds).toBe(
    MAX_WAIT_SECONDS,
  )
  expect(
    boundedCall({ action: 'wait', job: 'j', wait_seconds: 600 }).wait_seconds,
  ).toBe(MAX_WAIT_SECONDS)
  expect(
    boundedCall({ action: 'wait', job: 'j', wait_seconds: 5 }).wait_seconds,
  ).toBe(5)
  expect(boundedCall({ action: 'logs', job: 'j' })).toEqual({
    action: 'logs',
    job: 'j',
  })
})

test('a call goes to the machine with its token and comes back without store URLs', async () => {
  const seen: Array<{ url: string; init: RequestInit }> = []
  const answer = await answerMachineRequest(
    { call: { action: 'run', request: { source: 'result = 1' } } },
    pairing,
    answering(
      200,
      {
        id: 'job-1',
        state: 'succeeded',
        outputs: [
          {
            name: 'fig',
            url: '/api/compute/v1/jobs/job-1/outputs/fig',
            ref: { job: 'job-1', output: 'fig' },
          },
        ],
      },
      seen,
    ),
  )
  const [sent] = seen
  expect(sent?.url).toBe('http://127.0.0.1:8083/v1/call')
  expect(new Headers(sent?.init.headers).get('Authorization')).toBe(
    `Bearer ${pairing.token}`,
  )
  expect(JSON.parse(String(sent?.init.body)).wait_seconds).toBe(
    MAX_WAIT_SECONDS,
  )
  expect(answer).toEqual({
    outcome: 'applied',
    result: {
      where: 'machine',
      machine: pairing.url,
      answer: {
        id: 'job-1',
        state: 'succeeded',
        outputs: [{ name: 'fig', ref: { job: 'job-1', output: 'fig' } }],
      },
    },
  })
})

test('the machine refusing a call is a rejection; not reaching it is a failure', async () => {
  const refused = await answerMachineRequest(
    { call: { action: 'status', job: 'nope' } },
    pairing,
    answering(404, { code: 'not_found', message: 'no job nope' }),
  )
  expect(refused).toEqual({ outcome: 'rejected', reason: 'no job nope' })
  const stale = await answerMachineRequest(
    { call: { action: 'jobs' } },
    pairing,
    answering(401, { message: 'a bearer credential is required' }),
  )
  expect(stale.outcome).toBe('failed')
  const away = await answerMachineRequest(
    { call: { action: 'jobs' } },
    pairing,
    (async () => {
      throw new TypeError('Failed to fetch')
    }) as unknown as typeof fetch,
  )
  expect(away.outcome).toBe('failed')
  expect(away.reason).toContain('did not answer')
  expect(
    (await answerMachineRequest({ call: { action: 'jobs' } }, undefined))
      .outcome,
  ).toBe('failed')
})

test("the page answers a machine call with the Python runs' receipts", async () => {
  const posted: Array<unknown> = []
  await servePythonRequests(
    [
      {
        runId: 'run-1',
        requestRef: 'machine-req-1',
        operation: MACHINE_COMPUTE,
        args: { call: { action: 'jobs' } },
        expectedRevision: 2,
      },
    ],
    async (_request, receipt) => {
      posted.push(receipt)
    },
  )
  // Unpaired: the call is answered, as a failure, with the run's revision.
  expect(posted).toEqual([
    {
      outcome: 'failed',
      reason:
        'This browser is no longer paired with a machine; compute elsewhere.',
      revision: 2,
    },
  ])
})
