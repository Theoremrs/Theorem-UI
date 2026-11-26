// SOURCING: none — bun:test over ./arrangement with activity entries built by hand
import { beforeEach, describe, expect, test } from 'bun:test'
import {
  arrange,
  effectivePlacement,
  effectiveSize,
  moveIn,
  removeFrom,
  RIGHT_MIN_WIDTH,
  SIZE,
  useActivityView,
} from './arrangement'
import type { ActivityEntry } from './projection'
import { keyOf } from './projection'

const entry = (
  resource: string,
  over: Partial<ActivityEntry> = {},
): ActivityEntry => ({
  key: keyOf(over.source ?? 'thread', resource),
  source: 'thread',
  resource,
  label: resource,
  execution: 'running',
  observation: 'current',
  observedAt: 1,
  epoch: 0,
  seq: 0,
  projects: ['p'],
  projectId: 'p',
  ...over,
})

const empty = {
  projectId: 'p',
  scope: 'project' as const,
  order: [],
  removed: {},
}
const at = { projectId: 'p', scope: 'project' as const }

describe('arrangement', () => {
  test('rows keep their places; new work joins at the end whatever its state', () => {
    const first = arrange(empty, [entry('a'), entry('b')], at)
    expect(first.order).toEqual(['thread:a', 'thread:b'])
    // b fails and c arrives first in the listing: neither moves a, and c joins last.
    const next = arrange(
      first,
      [
        entry('c'),
        entry('b', { execution: 'failed' }),
        entry('a', { execution: 'waiting' }),
      ],
      at,
    )
    expect(next.order).toEqual(['thread:a', 'thread:b', 'thread:c'])
    expect(next.items['thread:b']?.entry.execution).toBe('failed')
  })

  test('work the owner stops listing stays, marked, until removed', () => {
    const first = arrange(empty, [entry('a'), entry('b')], at)
    const next = arrange(first, [entry('b')], at)
    expect(next.order).toEqual(['thread:a', 'thread:b'])
    expect(next.items['thread:a']?.listed).toBe(false)
    expect(next.items['thread:b']?.listed).toBe(true)
  })

  test('a removed row stays out for the same run and comes back for a new one', () => {
    const first = arrange(empty, [entry('a', { runId: 'r1' })], at)
    const removed = removeFrom(first, 'thread:a')
    expect(removed.order).toEqual([])
    expect(arrange(removed, [entry('a', { runId: 'r1' })], at).order).toEqual(
      [],
    )
    const again = arrange(removed, [entry('a', { runId: 'r2' })], at)
    expect(again.order).toEqual(['thread:a'])
    expect(again.removed['thread:a']).toBeUndefined()
  })

  test('the project scope leaves out other projects; All work includes them', () => {
    const other = entry('x', { projects: ['q'], projectId: 'q' })
    const page = entry('t', {
      source: 'terminal',
      projects: undefined,
      projectId: undefined,
    })
    expect(arrange(empty, [entry('a'), other, page], at).order).toEqual([
      'thread:a',
      'terminal:t',
    ])
    expect(
      arrange({ ...empty, scope: 'all' }, [entry('a'), other, page], {
        ...at,
        scope: 'all',
      }).order,
    ).toEqual(['thread:a', 'thread:x', 'terminal:t'])
  })

  test('changing scope starts again from the listing', () => {
    const first = arrange(empty, [entry('a'), entry('b')], at)
    const kept = arrange(first, [entry('b')], at)
    const all = arrange(kept, [entry('b')], { ...at, scope: 'all' })
    expect(all.order).toEqual(['thread:b'])
  })

  test('moving a row changes only its place', () => {
    const first = arrange(empty, [entry('a'), entry('b'), entry('c')], at)
    expect(moveIn(first, 'thread:c', -1).order).toEqual([
      'thread:a',
      'thread:c',
      'thread:b',
    ])
    expect(moveIn(first, 'thread:a', -1)).toBe(first)
    // A moved order survives the next listing.
    const moved = moveIn(first, 'thread:c', -2)
    expect(
      arrange(moved, [entry('a'), entry('b'), entry('c')], at).order,
    ).toEqual(['thread:c', 'thread:a', 'thread:b'])
  })

  test('a narrow container shows a right drawer at the bottom without changing the choice', () => {
    expect(effectivePlacement('right', RIGHT_MIN_WIDTH - 1)).toBe('bottom')
    expect(effectivePlacement('right', RIGHT_MIN_WIDTH)).toBe('right')
    expect(effectivePlacement('bottom', 300)).toBe('bottom')
    expect(effectiveSize('bottom', 500, 300)).toBe(300)
    expect(effectiveSize('bottom', 200, 300)).toBe(200)
    expect(effectiveSize('bottom', 100, 300)).toBe(SIZE.bottom.min)
  })
})

