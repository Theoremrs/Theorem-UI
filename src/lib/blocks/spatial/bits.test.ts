// SOURCING: none: the width arithmetic parts.ts builds on, checked at the widths
// it supports: 1 to MAX_BITS. For bun:test only.
import { expect, test } from 'bun:test'
import { MAX_BITS, wrap } from './bits'
import { register } from './parts'

test('wrap keeps what the widest supported part holds', () => {
  expect(wrap(1, MAX_BITS)).toBe(1)
  expect(wrap(3, MAX_BITS)).toBe(3)
  expect(wrap(2 ** 53 - 1, MAX_BITS)).toBe(2 ** 53 - 1)
})

test('wrap reads a negative value as the unsigned number it stands for', () => {
  expect(wrap(-1, MAX_BITS)).toBe(2 ** 53 - 1)
  expect(wrap(-1, 8)).toBe(255)
  expect(wrap(-257, 8)).toBe(255)
})

test('wrap keeps narrower widths and whole spans exact', () => {
  expect(wrap(5, 8)).toBe(5)
  expect(wrap(255, 8)).toBe(255)
  expect(wrap(256, 8)).toBe(0)
  expect(wrap(257, 8)).toBe(1)
  expect(wrap(1, 1)).toBe(1)
  expect(wrap(2, 1)).toBe(0)
})

test('what is not a number is read as 0, and minus zero as zero', () => {
  expect(wrap('7', 8)).toBe(7)
  expect(wrap(3.9, 8)).toBe(3)
  expect(wrap(Number.NaN, 8)).toBe(0)
  expect(wrap(Number.POSITIVE_INFINITY, 8)).toBe(0)
  expect(wrap(-0, 8)).toBe(0)
  expect(Object.is(wrap(-0, 8), 0)).toBe(true)
})

test('a register starts at the value it is given, at every supported width', () => {
  expect(register({ id: 'r', bits: MAX_BITS, value: 1 }).state!.value).toBe(1)
  expect(
    register({ id: 'r', bits: MAX_BITS, value: 2 ** 53 - 1 }).state!.value,
  ).toBe(2 ** 53 - 1)
  expect(register({ id: 'r', bits: 8, value: 257 }).state!.value).toBe(1)
})
