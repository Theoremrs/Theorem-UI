import { describe, expect, test } from 'bun:test'
import type { LibrarianStatus, OrganizeEvent } from '@/lib/theorem/organization'
import { librarianHasNews } from './librarian-footer'

const NOW = 1_800_000_000_000
const MINUTE = 60_000

const status = (change: Partial<LibrarianStatus>): LibrarianStatus => ({
  state: 'idle',
  paused: false,
  jobs: { membership: { enabled: true }, summary: { enabled: true } },
  queued: 0,
  recent: [],
  ...change,
})

const event = (atMs: number) =>
  ({ eventId: String(atMs), atMs, actor: 'librarian', kind: 'joined' }) as unknown as OrganizeEvent

describe('librarianHasNews', () => {
  test('a quiet, idle Librarian keeps the footer away', () => {
    expect(librarianHasNews(status({}), NOW)).toBe(false)
    expect(librarianHasNews(status({ recent: [event(NOW - 16 * MINUTE)] }), NOW)).toBe(false)
  })

  test('something done in the last quarter hour shows it', () => {
    expect(librarianHasNews(status({ recent: [event(NOW - 2 * MINUTE)] }), NOW)).toBe(true)
  })

  test('working or paused always shows it', () => {
    expect(librarianHasNews(status({ state: 'working', queued: 2 }), NOW)).toBe(true)
    expect(librarianHasNews(status({ state: 'paused', paused: true }), NOW)).toBe(true)
  })

  test('off shows it only with a reason to act on', () => {
    expect(librarianHasNews(status({ state: 'off' }), NOW)).toBe(false)
    expect(
      librarianHasNews(status({ state: 'off', offReason: 'No model is connected' }), NOW),
    ).toBe(true)
  })
})
