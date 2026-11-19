import { expect, test } from 'bun:test'
import { occlusionMask, sameClientBoxes } from './occlusion'

test('an unchanged line measurement compares equal and a moved line does not', () => {
  const line = { left: 1, top: 2, right: 3, bottom: 4 }
  expect(sameClientBoxes([line], [{ ...line }])).toBe(true)
  expect(sameClientBoxes([line], [{ ...line, top: 8 }])).toBe(false)
  expect(sameClientBoxes([], [line])).toBe(false)
})

test('a covered cell is fully quiet and an uncovered one untouched', () => {
  const mask = occlusionMask([{ x0: 1, y0: 1, x1: 3, y1: 2 }], 6, 4, 0)
  expect(mask[1 * 6 + 1]).toBe(1)
  expect(mask[1 * 6 + 2]).toBe(1)
  expect(mask[1 * 6 + 3]).toBe(0)
  expect(mask[0]).toBe(0)
})

test('a rectangle that cuts a cell covers it by the share it takes', () => {
  const mask = occlusionMask([{ x0: 0.5, y0: 0, x1: 1, y1: 0.5 }], 2, 1, 0)
  expect(mask[0]).toBeCloseTo(0.25)
})

test('feathering softens the edge without leaving the covered cells', () => {
  const mask = occlusionMask([{ x0: 2, y0: 2, x1: 4, y1: 3 }], 8, 6, 1)
  expect(mask[2 * 8 + 2]).toBe(1)
  const beside = mask[2 * 8 + 1]!
  const below = mask[3 * 8 + 2]!
  expect(beside).toBeGreaterThan(0)
  expect(beside).toBeLessThan(1)
  expect(below).toBeGreaterThan(0)
  expect(below).toBeLessThan(1)
  expect(mask[0]).toBe(0)
})

test('two lines that meet inside a cell cover it together', () => {
  const mask = occlusionMask(
    [
      { x0: 0, y0: 0, x1: 1, y1: 0.4 },
      { x0: 0, y0: 0.4, x1: 1, y1: 1 },
    ],
    1,
    1,
    0,
  )
  expect(mask[0]).toBeCloseTo(1)
})

test('rectangles off the grid are clipped', () => {
  const mask = occlusionMask([{ x0: -3, y0: -3, x1: 1, y1: 1 }], 3, 3, 0)
  expect(mask[0]).toBe(1)
  expect(mask[1]).toBe(0)
})
