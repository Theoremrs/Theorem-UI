// SOURCING: none — bun:test over ./feed with a stub language owner, a hand-made documents view and a manual timer
import { describe, expect, test } from 'bun:test'
import type { OpenDocument, OpenDocumentChange } from '../documents/port'
import type { HostMessage } from '../wire'
import { startDiagnosticsFeed, positionAt } from './feed'
import type { DiagnosticsResult } from './language'

const wait = () => new Promise((resolve) => setTimeout(resolve, 0))

function setup(
  documents: OpenDocument[],
  answer: (path: string, revision: number) => unknown,
) {
  const open = [...documents]
  const listeners = new Set<(change: OpenDocumentChange) => void>()
  const sent: HostMessage[] = []
  const asked: { path: string; revision: number }[] = []
  const tasks: { task: () => void; ms: number; live: boolean }[] = []
  const stop = startDiagnosticsFeed({
    language: {
      diagnostics: async ({ resourceId, revision, requestId }) => {
        asked.push({ path: resourceId, revision })
        const got = answer(resourceId, revision) as
          DiagnosticsResult | { refused: string }
        const answers = { workspaceId: 'w1', requestId }
        return 'refused' in got
          ? { ...answers, outcome: 'refused', code: got.refused, reason: 'no' }
          : { ...answers, outcome: 'accepted', value: got }
      },
    },
    documents: {
      list: () => open,
      on: (listener) => {
        listeners.add(listener)
        return () => void listeners.delete(listener)
      },
    },
    emit: (message) => sent.push(message),
    timer: {
      set: (task, ms) => {
        const entry = { task, ms, live: true }
        tasks.push(entry)
        return entry
      },
      clear: (handle) => void ((handle as { live: boolean }).live = false),
    },
  })
  return {
    stop,
    sent,
    asked,
    open,
    change: (change: OpenDocumentChange) =>
      listeners.forEach((listener) => listener(change)),
    /** Runs the timers that are due, then lets the answers land. */
    fire: async () => {
      for (const entry of tasks.splice(0)) if (entry.live) entry.task()
      await wait()
    },
    pending: () => tasks.filter((entry) => entry.live).length,
  }
}

const seq = (value: number) => ({ scheme: 'seq' as const, value })
const finding = (start: number, end: number, extra = {}) => ({
  id: 'E1',
  start,
  end,
  severity: 'error' as const,
  message: 'bad',
  ...extra,
})

describe('positionAt', () => {
  test('counts lines and UTF-16 columns', () => {
    expect(positionAt('ab\ncd😀e', 0)).toEqual({ line: 0, character: 0 })
    expect(positionAt('ab\ncd😀e', 3)).toEqual({ line: 1, character: 0 })
    expect(positionAt('ab\ncd😀e', 7)).toEqual({ line: 1, character: 4 })
  })
})