describe('activity view state', () => {
  beforeEach(() => {
    useActivityView.setState({
      open: false,
      expanded: false,
      placement: 'bottom',
      scope: 'project',
      selected: null,
      arranged: undefined,
      saved: {},
      origin: null,
    })
  })

  test('owner events never change the selection', () => {
    const view = useActivityView.getState()
    view.sync([entry('a'), entry('b')], 'p')
    view.select('thread:b')
    view.sync([entry('c'), entry('b', { execution: 'failed' })], 'p')
    view.sync([], 'p')
    expect(useActivityView.getState().selected).toBe('thread:b')
    expect(useActivityView.getState().arranged?.order).toEqual([
      'thread:a',
      'thread:b',
      'thread:c',
    ])
  })

  test('a manual order and a removal are saved per project and scope', () => {
    const view = useActivityView.getState()
    view.sync([entry('a'), entry('b'), entry('c')], 'p')
    view.move('thread:c', -2)
    view.remove('thread:b')
    // Another project, then back: the saved order and removal apply again.
    view.sync([entry('z', { projects: ['q'], projectId: 'q' })], 'q')
    useActivityView.getState().sync([entry('a'), entry('b'), entry('c')], 'p')
    expect(useActivityView.getState().arranged?.order).toEqual([
      'thread:c',
      'thread:a',
    ])
  })

  test('expanding and restoring keep the saved placement and size', () => {
    const view = useActivityView.getState()
    view.setPlacement('right')
    view.setSize('right', 500)
    view.openView({ origin: null })
    view.setExpanded(true)
    view.setExpanded(false)
    const state = useActivityView.getState()
    expect(state.placement).toBe('right')
    expect(state.size.right).toBe(500)
    expect(state.open).toBe(true)
  })

  test('closing returns focus to the control that opened it', () => {
    const button = document.createElement('button')
    document.body.append(button)
    const other = document.createElement('input')
    document.body.append(other)
    useActivityView.getState().openView({ origin: button })
    other.focus()
    useActivityView.getState().close()
    expect(document.activeElement).toBe(button)
    expect(useActivityView.getState().open).toBe(false)
    button.remove()
    other.remove()
  })
})

describe('removing work with no run id', () => {
  const term = (execution: ActivityEntry['execution']) =>
    entry('w/1', {
      source: 'terminal',
      projects: undefined,
      projectId: undefined,
      execution,
    })

  test('stays out while its state holds, and comes back when the state changes', () => {
    const first = arrange(empty, [term('unknown')], at)
    const removed = removeFrom(first, 'terminal:w/1')
    expect(arrange(removed, [term('unknown')], at).order).toEqual([])
    expect(arrange(removed, [term('running')], at).order).toEqual([
      'terminal:w/1',
    ])
  })

  test('comes back after it leaves the listing and returns', () => {
    const removed = removeFrom(
      arrange(empty, [term('running')], at),
      'terminal:w/1',
    )
    const left = arrange(removed, [], at)
    expect(arrange(left, [term('running')], at).order).toEqual(['terminal:w/1'])
  })
})

describe('owners not read this time', () => {
  const term = entry('w/1', {
    source: 'terminal',
    projects: undefined,
    projectId: undefined,
    execution: 'running',
  })

  test('an unread owner neither ends a removal nor marks its rows as left', () => {
    const shown = arrange(empty, [term], at)
    const removed = removeFrom(shown, 'terminal:w/1')
    // The terminal listing was not read: its removal holds when it is read again unchanged.
    const unread = arrange(removed, [], {
      ...at,
      read: new Set(['thread'] as const),
    })
    expect(unread.removed['terminal:w/1']).toBe('~running')
    expect(arrange(unread, [term], at).order).toEqual([])
    // A row whose owner was not read keeps its last word rather than reading as gone.
    const kept = arrange(shown, [], {
      ...at,
      read: new Set(['thread'] as const),
    })
    expect(kept.items['terminal:w/1']?.listed).toBe(true)
  })

  test('a removal that changes on sync is saved, so another project and back keeps it', () => {
    useActivityView.setState({
      arranged: undefined,
      saved: {},
      scope: 'project',
    })
    const view = useActivityView.getState()
    view.sync([term], 'p')
    view.remove('terminal:w/1')
    // It leaves the listing (marker becomes left), then the person visits another project.
    useActivityView.getState().sync([], 'p')
    useActivityView.getState().sync([], 'q')
    useActivityView.getState().sync([term], 'p')
    expect(useActivityView.getState().arranged?.order).toEqual(['terminal:w/1'])
  })
})
