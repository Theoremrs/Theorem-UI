// SOURCING: a module Web Worker (Vite bundles `new Worker(new URL(…))`) and
// json-rpc-2.0 over its port (sandbox/protocol.ts): the page's side of the
// Python worker. A run past its time is stopped by ending the worker, since
// Pyodide is interrupted from another thread only through a SharedArrayBuffer,
// which needs a cross-origin-isolated page; the next run starts a new one.
import { call, rpcOver } from '../blocks/sandbox/protocol'
import type { PythonRequest, PythonRunResult, PythonStream } from './runtime'

export interface PythonWorkerMethods {
  'python.run': {
    params: { request: PythonRequest }
    result: PythonRunResult & {
      python: string
      pyodide: string
      loadMs: number
    }
  }
}

/** How much of each output stream comes back: its start and its end. */
export const OUTPUT_LIMITS: Record<PythonStream, number> = {
  stdout: 24_000,
  stderr: 12_000,
}

/** What a run in the browser came to. */
export type BrowserPythonOutcome = Partial<
  PythonWorkerMethods['python.run']['result']
> & {
  stdout: string
  stderr: string
  durationMs: number
  /** The run was stopped at its time limit; what it printed until then is kept. */
  timedOut?: true
}

/** A Python that runs one request at a time and can be stopped. */
export interface PythonEngine {
  run: (
    request: PythonRequest,
    onOutput: (stream: PythonStream, text: string) => void,
  ) => Promise<PythonWorkerMethods['python.run']['result']>
  stop: () => void
}

/** The page's Python worker, started on first use. */
export function workerEngine(): PythonEngine {
  const worker = new Worker(new URL('./python.worker.ts', import.meta.url), {
    type: 'module',
    name: 'theorem-python',
  })
  const rpc = rpcOver(worker)
  let onOutput: (stream: PythonStream, text: string) => void = () => {}
  rpc.addMethod('python.output', (params) => {
    const { stream, text } = params as { stream: PythonStream; text: string }
    onOutput(stream, text)
  })
  return {
    run: (request, output) => {
      onOutput = output
      return call<PythonWorkerMethods, 'python.run'>(rpc, 'python.run', {
        request,
      })
    },
    stop: () => {
      rpc.rejectAllPendingRequests('The Python worker was stopped.')
      worker.terminate()
    },
  }
}

/** Keeps the start and the end of a stream past its limit, and says how much is left out. */
export function clip(text: string, limit: number): string {
  if (text.length <= limit) return text
  const head = Math.floor(limit / 3)
  const tail = limit - head
  return `${text.slice(0, head)}\n[${text.length - limit} characters left out]\n${text.slice(-tail)}`
}

let engine: PythonEngine | null = null
let queue: Promise<unknown> = Promise.resolve()

/**
 * Runs a request in the page's Python, after any run before it, for at most
 * `timeoutMs` from when it starts. A run that does not finish in time is
 * stopped with the worker; one whose worker failed leaves it to be started
 * again.
 */
export function runInBrowser(
  request: PythonRequest,
  timeoutMs: number,
  start: () => PythonEngine = workerEngine,
): Promise<BrowserPythonOutcome> {
  const turn = queue.then(async (): Promise<BrowserPythonOutcome> => {
    const current = (engine ??= start())
    const output: Record<PythonStream, string> = { stdout: '', stderr: '' }
    const streams = () => ({
      stdout: clip(output.stdout, OUTPUT_LIMITS.stdout),
      stderr: clip(output.stderr, OUTPUT_LIMITS.stderr),
    })
    const began = performance.now()
    const elapsed = () => Math.round(performance.now() - began)
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<'late'>((resolve) => {
      timer = setTimeout(() => resolve('late'), timeoutMs)
    })
    try {
      const result = await Promise.race([
        current.run(request, (stream, text) => {
          output[stream] += text
        }),
        late,
      ])
      if (result === 'late') {
        current.stop()
        engine = null
        return { ...streams(), durationMs: elapsed(), timedOut: true }
      }
      return { ...result, ...streams(), durationMs: elapsed() }
    } catch (error) {
      current.stop()
      engine = null
      throw error
    } finally {
      clearTimeout(timer)
    }
  })
  queue = turn.catch(() => {})
  return turn
}

/** Forgets the page's Python, for tests. */
export function resetBrowserPython() {
  engine?.stop()
  engine = null
  queue = Promise.resolve()
}