describe('diagnostics feed', () => {
  test('a document open at the start is asked about, and its UTF-8 findings come out as line and column in UTF-16', async () => {
    // 'é' is two bytes and one UTF-16 unit, '😀' four bytes and two units.
    const text = 'é😀\nlet x'
    const t = setup([{ path: 'a.ts', text, revision: seq(3) }], () => ({
      revision: 3,
      full: true,
      findings: [finding(0, 2), finding(7, 12, { provider: 'tsc', id: 'TS1' })],
    }))
    await t.fire()
    expect(t.asked).toEqual([{ path: 'a.ts', revision: 3 }])
    expect(t.sent).toEqual([
      {
        type: 'diagnosticsSet',
        path: 'a.ts',
        revision: seq(3),
        encoding: 'utf16_code_units',
        findings: [
          {
            range: {
              start: { line: 0, character: 0 },
              end: { line: 0, character: 1 },
            },
            severity: 'error',
            message: 'bad',
            code: 'E1',
          },
          {
            range: {
              start: { line: 1, character: 0 },
              end: { line: 1, character: 5 },
            },
            severity: 'error',
            message: 'bad',
            source: 'tsc',
            code: 'TS1',
          },
        ],
      },
    ])
  })

  test('the same findings at the same revision are sent once', async () => {
    const t = setup([{ path: 'a.ts', text: 'x', revision: seq(1) }], () => ({
      revision: 1,
      full: true,
      findings: [finding(0, 1)],
    }))
    await t.fire()
    t.change({ kind: 'revised', path: 'a.ts' })
    await t.fire()
    expect(t.asked).toHaveLength(2)
    expect(t.sent).toHaveLength(1)
  })

  test('a set for an older revision than the document’s current one is not sent', async () => {
    const t = setup([{ path: 'a.ts', text: 'x', revision: seq(2) }], () => ({
      revision: 1,
      full: true,
      findings: [finding(0, 1)],
    }))
    await t.fire()
    expect(t.sent).toEqual([])
  })

  test('a revision that moves while the host answers is dropped, and the new revision is asked about', async () => {
    const t: ReturnType<typeof setup> = setup(
      [{ path: 'a.ts', text: 'x', revision: seq(1) }],
      () => {
        t.open[0] = { path: 'a.ts', text: 'xy', revision: seq(2) }
        t.change({ kind: 'revised', path: 'a.ts' })
        return { revision: 1, full: true, findings: [finding(0, 1)] }
      },
    )
    await t.fire()
    expect(t.sent).toEqual([])
    expect(t.pending()).toBe(1)
  })

  test('an answer with no revision is not placed', async () => {
    const t = setup([{ path: 'a.ts', text: 'x', revision: seq(1) }], () => ({
      full: true,
      findings: [finding(0, 1)],
    }))
    await t.fire()
    expect(t.sent).toEqual([])
  })

  test('a finding the text cannot place is left out, the rest are sent', async () => {
    const t = setup([{ path: 'a.ts', text: 'é', revision: seq(1) }], () => ({
      revision: 1,
      full: true,
      findings: [finding(1, 2), finding(0, 2)],
    }))
    await t.fire()
    expect(t.sent[0]).toMatchObject({
      findings: [{ range: { start: { character: 0 }, end: { character: 1 } } }],
    })
  })

  test('closing a document that had a set clears it; one that never had one sends nothing', async () => {
    const t = setup(
      [
        { path: 'a.ts', text: 'x', revision: seq(1) },
        { path: 'b.ts', text: 'x', revision: seq(1) },
      ],
      (path) => ({
        revision: 1,
        full: true,
        findings: path === 'a.ts' ? [finding(0, 1)] : [],
      }),
    )
    await t.fire()
    t.sent.length = 0
    t.change({ kind: 'closed', path: 'a.ts' })
    t.change({ kind: 'closed', path: 'zzz.ts' })
    expect(t.sent).toEqual([{ type: 'diagnosticsCleared', path: 'a.ts' }])
  })

  test('a document that finds nothing still gets its empty set, so a panel can drop old findings', async () => {
    const t = setup([{ path: 'a.ts', text: 'x', revision: seq(1) }], () => ({
      revision: 1,
      full: true,
      findings: [],
    }))
    await t.fire()
    expect(t.sent).toMatchObject([{ type: 'diagnosticsSet', findings: [] }])
  })

  test('a move clears the old path and asks about the new one', async () => {
    const t = setup([{ path: 'a.ts', text: 'x', revision: seq(1) }], () => ({
      revision: 1,
      full: true,
      findings: [finding(0, 1)],
    }))
    await t.fire()
    t.open[0] = { path: 'b.ts', text: 'x', revision: seq(1) }
    t.change({ kind: 'moved', from: 'a.ts', to: 'b.ts' })
    await t.fire()
    expect(t.sent.map((m) => [m.type, 'path' in m ? m.path : ''])).toEqual([
      ['diagnosticsSet', 'a.ts'],
      ['diagnosticsCleared', 'a.ts'],
      ['diagnosticsSet', 'b.ts'],
    ])
  })

  test('a partial set asks again, a bounded number of times', async () => {
    const t = setup([{ path: 'a.ts', text: 'x', revision: seq(1) }], () => ({
      revision: 1,
      full: false,
      findings: [],
    }))
    for (let i = 0; i < 10; i += 1) await t.fire()
    expect(t.asked).toHaveLength(6)
  })

  test('a host without diagnostics gets nothing sent and is not asked again', async () => {
    const t = setup([{ path: 'a.ts', text: 'x', revision: seq(1) }], () => ({
      refused: 'missing_capability',
    }))
    await t.fire()
    t.change({ kind: 'revised', path: 'a.ts' })
    await t.fire()
    expect(t.asked).toHaveLength(1)
    expect(t.sent).toEqual([])
  })

  test('stopping cancels what is waiting and sends nothing more', async () => {
    const t = setup([{ path: 'a.ts', text: 'x', revision: seq(1) }], () => ({
      revision: 1,
      full: true,
      findings: [],
    }))
    t.stop()
    await t.fire()
    expect(t.asked).toEqual([])
    t.change({ kind: 'opened', path: 'a.ts' })
    expect(t.pending()).toBe(0)
  })
})
