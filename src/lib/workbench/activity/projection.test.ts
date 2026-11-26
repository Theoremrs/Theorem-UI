// SOURCING: none — bun:test over ./projection, the AC-09 and AC-11 event cases
import { describe, expect, test } from 'bun:test'
import { createActivityProjection, createViewBindings, keyOf } from './projection'
import type { ActivityEvent } from './projection'

const ev = (over: Partial<ActivityEvent>): ActivityEvent => ({
  kind: 'change',
  source: 'terminal',
  resource: 'w/s1',
  epoch: 1,
  seq: 1,
  at: 0,
  state: {},
  ...over,
})

describe('activity projection', () => {
  test('a change before any snapshot asks for one and shows nothing', () => {
    const p = createActivityProjection()
    expect(p.apply(ev({ state: { execution: 'running' } }))).toBe('needs_snapshot')
    expect(p.entries()).toEqual([])
  })

  test('duplicates and out-of-order steps are dropped, in-order ones applied', () => {
    const p = createActivityProjection()
    p.apply(ev({ kind: 'snapshot', seq: 1, state: { execution: 'running' } }))
    expect(p.apply(ev({ seq: 2, state: { execution: 'waiting' } }))).toBe('applied')
    expect(p.apply(ev({ seq: 2, state: { execution: 'failed' } }))).toBe('duplicate')
    expect(p.apply(ev({ seq: 1, state: { execution: 'failed' } }))).toBe('duplicate')
    expect(p.get(keyOf('terminal', 'w/s1'))?.execution).toBe('waiting')
  })

  test('equal offsets on different resources and epochs are not duplicates', () => {
    const p = createActivityProjection()
    p.apply(ev({ kind: 'snapshot', resource: 'w/s1', seq: 5 }))
    expect(p.apply(ev({ kind: 'snapshot', resource: 'w/s2', seq: 5 }))).toBe('applied')
    expect(p.apply(ev({ kind: 'snapshot', resource: 'w/s1', epoch: 2, seq: 5 }))).toBe('applied')
    expect(p.entries().map((e) => [e.resource, e.epoch])).toEqual([
      ['w/s1', 2],
      ['w/s2', 1],
    ])
  })

  test('a new epoch is never merged into the old stream, and an old one is late', () => {
    const p = createActivityProjection()
    p.apply(ev({ kind: 'snapshot', seq: 3, state: { execution: 'running', detail: 'old' } }))
    expect(p.apply(ev({ epoch: 2, seq: 4 }))).toBe('needs_snapshot')
    expect(p.get('terminal:w/s1')?.observation).toBe('recovering')
    expect(p.apply(ev({ kind: 'snapshot', epoch: 2, seq: 1, state: { execution: 'running' } }))).toBe('applied')
    expect(p.get('terminal:w/s1')?.detail).toBeUndefined()
    expect(p.apply(ev({ kind: 'snapshot', epoch: 1, seq: 9 }))).toBe('stale_epoch')
  })

  test('a cursor gap holds changes until the owner snapshots', () => {
    const p = createActivityProjection()
    p.apply(ev({ kind: 'snapshot', seq: 1, state: { execution: 'running' } }))
    expect(p.apply(ev({ seq: 3, state: { execution: 'succeeded' } }))).toBe('gap')
    expect(p.apply(ev({ seq: 4, state: { execution: 'failed' } }))).toBe('needs_snapshot')
    const held = p.get('terminal:w/s1')
    expect(held?.execution).toBe('running')
    expect(held?.observation).toBe('recovering')
    p.apply(ev({ kind: 'snapshot', seq: 4, state: { execution: 'succeeded' } }))
    expect(p.get('terminal:w/s1')).toMatchObject({ execution: 'succeeded', observation: 'current' })
  })

  test('a lost stream keeps the last state and marks it stale, not ended', () => {
    const p = createActivityProjection()
    p.apply(ev({ kind: 'snapshot', source: 'thread', resource: 't1', state: { execution: 'running' } }))
    p.apply(ev({ kind: 'snapshot', source: 'terminal', resource: 'w/s1', state: { execution: 'running' } }))
    p.lost('thread')
    expect(p.get('thread:t1')).toMatchObject({ execution: 'running', observation: 'stale' })
    expect(p.get('terminal:w/s1')?.observation).toBe('current')
    p.recovering('thread', 't1')
    expect(p.apply(ev({ source: 'thread', resource: 't1', seq: 2 }))).toBe('needs_snapshot')
  })

  test("after a loss, the owner's snapshot at the same seq settles the entry", () => {
    const p = createActivityProjection()
    p.apply(ev({ kind: 'snapshot', seq: 5, state: { execution: 'running' } }))
    p.lost('terminal')
    p.recovering('terminal')
    expect(p.apply(ev({ kind: 'snapshot', seq: 5, state: { execution: 'running' } }))).toBe('applied')
    expect(p.get('terminal:w/s1')?.observation).toBe('current')
    expect(p.apply(ev({ seq: 6, state: { execution: 'succeeded' } }))).toBe('applied')
    // A current entry still drops the repeat.
    expect(p.apply(ev({ kind: 'snapshot', seq: 6 }))).toBe('duplicate')
  })

  test('a snapshot without a waiting reason clears the old one', () => {
    const p = createActivityProjection()
    p.apply(ev({ kind: 'snapshot', state: { execution: 'waiting', waiting: { for: 'approval', ref: 'r1' } } }))
    p.apply(ev({ kind: 'snapshot', seq: 2, state: { execution: 'running' } }))
    expect(p.get('terminal:w/s1')?.waiting).toBeUndefined()
  })
})

describe('view bindings', () => {
  test('a late result for the previous selection cannot change the view', () => {
    const views = createViewBindings()
    const first = views.bind('v1', 'terminal:w/s1')
    const second = views.bind('v1', 'terminal:w/s2')
    expect(views.current('v1', 'terminal:w/s1', first)).toBe(false)
    expect(views.current('v1', 'terminal:w/s2', second)).toBe(true)
    // Reselecting the first resource is a new binding, not the old one back.
    const third = views.bind('v1', 'terminal:w/s1')
    expect(views.current('v1', 'terminal:w/s1', first)).toBe(false)
    expect(views.current('v1', 'terminal:w/s1', third)).toBe(true)
  })
})
