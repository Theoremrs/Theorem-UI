import { expect, test } from 'bun:test'
import type { ThreadMessage } from '@assistant-ui/react'
import { clientSurfaceTurnOptions } from '@/lib/theorem/client-surface'
import {
  MAX_RUN_SECONDS,
  PYTHON_OPERATIONS,
  PYTHON_RUN,
  answerPythonRequest,
  pythonRequestsOf,
  servePythonRequests,
} from './operations'
import type { PythonRunRequest } from './operations'
import type { runInBrowser } from './runner'

const request = (
  args: Record<string, unknown>,
  requestRef = 'req-1',
): PythonRunRequest => ({
  runId: 'run-1',
  requestRef,
  operation: PYTHON_RUN,
  args,
  expectedRevision: 3,
})

const ran: typeof runInBrowser = async (python, timeoutMs) => ({
  stdout: `${python.code} in ${timeoutMs}\n`,
  stderr: '',
  durationMs: 5,
  figures: [],
  files: [],
  loaded: [],
})

test('every send declares the run, within what Theorem admits', () => {
  const { clientOperations } = clientSurfaceTurnOptions()
  expect(clientOperations.map((operation) => operation.name)).toContain(
    PYTHON_RUN,
  )
  expect(clientOperations.length).toBeLessThanOrEqual(20)
  const description = new TextEncoder().encode(PYTHON_OPERATIONS[0].description)
  expect(description.length).toBeLessThanOrEqual(1024)
  expect(
    new TextEncoder().encode(JSON.stringify(PYTHON_OPERATIONS[0].inputSchema))
      .length,
  ).toBeLessThanOrEqual(8 * 1024)
})

test('pending python requests are read off the live turn only', () => {
  const message = {
    role: 'assistant',
    metadata: { custom: { theoremRunId: 'run-9' } },
    content: [
      {
        type: 'data',
        name: 'theorem-client_operation',
        data: {
          requestRef: 'r1',
          operation: 'python.run',
          args: { code: '1' },
        },
      },
      {
        type: 'data',
        name: 'theorem-client_operation',
        data: { requestRef: 'r2', operation: 'app.check', args: {} },
      },
      {
        type: 'data',
        name: 'theorem-client_operation',
        data: { requestRef: 'r3', operation: 'python.run', state: 'applied' },
      },
    ],
  } as unknown as ThreadMessage
  expect(pythonRequestsOf([message], true)).toEqual([
    {
      runId: 'run-9',
      requestRef: 'r1',
      operation: 'python.run',
      args: { code: '1' },
      expectedRevision: 0,
    },
  ])
  expect(pythonRequestsOf([message], false)).toEqual([])
})

test('a run is applied with its outcome, in the browser, within its time', async () => {
  expect(
    await answerPythonRequest(request({ code: 'x', timeoutSeconds: 9 }), ran),
  ).toEqual({
    outcome: 'applied',
    result: {
      stdout: 'x in 9000\n',
      stderr: '',
      durationMs: 5,
      figures: [],
      files: [],
      loaded: [],
      where: 'browser',
    },
  })
  const capped = await answerPythonRequest(
    request({ code: 'x', timeoutSeconds: 9999 }),
    ran,
  )
  expect(capped.result?.stdout).toBe(`x in ${MAX_RUN_SECONDS * 1000}\n`)
})

test('a run stopped at its time says so, and a run that cannot start fails', async () => {
  const late: typeof runInBrowser = async () => ({
    stdout: 'partial',
    stderr: '',
    durationMs: 9,
    timedOut: true,
  })
  const stopped = await answerPythonRequest(
    request({ code: 'x', timeoutSeconds: 2 }),
    late,
  )
  expect(stopped.outcome).toBe('applied')
  expect(stopped.result?.error).toContain('stopped after 2 s')
  expect(stopped.result?.stdout).toBe('partial')
  const broken: typeof runInBrowser = () =>
    Promise.reject(new Error('no network'))
  expect(await answerPythonRequest(request({ code: 'x' }), broken)).toEqual({
    outcome: 'failed',
    reason: 'Python could not run in the browser: no network',
  })
})

test('a request without code, or for another operation, is rejected', async () => {
  expect((await answerPythonRequest(request({}), ran)).outcome).toBe('rejected')
  expect(
    await answerPythonRequest(
      { ...request({ code: 'x' }), operation: 'python.other' },
      ran,
    ),
  ).toMatchObject({ outcome: 'rejected' })
})

test('each request is run and answered once, with the revision the run expected', async () => {
  const posted: Array<[string, unknown]> = []
  let runs = 0
  const counted: typeof runInBrowser = async (...args) => {
    runs += 1
    return ran(...args)
  }
  const post = async (answered: PythonRunRequest, receipt: unknown) => {
    posted.push([answered.requestRef, receipt])
  }
  const once = request({ code: 'x' }, 'once')
  await servePythonRequests([once], post, counted)
  await servePythonRequests([once], post, counted)
  expect(runs).toBe(1)
  expect(posted).toHaveLength(1)
  expect(posted[0]![1]).toMatchObject({ outcome: 'applied', revision: 3 })
})
