import { afterEach, expect, test } from 'bun:test'
import { clip, resetBrowserPython, runInBrowser } from './runner'
import type { PythonEngine } from './runner'

afterEach(resetBrowserPython)

const done = {
  figures: [],
  files: [],
  loaded: [],
  python: '3.14.2',
  pyodide: '314.0.7',
  loadMs: 1,
}

/** An engine that prints, then answers when `finish` is called. */
function engine() {
  const calls: Array<string> = []
  let finish: () => void = () => {}
  let stopped = 0
  const value: PythonEngine = {
    run: (request, onOutput) => {
      calls.push(request.code)
      onOutput('stdout', `ran ${request.code}\n`)
      return new Promise((resolve) => {
        finish = () => resolve({ ...done, value: { json: request.code } })
      })
    },
    stop: () => {
      stopped += 1
    },
  }
  return {
    value,
    calls,
    finish: () => finish(),
    stopped: () => stopped,
  }
}

test('a run gives back what it printed and its result', async () => {
  const fake = engine()
  const run = runInBrowser({ code: 'a' }, 1000, () => fake.value)
  await Bun.sleep(0)
  fake.finish()
  expect(await run).toMatchObject({
    stdout: 'ran a\n',
    stderr: '',
    value: { json: 'a' },
    pyodide: '314.0.7',
  })
})

test('runs go one at a time on one engine', async () => {
  const fake = engine()
  let started = 0
  const start = () => {
    started += 1
    return fake.value
  }
  const first = runInBrowser({ code: 'a' }, 1000, start)
  const second = runInBrowser({ code: 'b' }, 1000, start)
  await Bun.sleep(0)
  expect(fake.calls).toEqual(['a'])
  fake.finish()
  await first
  await Bun.sleep(0)
  expect(fake.calls).toEqual(['a', 'b'])
  fake.finish()
  expect((await second).value).toEqual({ json: 'b' })
  expect(started).toBe(1)
})

test('a run past its time is stopped with its output kept, and the next starts afresh', async () => {
  const fake = engine()
  let started = 0
  const start = () => {
    started += 1
    return fake.value
  }
  const outcome = await runInBrowser({ code: 'slow' }, 10, start)
  expect(outcome).toMatchObject({ stdout: 'ran slow\n', timedOut: true })
  expect(fake.stopped()).toBe(1)
  const next = runInBrowser({ code: 'b' }, 1000, start)
  await Bun.sleep(0)
  fake.finish()
  await next
  expect(started).toBe(2)
})

test('an engine that fails is stopped and the error passes on', async () => {
  const stopped: Array<true> = []
  const failing: PythonEngine = {
    run: () => Promise.reject(new Error('Pyodide did not load')),
    stop: () => stopped.push(true),
  }
  expect(runInBrowser({ code: 'a' }, 1000, () => failing)).rejects.toThrow(
    'Pyodide did not load',
  )
  await Bun.sleep(0)
  expect(stopped).toHaveLength(1)
})

test('long output keeps its start and end', () => {
  const text = `${'a'.repeat(50)}${'b'.repeat(50)}`
  const clipped = clip(text, 30)
  expect(clipped.startsWith('a'.repeat(10))).toBe(true)
  expect(clipped.endsWith('b'.repeat(20))).toBe(true)
  expect(clipped).toContain('[70 characters left out]')
  expect(clip('short', 30)).toBe('short')
})
