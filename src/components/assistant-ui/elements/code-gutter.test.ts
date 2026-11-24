import { expect, test } from 'bun:test'
import { gutterDigits } from './code-gutter'
import type { GutterLine } from './code-lines'

test('gutter width follows displayed file numbers, including sparse diff rows', () => {
  expect(gutterDigits([])).toBe(1)
  expect(gutterDigits([{ change: 'hunk' }, { change: 'remove' }])).toBe(1)
  expect(gutterDigits([{ number: 7 }, { number: 1200 }, { number: 8 }])).toBe(4)
})

test('a large file sizes its gutter without a function argument limit', () => {
  const lines: GutterLine[] = Array(200_000).fill({ number: 1 })
  lines[lines.length - 1] = { number: 200_000 }
  expect(gutterDigits(lines)).toBe(6)
})
