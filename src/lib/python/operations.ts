// SOURCING: Theorem's client operations (theorem-surface-contracts
// client_operation), as the App check uses them (lib/blocks/app-operations.ts):
// a send declares `python.run`, a call streams a pending `client_operation`
// part, and the page answers with a `client-operation-receipt` command through
// @theoremharness/sdk's chat.runs.command; @tanstack/react-query's
// MutationObserver retries a receipt that failed to post. The run is Pyodide's
// in the page's worker (runner.ts); a `machine.compute` call goes the same way
// to the person's own machine (lib/machine/operations.ts).
import type { ThreadMessage } from '@assistant-ui/react'
import { MutationObserver, QueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { MACHINE_COMPUTE, answerMachineRequest } from '@/lib/machine/operations'
import type { MachineAnswer } from '@/lib/machine/operations'
import { hasStatus, mutate, theorem } from '@/lib/theorem/client'
import { runInBrowser } from './runner'
import type { BrowserPythonOutcome } from './runner'
import type { PythonRequest } from './runtime'

/** The operation that runs Python in the person's browser, as the turn's tool `python__run`. */
export const PYTHON_RUN = 'python.run'

/**
 * The longest a run may take. A turn waits two minutes for the page's
 * answer, and a specialist's run one; a run is kept inside the shorter.
 */
export const MAX_RUN_SECONDS = 55
const DEFAULT_RUN_SECONDS = 45
const MAX_CODE = 200_000

export const PYTHON_OPERATIONS = [
  {
    name: PYTHON_RUN,
    description: `Runs Python 3.14 in the person's browser with Pyodide, at no cost, so it is the first place to run Python. numpy, scipy, pandas, matplotlib, scikit-learn, sympy, statsmodels, networkx, polars, duckdb, astropy, scikit-image and the rest of Pyodide's packages load from the code's imports; \`packages\` installs others from PyPI with micropip, which takes pure-Python wheels. It reaches the network through the browser (requests, urllib, pyodide.http.pyfetch), so a server must allow CORS. It has one thread, no GPU, at most 4 GB of memory and ${MAX_RUN_SECONDS} s a run; use hosted computation for a GPU, a compiled package Pyodide lacks, or a longer run. The result has stdout, stderr, the last expression's value, a traceback on error, the files the run wrote, and open matplotlib figures as images. \`session\` keeps variables and files between runs while the page is open; \`files\` writes text files to the working directory first.`,
    effect: 'read',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['code'],
      properties: {
        code: {
          type: 'string',
          minLength: 1,
          maxLength: MAX_CODE,
          description: 'The Python to run. Its last expression is the value.',
        },
        packages: {
          type: 'array',
          maxItems: 32,
          items: { type: 'string', minLength: 1, maxLength: 200 },
          description:
            'Packages to install with micropip first: PyPI names, version specifiers or wheel URLs.',
        },
        files: {
          type: 'object',
          maxProperties: 32,
          additionalProperties: { type: 'string', maxLength: 1_000_000 },
          description:
            'Text files to write first, by path in the working directory.',
        },
        session: {
          type: 'string',
          pattern: '^[A-Za-z0-9_-]{1,64}$',
          description:
            'A name; runs with the same one share variables and files.',
        },
        timeoutSeconds: {
          type: 'integer',
          minimum: 1,
          maximum: MAX_RUN_SECONDS,
          description: `How long the run may take. Default ${DEFAULT_RUN_SECONDS}.`,
        },
      },
    },
  },
] as const

/** What a send carries so the turn can run Python in the page. */
export const pythonTurnOptions = () => ({ clientOperations: PYTHON_OPERATIONS })

/** One request the run made of the page's Python, read off a message. */
export interface PythonRunRequest {
  readonly runId: string
  readonly requestRef: string
  readonly operation: string
  readonly args: Record<string, unknown>
  /** A run changes nothing on the page, so the receipt names the revision the run expected. */
  readonly expectedRevision: number
}

const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

