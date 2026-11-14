// Which state mark a session row draws, by the precedence the owner approved on 2026-11-14.
import { expect, test } from 'bun:test'
import type { ThreadEntry } from '@/lib/theorem/organization'
import { sessionState } from './glyphs'

const thread = (over: Partial<ThreadEntry> = {}): ThreadEntry => ({
  threadId: 'thr_a',
  title: 'A',
  homeProjectId: 'proj_a',
  revision: 1,
  createdAtMs: 1,
  lastMessageAtMs: 2,
  memberships: [],
  attention: { reasons: [], running: false },
  ...over,
})
const none = { forkedFrom: new Set<string>() }

test('a session others were forked from shows that before anything else', () => {
  const continued = thread({
    origin: { kind: 'continued', threadId: 'thr_z' },
    lastMessageAtMs: undefined,
  })
  expect(sessionState(continued, { forkedFrom: new Set(['thr_a']) })).toBe(
    'forked-from',
  )
})

test('a continuation shows that before whether it has started', () => {
  const continued = thread({
    origin: { kind: 'continued', threadId: 'thr_z' },
    lastMessageAtMs: undefined,
  })
  expect(sessionState(continued, none)).toBe('continues')
})

test('a session with no message yet shows as not started', () => {
  expect(sessionState(thread({ lastMessageAtMs: undefined }), none)).toBe(
    'not-started',
  )
})

test('a fork itself, and a session under way, show their type instead', () => {
  expect(sessionState(thread(), none)).toBeUndefined()
  const fork = thread({
    origin: {
      kind: 'forked',
      threadId: 'thr_z',
      branchId: 'br_a',
      messageId: 'msg_a',
    },
  })
  expect(sessionState(fork, none)).toBeUndefined()
  expect(sessionState(undefined, none)).toBeUndefined()
})
