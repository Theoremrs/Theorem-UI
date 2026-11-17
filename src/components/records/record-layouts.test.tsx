// SOURCING: none — tests of record table arrangements kept per person: the layouts store, its sanitizers, and its sync with Theorem's preferences route served in-process
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  spyOn,
  test,
} from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, useEffect } from 'react'
import { cleanup, render, waitFor } from '../../../test/blocks/render'
import { useGenerationDefaults } from '../../lib/theorem/generation'
import { PreferencesSync, usePickedModels } from '../../lib/theorem/models'
import {
  mergeLayouts,
  readLayouts,
  trimLayouts,
  useRecordLayouts,
  useRecordViewState,
} from './view-state'
import type { RecordViewState } from './view-state'

type Put = { ifMatch: string | null; body: Record<string, unknown> }

let stored: Record<string, unknown>
let reads: number
let puts: Put[]
let fetchSpy: ReturnType<typeof spyOn>
const page = (
  window as unknown as { happyDOM: { setURL: (url: string) => void } }
).happyDOM

const initial = (): RecordViewState => ({
  columnOrder: ['name', 'email'],
  columnSizing: {},
  columnVisibility: {},
  aggregates: {},
})

beforeAll(() => {
  page.setURL('http://localhost:3000/')
  fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async (
    input,
    init,
  ) => {
    const request = new Request(input, init)
    const path = new URL(request.url).pathname
    if (path.endsWith('/bootstrap'))
      return Response.json({ csrfToken: 'csrf', tenantId: 't' })
    if (!path.endsWith('/preferences'))
      return Response.json({}, { status: 404 })
    if (request.method === 'GET') {
      reads += 1
      return Response.json(stored)
    }
    const body = (await request.json()) as Record<string, unknown>
    puts.push({ ifMatch: request.headers.get('If-Match'), body })
    // The real route replaces the whole object.
    stored = { ...body, revision: Number(stored.revision) + 1 }
    return Response.json(stored)
  }) as typeof fetch)
})
afterAll(() => {
  fetchSpy.mockRestore()
  page.setURL('about:blank')
})
const clear = () => {
  window.localStorage.clear()
  useRecordLayouts.setState({ layouts: {} })
  useGenerationDefaults.setState({
    defaults: {},
    onServer: undefined,
    saved: undefined,
  })
  usePickedModels.setState({ selected: undefined, starred: [] })
}
beforeEach(() => {
  stored = { starredModels: [], defaultModel: null, revision: 3 }
  reads = 0
  puts = []
  clear()
})
afterEach(async () => {
  await cleanup()
  clear()
})

async function mount() {
  await render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <PreferencesSync />
    </QueryClientProvider>,
  )
  await waitFor(() => reads > 0)
  await act(() => new Promise((resolve) => setTimeout(resolve, 20)))
}

let seen: RecordViewState | undefined
let change: ReturnType<typeof useRecordViewState>[1] | undefined
let forget: (() => void) | undefined
function Probe({ id }: { id: string }) {
  const [state, setState, reset] = useRecordViewState(id, initial)
  useEffect(() => {
    seen = state
    change = setState
    forget = reset
  })
  return null
}

test('a layout change is saved as recordLayouts with the revision it was read at', async () => {
  await mount()
  await render(<Probe id="a" />)
  await act(async () =>
    change!((now) => ({ ...now, columnOrder: ['email', 'name'] })),
  )
  await waitFor(() => puts.length === 1)
  expect(puts[0]!.ifMatch).toBe('3')
  const sent = puts[0]!.body.recordLayouts as Record<
    string,
    { columnOrder: string[]; at: number }
  >
  expect(sent.a!.columnOrder).toEqual(['email', 'name'])
  expect(typeof sent.a!.at).toBe('number')
})

test("Theorem's layouts reach the table for that key without a write back", async () => {
  stored = {
    ...stored,
    recordLayouts: {
      a: { columnOrder: ['email', 'name'], columnSizing: { name: 200 }, at: 5 },
    },
  }
  await render(<Probe id="a" />)
  expect(seen!.columnOrder).toEqual(['name', 'email'])
  await mount()
  expect(seen!.columnOrder).toEqual(['email', 'name'])
  expect(seen!.columnSizing).toEqual({ name: 200 })
  await act(() => new Promise((resolve) => setTimeout(resolve, 600)))
  expect(puts).toEqual([])
})

test('a write keeps keys this browser does not own', async () => {
  stored = { ...stored, decisionModel: 'openrouter/x/y', other: { n: 1 } }
  await mount()
  await act(async () =>
    usePickedModels.setState({ starred: ['openrouter/a/b'] }),
  )
  await waitFor(() => puts.length === 1)
  expect(puts[0]!.body).toMatchObject({
    decisionModel: 'openrouter/x/y',
    other: { n: 1 },
    starredModels: ['openrouter/a/b'],
  })
  expect(puts[0]!.body).not.toHaveProperty('revision')
  // The kept keys survive a second write too, built from the returned copy.
  await act(async () => usePickedModels.setState({ starred: [] }))
  await waitFor(() => puts.length === 2)
  expect(puts[1]!.ifMatch).toBe('4')
  expect(puts[1]!.body).toMatchObject({ decisionModel: 'openrouter/x/y' })
})

