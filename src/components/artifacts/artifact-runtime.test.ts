import { afterEach, expect, test } from 'bun:test'
import {
  DETACHED_KEPT,
  expandedViewId,
  isInteractive,
  runtimeOfView,
  useArtifactRuntimes,
} from './artifact-runtime'
import type { AttachRequest } from './artifact-runtime'

afterEach(() => useArtifactRuntimes.getState().reset())

const request = (
  viewId: string,
  surface: AttachRequest['surface'],
  extra: Partial<AttachRequest> = {},
): AttachRequest => ({
  viewId,
  surface,
  artifactId: 'app',
  documentId: 'doc',
  renderer: 'theorem-app',
  title: 'Planner',
  ...extra,
})

const store = () => useArtifactRuntimes.getState()

test('views of one artifact attach to one runtime; the first holds it and a second is passive (AR-08, AR-09)', () => {
  const id = store().attach(request('inline:1', 'inline'))
  expect(store().attach(request('docked:a', 'docked'))).toBe(id)
  const record = store().runtimes[id]!
  expect(Object.keys(store().runtimes)).toHaveLength(1)
  expect(record.attachments.map((one) => one.viewId)).toEqual([
    'inline:1',
    'docked:a',
  ])
  expect(isInteractive(record, 'inline:1')).toBe(true)
  expect(isInteractive(record, 'docked:a')).toBe(false)
})

test('moving the attachment changes who holds the runtime, and closing the holder returns it to the view before', () => {
  const id = store().attach(request('inline:1', 'inline'))
  store().attach(request('docked:a', 'docked'))
  store().moveHere('docked:a')
  expect(store().runtimes[id]!.holder).toBe('docked:a')
  store().detach('docked:a')
  const record = store().runtimes[id]!
  expect(record.holder).toBe('inline:1')
  expect(record.detachedAt).toBeUndefined()
})

test('expanding moves the attachment to the expanded view; restoring returns it to the view that opened it', () => {
  const id = store().attach(request('inline:1', 'inline'))
  store().attach(request('docked:a', 'docked'))
  store().moveHere('docked:a')
  store().expand('inline:1')
  expect(store().expanded).toBe(id)
  expect(store().runtimes[id]!.holder).toBe(expandedViewId(id))
  store().restore()
  expect(store().expanded).toBeUndefined()
  expect(store().runtimes[id]!.holder).toBe('inline:1')
  expect(
    store().runtimes[id]!.attachments.some(
      (one) => one.viewId === expandedViewId(id),
    ),
  ).toBe(false)
})

test('closing every view keeps the runtime running; it is released only beyond the retention limit (AR-12)', () => {
  const ids: Array<string> = []
  for (let n = 0; n <= DETACHED_KEPT; n++) {
    ids.push(
      store().attach(
        request(`inline:${n}`, 'inline', {
          artifactId: `app-${n}`,
          documentId: `doc-${n}`,
        }),
      ),
    )
    store().detach(`inline:${n}`)
  }
  // Every view closed: the newest DETACHED_KEPT keep running, the oldest is released.
  expect(Object.keys(store().runtimes)).toEqual(ids.slice(1))
  expect(store().released['app-0']).toBeDefined()
  // Reopening the released one starts it again and says so.
  const again = store().attach(
    request('inline:0', 'inline', { artifactId: 'app-0', documentId: 'doc-0' }),
  )
  expect(store().runtimes[again]!.restartedAfterRelease).toBe(true)
  // Reopening a kept one is the same runtime.
  expect(
    store().attach(
      request('docked:b', 'docked', {
        artifactId: 'app-3',
        documentId: 'doc-3',
      }),
    ),
  ).toBe(ids[3]!)
})

test('a separate copy is its own runtime with lineage, and the original can be shown again (AR-09)', () => {
  const id = store().attach(request('inline:1', 'inline'))
  store().report(id, { committed: '4', running: '4' })
  store().attach(request('docked:a', 'docked'))
  const copy = store().startCopy('docked:a')!
  expect(copy).not.toBe(id)
  const record = store().runtimes[copy]!
  expect(record.primary).toBe(false)
  expect(record.lineage).toEqual({ from: id, revision: '4' })
  expect(isInteractive(record, 'docked:a')).toBe(true)
  // The original is untouched and still held by its answer.
  expect(store().runtimes[id]!.holder).toBe('inline:1')
  expect(runtimeOfView('docked:a')?.id).toBe(copy)
  // The panel can show the original again; the copy, with no view, keeps running.
  store().showHere('docked:a', id)
  expect(store().runtimes[id]!.holder).toBe('docked:a')
  expect(store().runtimes[copy]!.attachments).toHaveLength(0)
})

test('a renderer that declares shared interactive views makes every attached view interactive', () => {
  const id = store().attach(request('inline:1', 'inline', { shared: true }))
  store().attach(request('docked:a', 'docked', { shared: true }))
  const record = store().runtimes[id]!
  expect(isInteractive(record, 'inline:1')).toBe(true)
  expect(isInteractive(record, 'docked:a')).toBe(true)
})

test('a newest revision naming another document starts that App, not the old one', () => {
  const first = store().attach(request('inline:1', 'inline'))
  const second = store().attach(
    request('inline:1', 'inline', { documentId: 'other' }),
  )
  expect(second).not.toBe(first)
  // Nothing showed the old App any more, so it went.
  expect(store().runtimes[first]).toBeUndefined()
})

test('a restart is recorded with the revision it replaced', () => {
  const id = store().attach(request('inline:1', 'inline'))
  store().report(id, { committed: '1', running: '1' })
  store().report(id, { committed: '2', running: '2' })
  expect(store().runtimes[id]!.revisions.restartedFrom).toBe('1')
  store().report(id, { committed: '2', running: '2', editing: true })
  expect(store().runtimes[id]!.revisions.restartedFrom).toBe('1')
})
