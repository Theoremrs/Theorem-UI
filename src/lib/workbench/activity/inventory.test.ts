// SOURCING: none — bun:test over ./inventory with organization reads built by hand
import { describe, expect, test } from 'bun:test'
import type { OrganizationRead, ThreadEntry } from '@/lib/theorem/organization'
import { buildInventory } from './inventory'

const thread = (id: string, attention: ThreadEntry['attention']): ThreadEntry => ({
  threadId: id,
  title: `Thread ${id}`,
  homeProjectId: 'p',
  revision: 1,
  createdAtMs: 1,
  memberships: [],
  attention,
})

const org = (threads: ThreadEntry[], complete = true): OrganizationRead =>
  ({ threads, projects: [], complete, served: true }) as unknown as OrganizationRead

describe('inventory', () => {
  test('running, waiting and failed threads are listed; resting ones are not', () => {
    const inv = buildInventory({
      at: 5,
      organization: org([
        thread('a', { reasons: [], running: true, runId: 'run-a' }),
        thread('b', { reasons: [], running: false }),
        thread('c', { reasons: [{ kind: 'failed', runId: 'run-c', atMs: 2 }], running: false }),
        thread('d', {
          reasons: [{ kind: 'review', reviewId: 'rv', title: 'x', optionCount: 2, atMs: 3 }],
          running: true,
          runId: 'run-d',
        }),
      ]),
      terminals: [],
    })
    expect(inv.entries.map((e) => [e.resource, e.execution, e.runId])).toEqual([
      ['a', 'running', 'run-a'],
      ['c', 'failed', 'run-c'],
      ['d', 'waiting', 'run-d'],
    ])
    expect(inv.entries[2]?.waiting).toEqual({ for: 'approval', ref: 'rv' })
  })

  test('it never claims to be complete, and names what it could not read', () => {
    const inv = buildInventory({ at: 0, organization: org([], false) })
    expect(inv.completeness.complete).toBe(false)
    expect(inv.completeness.gaps.join(' ')).toContain('project-wide run list')
    expect(inv.completeness.gaps.join(' ')).toContain('first page of threads')
    expect(inv.completeness.gaps.join(' ')).toContain('Terminal sessions')
  })

  test("a terminal's exit is the program's, not an agent outcome, and stays a report", () => {
    const inv = buildInventory({
      at: 0,
      organization: org([]),
      terminals: [
        { workspace: 'w', session: 's1', label: 'zsh', exitCode: 0 },
        { workspace: 'w', session: 's2', label: 'Claude Code', runId: 'run-7', exitCode: null },
      ],
    })
    expect(inv.entries).toMatchObject([
      { resource: 'w/s1', execution: 'unknown', reported: true, detail: 'Program exited with code 0' },
      { resource: 'w/s2', execution: 'running', runId: 'run-7' },
    ])
  })

  test('a side chat whose thread is listed shows once, and a closed one says so', () => {
    const inv = buildInventory({
      at: 0,
      organization: org([thread('side-t', { reasons: [], running: true, runId: 'r' })]),
      terminals: [],
      sideChats: [
        { conversationId: 'side-1', threadId: 'side-t', running: true },
        { conversationId: 'side-2', threadId: 'side-u', detached: true },
        { conversationId: 'side-3' },
      ],
      delegations: [{ runId: 'd1', parentRunId: 'r', label: 'Reviewer', execution: 'running' }],
    })
    expect(inv.entries.map((e) => e.key)).toEqual([
      'thread:side-t',
      'sideChat:side-u',
      'delegation:d1',
    ])
    expect(inv.entries[1]?.detail).toContain('reopen')
    expect(inv.entries[2]?.parentRunId).toBe('r')
  })
})
