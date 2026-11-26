// SOURCING: Pyodide's loader from the pyodide package, with its runtime and
// packages from jsDelivr for the same version (Pyodide's documented
// `indexURL`), and json-rpc-2.0 over the worker's port (sandbox/protocol.ts).
// Python runs here, off the page's thread.
import { loadPyodide, version } from 'pyodide'
import { rpcOver, serve } from '../blocks/sandbox/protocol'
import { preparePython, pyodideIndexURL, runPython } from './runtime'
import type { PythonStream } from './runtime'
import type { PythonWorkerMethods } from './runner'

const rpc = rpcOver(self)
const emit = (stream: PythonStream, text: string) =>
  rpc.notify('python.output', { stream, text }, undefined)

const started = performance.now()
const python = loadPyodide({ indexURL: pyodideIndexURL(version) }).then(
  async (py) => ({
    prepared: await preparePython(py, emit),
    loadMs: Math.round(performance.now() - started),
    python: py.runPython('import sys; sys.version.split()[0]') as string,
  }),
)

serve<PythonWorkerMethods, 'python.run'>(
  rpc,
  'python.run',
  async ({ request }) => {
    const { prepared, loadMs, python: pythonVersion } = await python
    return {
      ...(await runPython(prepared, request, emit)),
      python: pythonVersion,
      pyodide: version,
      loadMs,
    }
  },
)
