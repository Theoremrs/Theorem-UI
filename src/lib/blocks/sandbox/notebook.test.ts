import { afterAll, expect, test } from 'bun:test'
import type { NotebookCell } from './notebook'

// An off-screen frame, or a tab nobody is looking at: no frame ever comes.
// Observable's runtime takes `requestAnimationFrame` when it loads, so the
// stand-in is in place before the runtime is imported.
const painted = globalThis.requestAnimationFrame
globalThis.requestAnimationFrame = () => 0
const { start } = await import('./notebook')

afterAll(() => {
  globalThis.requestAnimationFrame = painted
  document.body.replaceChildren()
})

const cell = (
  id: string,
  body: NotebookCell['body'],
  inputs: Array<string> = [],
  outputs: Array<string> = [],
): NotebookCell => ({ id, kind: 'js', body, inputs, outputs, autodisplay: outputs.length === 0 })

test('a notebook in a frame that is never painted still runs its cells', async () => {
  const root = document.createElement('main')
  document.body.append(root)
  start(
    [
      cell('rows', () => ({ rows: [1, 2, 3] }), [], ['rows']),
      cell('total', (rows) => (rows as Array<number>).length * 7, ['rows']),
    ],
    { root },
    {},
  )
  await new Promise((resolve) => setTimeout(resolve, 500))
  expect(root.querySelector('[data-cell-id="total"]')?.textContent).toContain('21')
})

// Setup a cell's readers depend on, kept out of the reply: a JavaScript cell
// of declarations compiles to `outputs` with `autodisplay: false`
// (cells.test.ts), so it shows nothing and its names stay in the graph.
test('a cell of declarations shows nothing and feeds the cells that read it', async () => {
  const root = document.createElement('main')
  document.body.append(root)
  start(
    [
      {
        id: 'setup',
        kind: 'js',
        body: () => ({ landscapes: { bowl: (x: number) => x * x }, simulate: (steps: number) => steps * 2 }),
        inputs: [],
        outputs: ['landscapes', 'simulate'],
        autodisplay: false,
      },
      cell('run', (landscapes, simulate) => (landscapes as { bowl: (x: number) => number }).bowl(3) + (simulate as (n: number) => number)(5), ['landscapes', 'simulate']),
    ],
    { root },
    {},
  )
  await new Promise((resolve) => setTimeout(resolve, 500))
  expect(root.querySelector('[data-cell-id="setup"]')?.textContent ?? '').toBe('')
  expect(root.querySelector('[data-cell-id="run"]')?.textContent).toContain('19')
})