function pendingPythonRequests(
  runId: string,
  content: ThreadMessage['content'],
): Array<PythonRunRequest> {
  return content.flatMap((part) => {
    if (part.type !== 'data' || part.name !== 'theorem-client_operation')
      return []
    const data = record(part.data)
    const { requestRef, operation, expectedRevision } = data
    if (
      (data.state ?? 'pending') !== 'pending' ||
      typeof requestRef !== 'string' ||
      typeof operation !== 'string' ||
      !(operation.startsWith('python.') || operation === MACHINE_COMPUTE)
    )
      return []
    return [
      {
        runId,
        requestRef,
        operation,
        args: record(data.args),
        expectedRevision:
          typeof expectedRevision === 'number' ? expectedRevision : 0,
      },
    ]
  })
}

/** The Python requests pending in the conversation's live turn. */
export function pythonRequestsOf(
  messages: readonly ThreadMessage[],
  running: boolean,
): Array<PythonRunRequest> {
  const last = messages.at(-1)
  if (!running || last?.role !== 'assistant') return []
  const runId = record(last.metadata.custom).theoremRunId
  if (typeof runId !== 'string') return []
  return pendingPythonRequests(runId, last.content)
}

/** The Python requests pending in a specialist's run, which the page follows by its id. */
export function pythonRequestsOfRun(
  runId: string,
  message: ThreadMessage | undefined,
): Array<PythonRunRequest> {
  if (message?.status?.type !== 'running') return []
  return pendingPythonRequests(runId, message.content)
}

/** What the page says back: what the run came to, or why there was none. */
export interface PythonAnswer {
  readonly outcome: 'applied' | 'rejected' | 'failed'
  readonly reason?: string
  readonly result?: BrowserPythonOutcome & { where: 'browser' }
}

/** What the page says back to a Python run or a call on the person's machine. */
type Answer = PythonAnswer | MachineAnswer

/** The session pattern the declaration states. */
const SESSION = /^[A-Za-z0-9_-]{1,64}$/

/** A path that stays inside the run's directory: relative, with no `..` part. */
const insideRun = (path: string) =>
  path !== '' &&
  !path.startsWith('/') &&
  !/^[A-Za-z]:/.test(path) &&
  !path.split(/[\\/]/).some((part) => part === '..')

const strings = (value: unknown) =>
  Array.isArray(value) && value.every((item) => typeof item === 'string')

/** Reads the arguments the declaration admits; anything else is not a run. */
function requestOf(args: Record<string, unknown>): PythonRequest | string {
  const { code, packages, files, session } = args
  if (typeof code !== 'string' || !code)
    return 'Pass the Python to run as code.'
  if (packages !== undefined && !strings(packages))
    return 'packages is a list of package names.'
  if (files !== undefined) {
    if (
      typeof files !== 'object' ||
      files === null ||
      Array.isArray(files) ||
      !Object.values(files).every((text) => typeof text === 'string')
    )
      return 'files maps paths to text.'
    const outside = Object.keys(files).find((path) => !insideRun(path))
    if (outside !== undefined)
      return `files paths are relative to the run's directory; ${JSON.stringify(outside)} is not.`
  }
  if (session !== undefined && (typeof session !== 'string' || !SESSION.test(session)))
    return 'session is 1 to 64 letters, digits, - or _.'
  return {
    code,
    ...(packages ? { packages: packages } : {}),
    ...(files ? { files: files as Record<string, string> } : {}),
    ...(typeof session === 'string' ? { session } : {}),
  }
}

const failure = (error: unknown) =>
  error instanceof Error ? error.message : String(error)

/**
 * Answers one request. A run whose code raised or ran out of time is
 * `applied`: it ran, and the result says how it ended. `failed` is a run that
 * could not start, such as Pyodide not loading.
 */
