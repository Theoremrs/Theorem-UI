// SOURCING: bun:test over the layout envelope and its store: a round trip,
// identities kept outside the vendor blob, newer and unreadable envelopes kept
// aside, per-device slots, and a revision-checked reset.
import { beforeEach, expect, test } from 'bun:test'
import {
  LAYOUT_SCHEMA,
  decodeLayout,
  encodeLayout,
  identitiesOf,
} from './layout-envelope'
import {
  loadLayout,
  resetLayoutStoreForTest,
  resetLayouts,
  saveLayout,
  useLayoutStore,
} from './layout-store'

const vendor = () => ({
  grid: {
    root: { type: 'leaf', data: { id: '1', views: ['thread', 'artifact:a1'] } },
  },
  panels: {
    thread: { id: 'thread', contentComponent: 'thread', title: 'Chat' },
    'artifact:a1': {
      id: 'artifact:a1',
      contentComponent: 'artifact',
      title: 'Artifact',
      params: { artifactId: 'a1', runId: 'run-9' },
    },
  },
  activeGroup: '1',
})

beforeEach(() => resetLayoutStoreForTest())

test('the envelope names its schema and host, and keeps identities out of the vendor blob', () => {
  const envelope = encodeLayout(vendor(), { device: 'desktop', threadId: 't1' })
  expect(envelope.schema).toBe(LAYOUT_SCHEMA)
  expect(envelope.hostVersion).toBeTruthy()
  expect(envelope.identities['artifact:a1']?.params).toEqual({
    artifactId: 'a1',
    runId: 'run-9',
  })
  expect(JSON.stringify(envelope.layout)).not.toContain('run-9')
  expect(identitiesOf(envelope).map((one) => one.panelId)).toEqual([
    'thread',
    'artifact:a1',
  ])
})

test('a layout survives a JSON round trip with its parameters restored', () => {
  const stored = JSON.parse(
    JSON.stringify(encodeLayout(vendor(), { device: 'desktop' })),
  )
  const decoded = decodeLayout(stored)
  expect(decoded.status).toBe('ok')
  if (decoded.status !== 'ok') return
  expect(decoded.vendor).toEqual(vendor())
})

test('a field a newer minor host added is kept through a round trip', () => {
  const raw = {
    ...encodeLayout(vendor(), { device: 'desktop' }),
    future: { a: 1 },
  }
  const decoded = decodeLayout(raw)
  expect(decoded.status).toBe('ok')
  if (decoded.status === 'ok')
    expect((decoded.envelope as Record<string, unknown>).future).toEqual({
      a: 1,
    })
})

test('a newer or unreadable envelope is reported, not repaired', () => {
  expect(decodeLayout({ schema: 'theorem.layout/2', layout: 'x' }).status).toBe(
    'newer',
  )
  expect(decodeLayout({ nonsense: true }).status).toBe('unreadable')
  expect(decodeLayout('text').status).toBe('unreadable')
})

test('saving over a newer envelope keeps it aside instead of overwriting it', () => {
  const newer = { schema: 'theorem.layout/2', layout: { opaque: true } }
  useLayoutStore.setState({ slots: { p1: { desktop: newer } } })
  expect(loadLayout('p1', 'desktop')).toEqual({
    status: 'foreign',
    reason: 'newer',
  })
  saveLayout('p1', 'desktop', { vendor: vendor() })
  const { preserved, slots } = useLayoutStore.getState()
  expect(preserved).toHaveLength(1)
  expect(preserved[0]!.raw).toEqual(newer)
  expect(preserved[0]!.reason).toBe('newer')
  expect(decodeLayout(slots.p1!.desktop).status).toBe('ok')
})

test('the narrow slot never rewrites the desktop arrangement', () => {
  saveLayout('p1', 'desktop', { vendor: vendor(), threadId: 't1' })
  const desktop = useLayoutStore.getState().slots.p1!.desktop
  saveLayout('p1', 'narrow', {
    vendor: { ...vendor(), panels: { thread: vendor().panels.thread } },
  })
  expect(useLayoutStore.getState().slots.p1!.desktop).toBe(desktop)
  const loaded = loadLayout('p1', 'desktop')
  expect(loaded.status).toBe('ok')
  if (loaded.status === 'ok') expect(loaded.threadId).toBe('t1')
})

test('before any envelope the desktop reads the layout saved the old way', () => {
  const legacy = { threadId: 't0', dock: vendor() }
  expect(loadLayout('p1', 'desktop', legacy).status).toBe('ok')
  expect(loadLayout('p1', 'narrow', legacy)).toEqual({ status: 'none' })
})

test('a reset keeps every layout aside and refuses a stale revision', () => {
  saveLayout('p1', 'desktop', { vendor: vendor() })
  const seen = useLayoutStore.getState().revision
  saveLayout('p2', 'desktop', { vendor: vendor() })
  expect(resetLayouts(seen)).toEqual({ ok: false })
  expect(Object.keys(useLayoutStore.getState().slots)).toEqual(['p1', 'p2'])
  const result = resetLayouts(useLayoutStore.getState().revision, {
    p3: { dock: 1 },
  })
  expect(result).toEqual({ ok: true, preserved: 3 })
  expect(useLayoutStore.getState().slots).toEqual({})
  expect(useLayoutStore.getState().preserved).toHaveLength(3)
})
