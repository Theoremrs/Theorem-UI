// SOURCING: none — bun:test over ./mount-wiring with stubs
import { describe, expect, test } from 'bun:test'
import { deliverReducedMotion, languagePortFor } from './mount-wiring'
import type { Language } from '@/lib/workbench/language/language'

describe('deliverReducedMotion', () => {
  test('hands the handle the preference now and on each change, until stopped', () => {
    const listeners = new Set<() => void>()
    const list = {
      matches: true,
      addEventListener: (_: string, l: () => void) => void listeners.add(l),
      removeEventListener: (_: string, l: () => void) => void listeners.delete(l),
    }
    const seen: boolean[] = []
    const stop = deliverReducedMotion(
      { set_reduced_motion: (r) => seen.push(r) },
      list as unknown as MediaQueryList,
    )
    list.matches = false
    listeners.forEach((l) => l())
    stop()
    expect(seen).toEqual([true, false])
    expect(listeners.size).toBe(0)
  })
})

describe('languagePortFor', () => {
  test('subscribes to the open documents, so the diagnostics feed runs', () => {
    let watched = 0
    const documents = {
      view: {
        list: () => [],
        on: () => {
          watched += 1
          return () => {}
        },
      },
    }
    const port = languagePortFor({} as unknown as Language, documents)
    const stop = port.subscribe!(() => {})
    expect(watched).toBeGreaterThan(0)
    stop()
  })
})
