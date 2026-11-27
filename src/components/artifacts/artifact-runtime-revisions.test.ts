import { expect, test } from 'bun:test'
import {
  isDraftLifecycle,
  persistenceReceipts,
  revisionStatus,
} from './artifact-runtime-revisions'

const name = (position: string) => `v${position}`

test('a draft still being written never takes the running revision’s name (AR-10, AC-16)', () => {
  const status = revisionStatus(
    { committed: '3', running: '3' },
    { position: '4' },
    name,
  )
  expect(status.text).toBe('Writing v4 · still running v3')
  expect(status.restartNeeded).toBe(false)
  // A draft that names no revision yet is still not the running one.
  expect(revisionStatus({ committed: '3', running: '3' }, {}, name).text).toBe(
    'Writing a new version · still running v3',
  )
})

test('draft, committed and running stay distinct while a saved revision builds, fails or waits for a restart', () => {
  expect(
    revisionStatus(
      { committed: '4', running: '3', building: true },
      undefined,
      name,
    ).text,
  ).toBe('Building saved v4 · still running v3')
  const failed = revisionStatus(
    { committed: '4', running: '3', failed: true },
    undefined,
    name,
  )
  expect(failed.text).toBe("Couldn't build v4 · still running v3")
  expect(failed.tone).toBe('negative')
  const held = revisionStatus({ committed: '4', running: '3' }, undefined, name)
  expect(held.restartNeeded).toBe(true)
  expect(held.text).toBe('Saved v4 · restart to run it · still running v3')
})

test('a save of declared state alone asks for no restart, because the running source is still the saved one', () => {
  const status = revisionStatus(
    { committed: '5', running: '4', runsCommittedSource: true },
    undefined,
    name,
  )
  expect(status.restartNeeded).toBe(false)
  expect(status.text).toBe('Running v4')
})

test('once the draft is committed and running, the line names that revision, and a restart says what it replaced', () => {
  expect(
    revisionStatus({ committed: '4', running: '4' }, { position: '4' }, name)
      .text,
  ).toBe('Running v4')
  expect(
    revisionStatus(
      { committed: '4', running: '4', restartedFrom: '3' },
      undefined,
      name,
    ).text,
  ).toBe('Running v4 · restarted from v3 to apply it')
  expect(
    revisionStatus(
      { committed: '4', running: '4', editing: true },
      undefined,
      name,
    ).text,
  ).toBe('Source edit not saved · still running v4')
  expect(
    revisionStatus({ committed: '4', stopped: true }, undefined).text,
  ).toBe('Stopped')
})

test('an unnamed running revision is "an earlier version", never the new one', () => {
  const status = revisionStatus(
    { committed: '9', running: '8', building: true },
    undefined,
    (position) => (position === '9' ? 'v2' : undefined),
  )
  expect(status.text).toBe(
    'Building saved v2 · still running an earlier version',
  )
})

test('part lifecycles other than committed ones are drafts', () => {
  expect(isDraftLifecycle('ready')).toBe(false)
  expect(isDraftLifecycle('complete')).toBe(false)
  expect(isDraftLifecycle('streaming')).toBe(true)
  expect(isDraftLifecycle('pending')).toBe(true)
})

test('content, running state and view preferences have separate receipts (AR-11)', () => {
  const docked = persistenceReceipts(
    { committed: '4', running: '4', content: { pending: false } },
    'docked',
    name,
  )
  expect(docked.map((one) => [one.label, one.state])).toEqual([
    ['Content', 'saved'],
    ['Running state', 'none'],
    ['This view', 'device'],
  ])
  // Saving the panel's layout is never reported as saving the App's own state.
  expect(docked[2]!.text).toContain('does not save the App’s running state')
  expect(docked[1]!.text).toContain('Not checkpointed')
  const failing = persistenceReceipts(
    { committed: '4', content: { pending: false, error: 'Store unavailable' } },
    'inline',
  )
  expect(failing[0]).toMatchObject({
    state: 'failed',
    text: 'Not saved: Store unavailable',
  })
  expect(
    persistenceReceipts(
      { committed: '4', content: { pending: true } },
      'expanded',
    )[0]!.state,
  ).toBe('saving')
})
