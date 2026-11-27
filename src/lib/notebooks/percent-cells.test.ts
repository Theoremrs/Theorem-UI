import { describe, expect, test } from 'bun:test'
import { joinCells, splitCells } from './percent-cells'

describe('percent cells', () => {
  test('cells read back as they were joined', () => {
    const cells = ['const data = [1, 2, 3]', 'view(Inputs.range([0, 10]))\n\nPlot.dot(data).plot()']
    const text = joinCells(cells)
    expect(text).toBe(
      '// %%\nconst data = [1, 2, 3]\n// %%\nview(Inputs.range([0, 10]))\n\nPlot.dot(data).plot()',
    )
    expect(splitCells(text)).toEqual(cells)
  })

  test('a new marker splits a cell and a removed one joins two', () => {
    expect(splitCells('// %%\na\n// %% chart\nb')).toEqual(['a', 'b'])
    expect(splitCells('// %%\na\nb')).toEqual(['a\nb'])
  })

  test('text before the first marker is a cell, and an empty cell is none', () => {
    expect(splitCells('x = 1\n// %%\n\n// %%\ny')).toEqual(['x = 1', 'y'])
    expect(splitCells('')).toEqual([])
  })
})
