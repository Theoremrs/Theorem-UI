// SOURCING: none — bun:test over ./sessions, pure logic
import { describe, expect, test } from 'bun:test'
import { createSessionWatch, noticeText } from './sessions'
import type { SessionNotice } from './sessions'

function setup() {
  const told: SessionNotice[] = []
  const watch = createSessionWatch((notice) => told.push(notice))
  return { told, watch }
}

describe('the session watch', () => {
  test('a session the agent started tells its run when it stops working', () => {
    const { told, watch } = setup()
    watch.acted('t1', 'run1', 'Claude Code (Herdr)')
    watch.observe('t1', 'working')
    expect(told).toEqual([])
    watch.observe('t1', 'finished')
    expect(told).toEqual([
      {
        runId: 'run1',
        session: 't1',
        what: 'Claude Code (Herdr)',
        state: 'finished',
      },
    ])
  })

  test('idle before any work, or the same state again, tells nothing', () => {
    const { told, watch } = setup()
    watch.acted('t1', 'run1', 'Codex (Herdr)')
    watch.observe('t1', 'finished')
    watch.observe('t1', 'working')
    watch.observe('t1', 'working')
    watch.observe('t1', 'waiting')
    watch.observe('t1', 'waiting')
    expect(told.map((n) => n.state)).toEqual(['waiting'])
  })

  test('the program ending is news even when it never said it was working', () => {
    const { told, watch } = setup()
    watch.acted('t1', 'run1', 'Claude Code (Herdr)')
    watch.observe('t1', 'ended', 'exit code 1')
    expect(told).toMatchObject([{ state: 'ended', detail: 'exit code 1' }])
  })

  test('a session nobody asked the agent about is not watched', () => {
    const { told, watch } = setup()
    watch.observe('t9', 'working')
    watch.observe('t9', 'finished')
    expect(told).toEqual([])
  })

  test('the latest run that acted on a session is the one told', () => {
    const { told, watch } = setup()
    watch.acted('s1', 'run1', 'the side chat')
    watch.observe('s1', 'working')
    watch.observe('s1', 'finished')
    watch.acted('s1', 'run2', 'the side chat')
    watch.observe('s1', 'working')
    watch.observe('s1', 'failed', 'model error')
    expect(told.map((n) => [n.runId, n.state])).toEqual([
      ['run1', 'finished'],
      ['run2', 'failed'],
    ])
  })

  test('a forgotten session tells nothing more', () => {
    const { told, watch } = setup()
    watch.acted('s1', 'run1', 'the side chat')
    watch.observe('s1', 'working')
    watch.forget('s1')
    watch.observe('s1', 'finished')
    expect(told).toEqual([])
  })
})

describe('noticeText', () => {
  test('names each session, what became of it, and where to look', () => {
    const text = noticeText([
      {
        runId: 'run1',
        session: 'hc-1',
        what: 'Claude Code (Herdr)',
        state: 'finished',
      },
      {
        runId: 'run1',
        session: 'side-2',
        what: 'the side chat',
        state: 'failed',
        detail: 'model error',
      },
    ])
    expect(text).toContain('Claude Code (Herdr) (hc-1) finished its work')
    expect(text).toContain('the side chat (side-2) failed: model error')
    expect(text).toContain('workbench.read')
  })
})
