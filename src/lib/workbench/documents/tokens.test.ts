// SOURCING: none — bun:test over ./tokens
import { describe, expect, test } from 'bun:test'
import { languageOfPath, tokenSpans } from './tokens'

describe('tokenSpans', () => {
  test('spans are UTF-16 offsets into the text and cover only classed tokens', () => {
    const text = 'const a = "x"\n'
    const spans = tokenSpans('a.ts', text)!
    expect(spans.length).toBeGreaterThan(0)
    for (const span of spans) {
      expect(span.start).toBeLessThan(span.end)
      expect(span.end).toBeLessThanOrEqual(text.length)
      expect(span.class).not.toBe('')
    }
    const keyword = spans.find(
      (span) => text.slice(span.start, span.end) === 'const',
    )
    expect(keyword).toBeDefined()
    expect(
      spans.some((span) => text.slice(span.start, span.end) === '"x"'),
    ).toBe(true)
  })

  test('an astral character counts as two code units, so later spans move by two', () => {
    const text = 'const s = "😀"\nconst t = 1\n'
    const spans = tokenSpans('a.ts', text)!
    const second = spans.filter(
      (span) => text.slice(span.start, span.end) === 'const',
    )[1]!
    expect(second.start).toBe(text.indexOf('const', 1))
  })

  test('a file with no grammar has no spans, and an empty file has none to draw', () => {
    expect(tokenSpans('notes.xyz', 'hello')).toBeUndefined()
    expect(tokenSpans('a.ts', '')).toEqual([])
  })

  test('the language comes from the extension or the whole name', () => {
    expect(languageOfPath('src/a.rs')).toBe('rust')
    expect(languageOfPath('Dockerfile')).toBeDefined()
    expect(languageOfPath('README')).toBeUndefined()
  })
})
