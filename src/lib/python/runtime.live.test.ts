// Opt-in: runs the real Pyodide this package pins, with its packages from the
// CDN the page loads them from:
// THEOREM_TEST_REMOTE_DEPS=1 bun test src/lib/python/runtime.live.test.ts
import { beforeAll, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadPyodide, version } from 'pyodide'
import { preparePython, pyodideIndexURL, runPython } from './runtime'
import type { PreparedPython, PythonStream } from './runtime'

const live = process.env.THEOREM_TEST_REMOTE_DEPS === '1'
let python: PreparedPython
let output: Array<[PythonStream, string]> = []
const streamed = (stream: PythonStream) =>
  output
    .filter(([name]) => name === stream)
    .map(([, text]) => text)
    .join('')
const run = (request: Parameters<typeof runPython>[1]) => {
  output = []
  return runPython(python, request, (stream, text) =>
    output.push([stream, text]),
  )
}

beforeAll(async () => {
  if (!live) return
  // Under Node, Pyodide caches wheels in a directory, by default one named
  // after packageBaseUrl in the working directory.
  const py = await loadPyodide({
    packageBaseUrl: pyodideIndexURL(version),
    packageCacheDir: mkdtempSync(join(tmpdir(), 'theorem-pyodide-')),
  })
  python = await preparePython(py, (stream, text) =>
    output.push([stream, text]),
  )
}, 120_000)

test.skipIf(!live)(
  'a run gives back its output, last value and a numpy result as JSON',
  async () => {
    const result = await run({
      code: 'import numpy as np\nprint("hello")\nnp.arange(4) * 2',
    })
    expect(streamed('stdout')).toBe('hello\n')
    expect(result.value).toEqual({ json: [0, 2, 4, 6] })
    expect(result.loaded).toContain('numpy')
    expect(result.error).toBeUndefined()
  },
  120_000,
)

test.skipIf(!live)(
  'an error comes back as a traceback from the run code down',
  async () => {
    const result = await run({ code: 'def f():\n    1/0\nf()' })
    expect(result.error).toContain('ZeroDivisionError')
    expect(result.error).toContain('<python.run>')
    expect(result.error).not.toContain('_pyodide')
  },
)

test.skipIf(!live)(
  'figures come back as pictures and written files with their text',
  async () => {
    const result = await run({
      code: [
        'import matplotlib.pyplot as plt',
        'plt.plot([1, 3, 2])',
        'open("table.csv", "w").write("a,b\\n1,2\\n")',
        'open("input.txt").read()',
      ].join('\n'),
      files: { 'input.txt': 'given' },
    })
    expect(result.error).toBeUndefined()
    expect(result.value).toEqual({ json: 'given' })
    expect(result.figures).toHaveLength(1)
    expect(result.figures[0]).toMatchObject({
      type: 'image',
      mediaType: 'image/png',
    })
    expect(result.figures[0]!.width).toBeGreaterThan(100)
    expect(result.files).toEqual([
      { name: 'table.csv', bytes: 8, text: 'a,b\n1,2\n' },
    ])
  },
  120_000,
)

test.skipIf(!live)(
  'a session keeps its variables; a run without one starts empty',
  async () => {
    await run({ code: 'x = 41', session: 'a' })
    expect((await run({ code: 'x + 1', session: 'a' })).value).toEqual({
      json: 42,
    })
    expect((await run({ code: 'x' })).error).toContain('NameError')
  },
)

test.skipIf(!live)(
  'packages installs from PyPI with micropip',
  async () => {
    const result = await run({
      code: 'import tabulate\ntabulate.tabulate([[1, 2]])',
      packages: ['tabulate'],
    })
    expect(result.error).toBeUndefined()
    expect(result.value).toMatchObject({ json: expect.stringContaining('1') })
  },
  120_000,
)