test('an arrangement kept under the earlier localStorage key is picked up and reset forgets it', async () => {
  window.localStorage.setItem(
    'theorem.crm.view:b',
    JSON.stringify({
      columnOrder: ['email', 'name'],
      columnVisibility: { name: false },
    }),
  )
  await render(<Probe id="b" />)
  expect(seen!.columnOrder).toEqual(['email', 'name'])
  expect(seen!.columnVisibility).toEqual({ name: false })
  expect(useRecordLayouts.getState().layouts).toEqual({})
  await act(async () => forget!())
  expect(seen).toEqual(initial())
  expect(window.localStorage.getItem('theorem.crm.view:b')).toBeNull()
})

test('changing a view moved from the old key removes the old entry, so a reset elsewhere stays reset', async () => {
  window.localStorage.setItem(
    'theorem.crm.view:old',
    JSON.stringify({ columnOrder: ['email', 'name'] }),
  )
  await render(<Probe id="old" />)
  expect(seen!.columnOrder).toEqual(['email', 'name'])
  await act(async () =>
    change!({ ...initial(), aggregates: { name: 'count' } }),
  )
  expect(window.localStorage.getItem('theorem.crm.view:old')).toBeNull()
  // Theorem serves a map with the view reset.
  await act(async () =>
    useRecordLayouts.setState({ layouts: mergeLayouts({}, {}) }),
  )
  expect(seen).toEqual(initial())
})

test('a saved layout beside a leftover old entry is not undone by a later reset', async () => {
  window.localStorage.setItem(
    'theorem.crm.view:left',
    JSON.stringify({ columnOrder: ['email', 'name'] }),
  )
  useRecordLayouts.setState({
    layouts: { left: { aggregates: { name: 'count' }, at: 5 } },
  })
  await render(<Probe id="left" />)
  expect(window.localStorage.getItem('theorem.crm.view:left')).toBeNull()
  await act(async () => useRecordLayouts.setState({ layouts: {} }))
  expect(seen).toEqual(initial())
})

test('a change is stored, persisted, and reset forgets it', async () => {
  await render(<Probe id="c" />)
  expect(
    window.localStorage.getItem('theorem-ui:record-layouts') ?? '',
  ).not.toContain('"c"')
  await act(async () =>
    change!({ ...initial(), aggregates: { name: 'count' } }),
  )
  expect(useRecordLayouts.getState().layouts.c!.aggregates).toEqual({
    name: 'count',
  })
  expect(window.localStorage.getItem('theorem-ui:record-layouts')).toContain(
    '"c"',
  )
  await act(async () => forget!())
  expect(useRecordLayouts.getState().layouts).toEqual({})
  expect(seen).toEqual(initial())
})

test('malformed layouts from Theorem are sanitized away', () => {
  expect(readLayouts('nope')).toEqual({})
  expect(readLayouts([1])).toEqual({})
  expect(
    readLayouts({
      noTime: { columnOrder: ['a'] },
      badTime: { columnOrder: ['a'], at: 'x' },
      empty: { at: 1 },
      junk: 7,
      ok: {
        at: 9,
        columnOrder: ['a', 'b'],
        columnSizing: { a: 100, b: 'wide' },
        columnVisibility: { a: false, b: 'no' },
        aggregates: { a: 'sum', b: 'nonsense' },
        extra: 1,
      },
    }),
  ).toEqual({
    ok: {
      at: 9,
      columnOrder: ['a', 'b'],
      columnSizing: { a: 100 },
      columnVisibility: { a: false },
      aggregates: { a: 'sum' },
    },
  })
  const local = { x: { at: 1, columnOrder: ['x'] } }
  expect(mergeLayouts(local, undefined)).toBe(local)
  expect(mergeLayouts(local, 'bad')).toBe(local)
  expect(mergeLayouts(local, { y: { at: 2, columnOrder: ['y'] } })).toEqual({
    y: { at: 2, columnOrder: ['y'] },
  })
})

test('Theorem serving malformed layouts leaves the table on its own fields', async () => {
  stored = {
    ...stored,
    recordLayouts: { a: { columnOrder: 'oops', at: 1 }, b: 4 },
  }
  await render(<Probe id="a" />)
  await mount()
  expect(seen).toEqual(initial())
  expect(useRecordLayouts.getState().layouts).toEqual({})
})

test('only the 50 most recently changed layouts are sent', async () => {
  const layouts = Object.fromEntries(
    Array.from({ length: 60 }, (_, i) => [
      `v${i}`,
      { columnOrder: ['a'], at: i + 1 },
    ]),
  )
  expect(Object.keys(trimLayouts(layouts))).toHaveLength(50)
  expect(trimLayouts(layouts).v59).toBeDefined()
  expect(trimLayouts(layouts).v9).toBeUndefined()
  expect(trimLayouts(layouts).v10).toBeDefined()
  await mount()
  await act(async () => useRecordLayouts.setState({ layouts }))
  await waitFor(() => puts.length === 1)
  expect(Object.keys(puts[0]!.body.recordLayouts as object)).toHaveLength(50)
  // This browser keeps all of them.
  expect(Object.keys(useRecordLayouts.getState().layouts)).toHaveLength(60)
})

test('wide layouts give way, oldest first, before the preferences object outgrows Theorem', () => {
  const wide = (i: number) => ({
    columnOrder: Array.from({ length: 200 }, (_, n) => `field_${n}`),
    at: i + 1,
  })
  const layouts = Object.fromEntries(
    Array.from({ length: 20 }, (_, i) => [`v${i}`, wide(i)]),
  )
  const kept = trimLayouts(layouts)
  expect(JSON.stringify(kept).length).toBeLessThanOrEqual(32_000)
  expect(Object.keys(kept).length).toBeGreaterThan(0)
  expect(Object.keys(kept).length).toBeLessThan(20)
  expect(kept.v19).toBeDefined()
  expect(kept.v0).toBeUndefined()
})
