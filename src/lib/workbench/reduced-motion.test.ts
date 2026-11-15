// SOURCING: none — bun:test over ./reduced-motion with a stub media query list
import { describe, expect, test } from 'bun:test'
import { watchReducedMotion } from './reduced-motion'

function query(matches: boolean) {
  const listeners = new Set<() => void>()
  const list = {
    matches,
    addEventListener: (_: string, listener: () => void) =>
      void listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) =>
      void listeners.delete(listener),
  }
  return {
    list: list as unknown as MediaQueryList,
    set(next: boolean) {
      list.matches = next
      listeners.forEach((listener) => listener())
    },
    count: () => listeners.size,
  }
}

describe('watchReducedMotion', () => {
  test('delivers the preference at once and again on each change, until stopped', () => {
    const q = query(true)
    const seen: boolean[] = []
    const stop = watchReducedMotion((reduced) => seen.push(reduced), q.list)
    expect(seen).toEqual([true])
    q.set(false)
    expect(seen).toEqual([true, false])
    stop()
    q.set(true)
    expect(seen).toEqual([true, false])
    expect(q.count()).toBe(0)
  })

  test('without a media query it delivers nothing', () => {
    const seen: boolean[] = []
    watchReducedMotion((r) => seen.push(r), null)()
    expect(seen).toEqual([])
  })
})
