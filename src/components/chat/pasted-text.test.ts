import { expect, test } from 'bun:test'
import {
  PASTED_TEXT_MIN_CHARS,
  PASTED_TEXT_MIN_LINES,
  isLongPaste,
  isPastedText,
  lineCount,
  pastedTextFile,
  pastedTitle,
  takesPastedText,
  textSize,
} from './pasted-text'

test('a paste is long by its length or by its lines', () => {
  expect(isLongPaste('a'.repeat(PASTED_TEXT_MIN_CHARS - 1))).toBe(false)
  expect(isLongPaste('a'.repeat(PASTED_TEXT_MIN_CHARS))).toBe(true)
  expect(isLongPaste('x\n'.repeat(PASTED_TEXT_MIN_LINES - 2) + 'x')).toBe(false)
  expect(isLongPaste('x\n'.repeat(PASTED_TEXT_MIN_LINES - 1) + 'x')).toBe(true)
  expect(isLongPaste('')).toBe(false)
})

test('each pasted text is named apart from the ones already attached', async () => {
  const first = pastedTextFile('one', ['notes.md'])
  expect(first.name).toBe('Pasted text.txt')
  // Browsers keep the type as given; Bun adds a charset.
  expect(first.type.split(';', 1)[0]).toBe('text/plain')
  expect(await first.text()).toBe('one')
  expect(pastedTextFile('two', ['Pasted text.txt']).name).toBe(
    'Pasted text 2.txt',
  )
  // A removed one leaves its number free, and the next takes the highest.
  expect(
    pastedTextFile('three', ['Pasted text.txt', 'Pasted text 3.txt']).name,
  ).toBe('Pasted text 4.txt')
})

test('a pasted text is known by its name and plain type alone', () => {
  expect(isPastedText('Pasted text.txt', 'text/plain')).toBe(true)
  expect(isPastedText('Pasted text 12.txt', 'text/plain;charset=utf-8')).toBe(
    true,
  )
  expect(isPastedText('Pasted text.txt')).toBe(true)
  expect(isPastedText('Pasted text.txt', 'image/png')).toBe(false)
  expect(isPastedText('notes.txt', 'text/plain')).toBe(false)
  expect(isPastedText(undefined, 'text/plain')).toBe(false)
  expect(pastedTitle('Pasted text 2.txt')).toBe('Pasted text 2')
})

test("whether the composer's attachments take plain text", () => {
  expect(takesPastedText('image/png,text/plain,.md')).toBe(true)
  expect(takesPastedText('text/*')).toBe(true)
  expect(takesPastedText('*')).toBe(true)
  expect(takesPastedText('.txt')).toBe(true)
  expect(takesPastedText('image/png,application/pdf')).toBe(false)
  expect(takesPastedText('')).toBe(false)
})

test("a pasted text's size reads in lines and characters", () => {
  expect(lineCount('')).toBe(0)
  expect(lineCount('one')).toBe(1)
  expect(lineCount('one\ntwo\n')).toBe(3)
  expect(textSize('one')).toBe('1 line · 3 characters')
  expect(textSize('x\n'.repeat(1_000))).toBe('1,001 lines · 2,000 characters')
})
