import { describe, expect, test } from 'bun:test'
import { isMac, isPasteChord } from './paste-chord'

const key = (over: Partial<Parameters<typeof isPasteChord>[0]> = {}) => ({
  key: 'v',
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  ...over,
})

describe('the browser paste chord', () => {
  test('on a Mac it is Cmd+V, and Ctrl+V stays a key for the terminal', () => {
    expect(isPasteChord(key({ metaKey: true }), true)).toBe(true)
    expect(isPasteChord(key({ metaKey: true, key: 'V' }), true)).toBe(true)
    expect(isPasteChord(key({ ctrlKey: true }), true)).toBe(false)
    expect(isPasteChord(key({ metaKey: true, ctrlKey: true }), true)).toBe(
      false,
    )
  })

  test('elsewhere it is Ctrl+V, with or without Shift', () => {
    expect(isPasteChord(key({ ctrlKey: true }), false)).toBe(true)
    expect(isPasteChord(key({ ctrlKey: true, key: 'V' }), false)).toBe(true)
    expect(isPasteChord(key({ metaKey: true }), false)).toBe(false)
  })

  test('a plain v, another letter and an Alt chord are not paste', () => {
    expect(isPasteChord(key(), true)).toBe(false)
    expect(isPasteChord(key({ metaKey: true, key: 'c' }), true)).toBe(false)
    expect(isPasteChord(key({ metaKey: true, altKey: true }), true)).toBe(false)
    expect(isPasteChord(key({ ctrlKey: true, altKey: true }), false)).toBe(
      false,
    )
  })

  test('a Mac is read from the platform or the user agent', () => {
    expect(isMac({ platform: 'MacIntel' })).toBe(true)
    expect(isMac({ platform: '', userAgent: 'Mozilla (Macintosh)' })).toBe(true)
    expect(isMac({ platform: 'Linux x86_64', userAgent: 'X11' })).toBe(false)
  })
})
