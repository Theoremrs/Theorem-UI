import { describe, expect, test } from 'bun:test'
import { FRAME_BUILTINS, blockingCells, cellProblems, transpileCell } from './cells'

describe('a view read before it runs', () => {
  test('a cell that assigns another cell\'s value is told about mutable, not about its first line', () => {
    const chart = 'chart = {\n  const svg = d3.create("svg");\n  svg.on("click", () => { picked = [] });\n  return svg.node();\n}'
    expect(() => transpileCell(chart, 1)).toThrow(/Assignment to constant variable picked.*mutable picked = \.\.\./)
  })

  test('the mutable form it is told about runs', () => {
    expect(
      cellProblems([
        'mutable picked = []',
        'chart = {\n  const svg = d3.create("svg");\n  svg.on("click", () => { mutable picked = [1] });\n  return svg.node();\n}',
        'picked.length',
      ]),
    ).toEqual([])
  })

  test('a name no cell defines is named with its cell', () => {
    const problems = cellProblems([
      'viewof rate = Inputs.range([0, 1], {label: html`Rate ${r}`})',
      'Plot.plot({marks: [Plot.dot(data, {x: "a", y: (d) => d.b * rate})]})',
    ])
    expect(problems).toEqual(['Cell 1 reads `r`, which no cell defines.'])
  })

  test('an input bound as its element, which other cells read as a number, is named', () => {
    const problems = cellProblems(['k = Inputs.range([1, 100], {value: 20})', 'rate = Math.sqrt(k)'])
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('Cell 1 binds `k` to the input element')
    expect(cellProblems(['viewof k = Inputs.range([1, 100])', 'rate = Math.sqrt(k)'])).toEqual([])
    expect(cellProblems(['const k = view(Inputs.range([1, 100]))', 'Math.sqrt(k)'])).toEqual([])
  })

  test('an input view() shows in a cell `name = ...`, which displays its value instead, is named', () => {
    const problems = cellProblems(['k = view(Inputs.range([1, 100], {value: 20}))', 'Math.sqrt(k)'])
    expect(problems).toEqual([
      "Cell 1 shows `k`'s value in place of its input, as a cell `k = ...` displays what it defines: write `const k = view(Inputs...)` or `viewof k = Inputs...`.",
    ])
    expect(cellProblems(['const k = view(Inputs.range([1, 100], {value: 20}))', 'Math.sqrt(k)'])).toEqual([])
  })

  test('the pending cell the others wait on is named with every cell waiting on it', () => {
    const cells = [
      'const countries = view(Inputs.checkbox(["A", "B"], {value: ["A"]}))',
      'const span = view(Inputs.range([2005, 2023], {value: [2005, 2023]}))',
      'filtered = countries.map((c) => [c, span])',
      'Plot.lineY(filtered).plot()',
      'const later = new Promise(() => {})',
    ]
    expect([...blockingCells(cells, [1, 2, 3, 4])]).toEqual([[1, [2, 3]]])
    expect([...blockingCells(cells, [4])]).toEqual([])
  })

  test('a name two cells define is reported once', () => {
    expect(cellProblems(['rows = []', 'rows = [1]'])).toEqual(['Cells 1 and 2 each define `rows`; one cell defines each name.'])
  })

  test('both dialects, builtins and browser globals read clean', () => {
    expect(
      cellProblems([
        'const k = view(Inputs.range([0, 1], {value: 0.5}))',
        'display(Plot.lineY(data, {y: (d) => d * k}).plot({width}))',
        'viewof n = Inputs.range([1, 10], {step: 1})',
        'total = d3.sum(d3.range(n)) + Math.max(0, now % 1)',
        'md`Total: ${total}`',
        '{ const timer = setTimeout(() => {}, 10); invalidation.then(() => clearTimeout(timer)); return localStorage === undefined }',
      ]),
    ).toEqual([])
  })

  test('the builtins named here are every name notebook-kit\'s library defines', async () => {
    // The library reads `document` once, as it loads; a test without a DOM is lent a stand-in.
    const had = 'document' in globalThis
    const previous = (globalThis as { document?: unknown }).document
    if (!had) Object.assign(globalThis, { document: { querySelector: () => null, body: {} } })
    try {
      const { library } = await import('@observablehq/notebook-kit/runtime')
      for (const name of Object.keys(library)) expect(FRAME_BUILTINS.has(name)).toBe(true)
    } finally {
      if (!had) delete (globalThis as { document?: unknown }).document
      else Object.assign(globalThis, { document: previous })
    }
  })
})