export async function answerPythonRequest(
  request: PythonRunRequest,
  run: typeof runInBrowser = runInBrowser,
): Promise<PythonAnswer> {
  if (request.operation !== PYTHON_RUN)
    return {
      outcome: 'rejected',
      reason: `This page has no operation ${request.operation}.`,
    }
  const python = requestOf(request.args)
  if (typeof python === 'string') return { outcome: 'rejected', reason: python }
  const seconds = request.args.timeoutSeconds
  const timeoutSeconds =
    typeof seconds === 'number' && seconds >= 1
      ? Math.min(seconds, MAX_RUN_SECONDS)
      : DEFAULT_RUN_SECONDS
  try {
    const outcome = await run(python, timeoutSeconds * 1000)
    return {
      outcome: 'applied',
      result: {
        ...outcome,
        ...(outcome.timedOut
          ? {
              error: `The run was stopped after ${timeoutSeconds} s. Its variables and session are gone; a longer run belongs on hosted computation.`,
            }
          : {}),
        where: 'browser',
      },
    }
  } catch (error) {
    return {
      outcome: 'failed',
      reason: `Python could not run in the browser: ${failure(error)}`,
    }
  }
}

function postReceipt(
  request: PythonRunRequest,
  receipt: Answer & { revision: number },
) {
  return mutate((headers) =>
    theorem().chat.runs.command({
      runId: request.runId,
      command: 'client-operation-receipt',
      requestRef: request.requestRef,
      receipt: { ...receipt },
      ...headers,
    }),
  )
}

const RECEIPT_RETRIES = 6
const receiptDelay = (failures: number) => Math.min(500 * 2 ** failures, 8_000)
const receipts = new QueryClient()
// Mounted for the page's life: only a mounted client resumes what it paused offline.
receipts.mount()
const served = new Set<string>()

/**
 * Answers each request once, whichever conversation reports it. The runs
 * themselves go one at a time through the page's Python (runner.ts). A
 * receipt that fails to post is sent again; the code is not run again.
 */
export function servePythonRequests(
  requests: ReadonlyArray<PythonRunRequest>,
  post: (
    request: PythonRunRequest,
    receipt: Answer & { revision: number },
  ) => Promise<unknown> = postReceipt,
  run: typeof runInBrowser = runInBrowser,
  retryDelay: (failures: number) => number = receiptDelay,
): Promise<unknown> {
  return Promise.all(
    requests
      .filter((request) => !served.has(request.requestRef))
      .map(async (request) => {
        served.add(request.requestRef)
        const answer: Answer =
          request.operation === MACHINE_COMPUTE
            ? await answerMachineRequest(request.args)
            : await answerPythonRequest(request, run)
        await new MutationObserver(receipts, {
          mutationFn: (receipt: Answer & { revision: number }) =>
            post(request, receipt),
          retry: (failures, error) =>
            failures < RECEIPT_RETRIES && !hasStatus(error, 400, 404, 409, 422),
          retryDelay,
        })
          .mutate({ ...answer, revision: request.expectedRevision })
          .catch((error: unknown) => {
            console.warn('The Python run could not answer its run', error)
          })
      }),
  )
}

/** The part of an assistant-ui thread runtime requests are read from. */
interface ThreadSource {
  readonly thread: {
    getState: () => {
      readonly messages: readonly ThreadMessage[]
      readonly isRunning: boolean
    }
    subscribe: (callback: () => void) => () => void
  }
}

/** Serves Python requests from one conversation for as long as it is mounted. */
export function usePythonRequests(runtime: ThreadSource) {
  useEffect(() => {
    const serve = () => {
      const { messages, isRunning } = runtime.thread.getState()
      void servePythonRequests(pythonRequestsOf(messages, isRunning))
    }
    serve()
    return runtime.thread.subscribe(serve)
  }, [runtime])
}

/** Serves the Python requests of one specialist's run for as long as it is mounted. */
export function useSpecialistPythonRequests(
  runId: string,
  message: ThreadMessage | undefined,
) {
  useEffect(() => {
    void servePythonRequests(pythonRequestsOfRun(runId, message))
  }, [runId, message])
}
