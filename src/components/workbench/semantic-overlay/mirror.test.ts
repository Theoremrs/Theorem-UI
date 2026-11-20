// SOURCING: none — bun:test over ./mirror with a plain object standing in for the textarea
import { describe, expect, test } from 'bun:test'
import { mirrorOf, settle, typedSince } from './mirror'
import type { InputMirror } from './mirror'

const at = (value: string, start: number, end = start, backward = false): InputMirror => ({
  value,
  start,
  end,
  backward,
})

describe('typedSince', () => {
  test('is the whole value when nothing is mirrored, as the input has always forwarded it', () => {
    expect(typedSince(undefined, 'a')).toBe('a')
    expect(typedSince(undefined, '')).toBe('')
  })

  test('is what lies between the text before the caret and the text after it', () => {
    expect(typedSince(at('hello', 5), 'hellox')).toBe('x')
    expect(typedSince(at('hello', 2), 'hexllo')).toBe('x')
    expect(typedSince(at('hello', 0), 'xhello')).toBe('x')
    expect(typedSince(at('', 0), 'abc')).toBe('abc')
  })

  test('typing over a selection takes the selection’s place, backwards or forwards', () => {
    expect(typedSince(at('hello', 1, 4), 'hXo')).toBe('X')
    expect(typedSince(at('hello', 1, 4, true), 'hXo')).toBe('X')
    expect(typedSince(at('hello', 0, 5), 'z')).toBe('z')
  })

  test('counts in UTF-16 units, so an emoji typed after one is whole', () => {
    expect(typedSince(at('a\u{1f600}', 3), 'a\u{1f600}\u{1f601}')).toBe('\u{1f601}')
  })

  test('is nothing when the field changed in a way typing at the caret cannot', () => {
    expect(typedSince(at('hello', 5), 'hell')).toBe('')
    expect(typedSince(at('hello', 5), 'jello!')).toBe('')
    expect(typedSince(at('hello', 2), 'hello')).toBe('')
    expect(typedSince(at('hello', 5), '')).toBe('')
  })
})

describe('settle', () => {
  function field(value: string) {
    const f = {
      value,
      selectionStart: 0,
      selectionEnd: 0,
      direction: '' as string,
      setSelectionRange(start: number, end: number, direction?: string) {
        f.selectionStart = start
        f.selectionEnd = end
        f.direction = direction ?? 'none'
      },
    }
    return f
  }

  test('puts the field back to the mirror with its caret, or to empty when there is none', () => {
    const f = field('hellox')
    settle(f, at('hello', 2, 4, true))
    expect([f.value, f.selectionStart, f.selectionEnd, f.direction]).toEqual(['hello', 2, 4, 'backward'])
    settle(f, undefined)
    expect(f.value).toBe('')
  })

  test('writes nothing when the field already holds the mirror, so the IME’s and the reader’s caret is not reset', () => {
    let writes = 0
    const f = {
      get value() {
        return 'hello'
      },
      set value(_: string) {
        writes += 1
      },
      selectionStart: 5,
      selectionEnd: 5,
      setSelectionRange() {},
    }
    settle(f, at('hello', 5))
    expect(writes).toBe(0)
  })
})

describe('mirrorOf', () => {
  test('reads the core’s anchor and focus: the caret is the focus, a backwards selection has it first', () => {
    expect(mirrorOf('hello', { anchor: 1, focus: 4 })).toEqual(at('hello', 1, 4, false))
    expect(mirrorOf('hello', { anchor: 4, focus: 1 })).toEqual(at('hello', 1, 4, true))
    expect(mirrorOf('hello', { anchor: 3, focus: 3 })).toEqual(at('hello', 3, 3, false))
  })

  test('keeps a caret the text no longer reaches inside it', () => {
    expect(mirrorOf('hi', { anchor: 9, focus: 9 })).toEqual(at('hi', 2, 2, false))
  })
})
