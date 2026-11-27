// SOURCING: bun:test over oncePerRealm (export.ts), the owner of the page's
// one started esbuild. The browser compiler itself needs Vite's wasm URL, so
// the owner is checked here and the compiler in the running page.
import { expect, test } from 'bun:test'
import { oncePerRealm } from './export'

test('every copy of a module shares what the realm made, as esbuild allows one initialize', async () => {
  const key = `test.once.${crypto.randomUUID()}`
  let made = 0
  const make = async () => ++made
  // A module evaluated again holds no state of its own: only the key is shared.
  const [first, second] = await Promise.all([
    oncePerRealm(key, make),
    oncePerRealm(key, make),
  ])
  expect([first, second, await oncePerRealm(key, make)]).toEqual([1, 1, 1])
  expect(made).toBe(1)
})

test('a start that failed is tried again by the next caller', async () => {
  const key = `test.once.${crypto.randomUUID()}`
  let attempts = 0
  const make = async () => {
    attempts += 1
    if (attempts === 1) throw new Error('the wasm did not load')
    return 'started'
  }
  await expect(oncePerRealm(key, make)).rejects.toThrow('the wasm did not load')
  expect(await oncePerRealm(key, make)).toBe('started')
  expect(attempts).toBe(2)
})
