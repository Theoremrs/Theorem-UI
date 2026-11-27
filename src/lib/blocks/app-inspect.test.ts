// The check's own run, through the production frame connection with the test
// frame standing in for the page (Happy DOM runs no frame scripts).
import { afterEach, expect, spyOn, test } from 'bun:test'
import { connectAppFrame } from '../../../test/blocks/app-frame'
import { inspectApp } from './app-inspect'
import * as hosted from './hosted-app'
import { call, serve } from './sandbox/protocol'
import type { PageMethods, SandboxMethods } from './sandbox/protocol'

const PAGE = '<!doctype html><title>Rents</title><p>Rents</p>'

afterEach(() => {
  for (const frame of document.querySelectorAll('iframe')) frame.remove()
})

/** Checks `PAGE` as a notebook of `cells`, with the test as its frame; `frame` is what the frame does once connected. */
async function check(
  cells: Array<string>,
  runMs: number,
  frame: (rpc: Awaited<ReturnType<typeof connectAppFrame>>['rpc']) => Promise<void>,
) {
  const page = spyOn(hosted, 'hostedAppDocument').mockImplementation(async () => PAGE)
  try {
    const inspection = inspectApp(PAGE, { cells, runMs })
    const connected = await connectAppFrame(document.body)
    serve<SandboxMethods, 'frame.look'>(connected.rpc, 'frame.look', async () => ({
      html: '<p>Rents</p>',
      outline: 'paragraph "Rents"',
    }))
    await frame(connected.rpc)
    const result = await inspection
    connected.close()
    return result
  } finally {
    page.mockRestore()
  }
}

test('a notebook run that ends before a cell settles says it is pending, not shown', async () => {
  const result = await check(['rent', 'share'], 600, async (rpc) => {
    await call<PageMethods, 'frame.status'>(rpc, 'frame.status', {
      cell: 'rent',
      stage: 'ready',
      shows: '1200',
    })
  })
  expect(result.built).toBe(true)
  expect(result.started).toBe(true)
  expect(result.cells).toEqual({ ready: ['rent'], failed: [], pending: ['share'] })
  expect(result.ranMs).toBeGreaterThanOrEqual(600)
})

test('a notebook run ends once every cell has settled, and says how each did', async () => {
  const result = await check(['rent', 'share'], 5000, async (rpc) => {
    await call<PageMethods, 'frame.status'>(rpc, 'frame.status', { cell: 'rent', stage: 'ready' })
    await call<PageMethods, 'frame.status'>(rpc, 'frame.status', {
      cell: 'share',
      stage: 'failed',
      error: 'rent is not defined',
    })
  })
  expect(result.started).toBe(true)
  expect(result.cells).toEqual({ ready: ['rent'], failed: ['share'], pending: [] })
  expect(result.ranMs).toBeLessThan(5000)
  expect(result.rendered?.text).toBe('Rents')
})
