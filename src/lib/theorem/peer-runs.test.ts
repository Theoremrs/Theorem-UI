// SOURCING: bun:test over deterministic run fixtures: event streams driven by hand for the concurrency cases, and the real SDK client reading server-sent events from window.fetch answered in process by stories/fake-theorem for the wire case; no Theorem is running
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test'
import { installFakeTheorem } from '@/stories/fake-theorem'
import type { FakeRoutes } from '@/stories/fake-theorem'
import { bootstrap } from './client'
import type { Theorem } from './client'
import {
  followPeerRun,
  foldPeerEvent,
  noteStarted,
  noteThread,
  presenceOf,
  runsOfThread,
  runsToShow,
  stopParticipant,
  usePeerRuns,
} from './peer-runs'
import type { OpenRunEvents, PeerRun } from './peer-runs'
import { parseParticipant } from './roster'

const page = (
  window as unknown as { happyDOM: { setURL: (url: string) => void } }
).happyDOM
beforeAll(() => page.setURL('http://localhost:3000/'))
afterAll(() => page.setURL('about:blank'))

let restore: () => void = () => {}
beforeEach(() => usePeerRuns.setState({ active: {}, runs: {}, problems: {} }))
afterEach(() => restore())

const instant = { backoffMs: () => 0 }

/** One run event, as the events stream carries it. */
const event = (
  runId: string,
  seq: number,
  sourceEventType: string,
  payload: Record<string, unknown> = {},
): Theorem.RunEvent => ({
  schema: 'theorem.run.event.v1',
  runId,
  seq,
  kind: 'event',
  sourceEventType,
  payload,
  stateHashAfter: '',
  idempotencyKey: `${runId}:${seq}`,
})

const said = (runId: string, seq: number, partId: string, text: string) =>
  event(runId, seq, 'CHAT.MESSAGE.PART', {
    part: { partId, type: 'text', text },
  })

/** A thread that lists these runs as active, as the thread read carries them. */
const thread = (
  runs: ReadonlyArray<[participantId: string, runId: string, cursor?: number]>,
  threadId = 'thread-1',
) => ({
  threadId,
  rosterRevision: 4,
  participants: [],
  activeRuns: runs.map(([participantId, runId, cursor = 0]) => ({
    participantId,
    runId,
    cursor,
  })),
})

/**
 * A run's events as a person at the keyboard of the test releases them: the
 * stream stays open until `end`, so two runs can be held mid-flight at once.
 */
function controlled() {
  const queue: Theorem.RunEvent[] = []
  let wake: (() => void) | undefined
  let ended = false
  return {
    push(...events: Theorem.RunEvent[]) {
      queue.push(...events)
      wake?.()
    },
    end() {
      ended = true
      wake?.()
    },
    async *stream(): AsyncGenerator<Theorem.RunEvent> {
      for (;;) {
        const next = queue.shift()
        if (next) {
          yield next
          continue
        }
        if (ended) return
        await new Promise<void>((resolve) => (wake = resolve))
      }
    },
  }
}

/** Long enough for every stream the test has fed to be read and applied. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 10))
const run = (runId: string) => usePeerRuns.getState().runs[runId]!
const text = (value: PeerRun) =>
  [...value.parts.values()].map(
    (part) => (part.payload as { text?: string }).text,
  )

describe('what a thread lists', () => {
  test('runs are held per participant and per thread', () => {
    noteThread(
      thread([
        ['ptc_a', 'run-a'],
        ['ptc_b', 'run-b'],
      ]),
    )
    noteThread(thread([['ptc_c', 'run-c']], 'thread-2'))
    const { active, runs } = usePeerRuns.getState()
    expect(active['thread-1']!.map((r) => [r.participantId, r.runId])).toEqual([
      ['ptc_a', 'run-a'],
      ['ptc_b', 'run-b'],
    ])
    expect(runsOfThread(runs, 'thread-1').map((r) => r.participantId)).toEqual([
      'ptc_a',
      'ptc_b',
    ])
    expect(runsOfThread(runs, 'thread-2').map((r) => r.runId)).toEqual([
      'run-c',
    ])
  })

  test('a read that says nothing new changes nothing', () => {
    noteThread(thread([['ptc_a', 'run-a']]))
    const before = usePeerRuns.getState()
    noteThread(thread([['ptc_a', 'run-a']]))
    expect(usePeerRuns.getState()).toBe(before)
  })

  test('a conversation with one agent lists no runs', () => {
    noteThread({ threadId: 'thread-1', activeRunId: 'run-1', revision: 3 })
    expect(usePeerRuns.getState().active['thread-1']).toBeUndefined()
    expect(usePeerRuns.getState().runs).toEqual({})
  })

  test('runs on another branch than the one on screen are not listed', () => {
    noteThread({
      ...thread([]),
      selectedBranchId: 'main',
      activeRuns: [
        { participantId: 'ptc_a', runId: 'run-a', cursor: 0, branchId: 'main' },
        { participantId: 'ptc_b', runId: 'run-b', cursor: 0, branchId: 'side' },
        { participantId: 'ptc_c', runId: 'run-c', cursor: 0 },
      ],
    })
    expect(
      usePeerRuns.getState().active['thread-1']!.map((r) => r.runId),
    ).toEqual(['run-a', 'run-c'])
    expect(Object.keys(usePeerRuns.getState().runs)).toEqual(['run-a', 'run-c'])
  })

  test('a send names the runs it started and who did not start', () => {
    noteStarted(
      'thread-1',
      [{ participantId: 'ptc_a', runId: 'run-a', cursor: 0 }],
      [{ participantId: 'ptc_b', message: 'No credential for this model.' }],
    )
    const state = usePeerRuns.getState()
    expect(state.active['thread-1']!.map((r) => r.runId)).toEqual(['run-a'])
    expect(state.runs['run-a']!.participantId).toBe('ptc_a')
    expect(state.problems['thread-1']).toEqual([
      { participantId: 'ptc_b', message: 'No credential for this model.' },
    ])
  })

  test('a run that has left the list keeps what was read of it', () => {
    noteThread(thread([['ptc_a', 'run-a']]))
    noteThread(thread([]))
    expect(usePeerRuns.getState().active['thread-1']).toEqual([])
    expect(run('run-a').participantId).toBe('ptc_a')
  })
})

describe('two runs at once', () => {
  test('each is read on its own: distinct parts, cursors and ends', async () => {
    noteThread(
      thread([
        ['ptc_a', 'run-a'],
        ['ptc_b', 'run-b'],
      ]),
    )
    const a = controlled()
    const b = controlled()
    const streams = { 'run-a': a, 'run-b': b }
    const opened: Array<[string, number]> = []
    const open: OpenRunEvents = async (runId, after) => {
      opened.push([runId, after])
      return streams[runId as keyof typeof streams].stream()
    }
    const signal = new AbortController().signal
    const reading = [
      followPeerRun('run-a', signal, { open, ...instant }),
      followPeerRun('run-b', signal, { open, ...instant }),
    ]

    a.push(said('run-a', 1, 'p1', 'A starts'))
    b.push(
      said('run-b', 1, 'p1', 'B starts'),
      said('run-b', 2, 'p2', 'B goes on'),
    )
    await settle()
    // The same part id in two runs is two parts: nothing is shared between them.
    expect(text(run('run-a'))).toEqual(['A starts'])
    expect(text(run('run-b'))).toEqual(['B starts', 'B goes on'])
    expect([run('run-a').cursor, run('run-b').cursor]).toEqual([1, 2])

    // B finishes first; A is still going and its conversation is not ended.
    b.push(event('run-b', 3, 'RUN.CLOSED'))
    await settle()
    expect(run('run-b').ended).toBe('RUN.CLOSED')
    expect(run('run-a').ended).toBeUndefined()

    a.push(said('run-a', 2, 'p1', 'A starts, then finishes'))
    await settle()
    expect(text(run('run-a'))).toEqual(['A starts, then finishes'])
    expect(text(run('run-b'))).toEqual(['B starts', 'B goes on'])

    a.push(event('run-a', 3, 'RUN.CLOSED'))
    await Promise.all(reading)
    // Each opened once, from its own start.
    expect(opened).toEqual([
      ['run-a', 0],
      ['run-b', 0],
    ])
  })

  test('one run failing leaves the other running, and says why', async () => {
    noteThread(
      thread([
        ['ptc_a', 'run-a'],
        ['ptc_b', 'run-b'],
      ]),
    )
    const a = controlled()
    const b = controlled()
    const open: OpenRunEvents = async (runId) =>
      (runId === 'run-a' ? a : b).stream()
    const controller = new AbortController()
    const reading = [
      followPeerRun('run-a', controller.signal, { open, ...instant }),
      followPeerRun('run-b', controller.signal, { open, ...instant }),
    ]
    a.push(
      event('run-a', 1, 'RUN.FAILED', { message: 'The provider refused.' }),
    )
    b.push(said('run-b', 1, 'p1', 'Still here'))
    await settle()
    expect(run('run-a').ended).toBe('RUN.FAILED')
    expect(run('run-a').failure).toContain('The provider refused.')
    expect(run('run-b').ended).toBeUndefined()
    expect(run('run-b').failure).toBeUndefined()
    expect(text(run('run-b'))).toEqual(['Still here'])
    controller.abort()
    b.end()
    await Promise.all(reading)
  })

  test('the saved reply is named by the run that persisted it', async () => {
    noteThread(thread([['ptc_a', 'run-a']]))
    const open: OpenRunEvents = async () =>
      (async function* () {
        yield event('run-a', 1, 'CHAT.MESSAGE.PERSISTED', {
          role: 'assistant',
          messageId: 'msg-a',
        })
        yield event('run-a', 2, 'RUN.CLOSED')
      })()
    await followPeerRun('run-a', new AbortController().signal, {
      open,
      ...instant,
    })
    expect(run('run-a').messageId).toBe('msg-a')
  })
})

describe('reading one run', () => {
  test('starts from the run start whatever cursor the thread lists', async () => {
    // The thread's cursor is how far Theorem has taken the run, not a snapshot
    // of what it said: reading after it would show a run missing its start.
    noteThread(thread([['ptc_a', 'run-a', 41]]))
    const opened: number[] = []
    const open: OpenRunEvents = async (_runId, after) => {
      opened.push(after)
      return (async function* () {
        yield said('run-a', 1, 'p1', 'From the start')
        yield event('run-a', 2, 'RUN.CLOSED')
      })()
    }
    await followPeerRun('run-a', new AbortController().signal, {
      open,
      ...instant,
    })
    expect(opened).toEqual([0])
    expect(text(run('run-a'))).toEqual(['From the start'])
  })

  test('a dropped stream resumes after the last event applied', async () => {
    noteThread(thread([['ptc_a', 'run-a']]))
    const opened: number[] = []
    const open: OpenRunEvents = async (_runId, after) => {
      opened.push(after)
      if (opened.length === 1)
        return (async function* () {
          yield said('run-a', 1, 'p1', 'one')
          yield said('run-a', 2, 'p2', 'two')
          throw new Error('connection reset')
        })()
      return (async function* () {
        yield said('run-a', 3, 'p3', 'three')
        yield event('run-a', 4, 'RUN.CLOSED')
      })()
    }
    await followPeerRun('run-a', new AbortController().signal, {
      open,
      ...instant,
    })
    expect(opened).toEqual([0, 2])
    expect(text(run('run-a'))).toEqual(['one', 'two', 'three'])
    expect(run('run-a').cursor).toBe(4)
  })

  test('a stream that ends before the run does is reopened, not finished', async () => {
    noteThread(thread([['ptc_a', 'run-a']]))
    let opens = 0
    const open: OpenRunEvents = async () => {
      opens += 1
      return (async function* () {
        if (opens === 1) yield said('run-a', 1, 'p1', 'partial')
        else yield event('run-a', 2, 'RUN.CLOSED')
      })()
    }
    await followPeerRun('run-a', new AbortController().signal, {
      open,
      ...instant,
    })
    expect(opens).toBe(2)
    expect(run('run-a').ended).toBe('RUN.CLOSED')
  })

  test('gives up with a reason after repeated failures, leaving the run unended', async () => {
    noteThread(thread([['ptc_a', 'run-a']]))
    let opens = 0
    const open: OpenRunEvents = async () => {
      opens += 1
      throw new Error('Theorem is unreachable')
    }
    await followPeerRun('run-a', new AbortController().signal, {
      open,
      ...instant,
    })
    expect(opens).toBe(8)
    expect(run('run-a').error).toBe('Theorem is unreachable')
    expect(run('run-a').ended).toBeUndefined()
  })

  test('following a run already being followed is the same read', async () => {
    noteThread(thread([['ptc_a', 'run-a']]))
    const a = controlled()
    let opens = 0
    const open: OpenRunEvents = async () => {
      opens += 1
      return a.stream()
    }
    const controller = new AbortController()
    const first = followPeerRun('run-a', controller.signal, {
      open,
      ...instant,
    })
    await followPeerRun('run-a', controller.signal, { open, ...instant })
    a.push(event('run-a', 1, 'RUN.CLOSED'))
    await first
    expect(opens).toBe(1)
  })

  test('an abort stops reading and keeps what was read for the next read', async () => {
    noteThread(thread([['ptc_a', 'run-a']]))
    const a = controlled()
    const controller = new AbortController()
    const first = followPeerRun('run-a', controller.signal, {
      open: async () => a.stream(),
      ...instant,
    })
    a.push(said('run-a', 1, 'p1', 'kept'))
    await settle()
    controller.abort()
    a.end()
    await first
    expect(text(run('run-a'))).toEqual(['kept'])
    const opened: number[] = []
    await followPeerRun('run-a', new AbortController().signal, {
      open: async (_runId, after) => {
        opened.push(after)
        return (async function* () {
          yield event('run-a', 2, 'RUN.CLOSED')
        })()
      },
      ...instant,
    })
    expect(opened).toEqual([1])
    expect(run('run-a').ended).toBe('RUN.CLOSED')
  })

  test('a replayed event does not put an older part over a newer one', () => {
    const base: PeerRun = {
      threadId: 't',
      runId: 'run-a',
      participantId: 'ptc_a',
      cursor: 0,
      parts: new Map(),
    }
    const newer = foldPeerEvent(base, said('run-a', 5, 'p1', 'new'))
    expect(foldPeerEvent(newer, said('run-a', 3, 'p1', 'old'))).toBe(newer)
  })
})

describe('over the SDK client', () => {
  test('the real events route is read after the cursor this browser holds', async () => {
    const asked: string[] = []
    const routes: FakeRoutes = {
      'GET /api/chat/v1/bootstrap': () => ({
        csrfToken: 'csrf',
        tenantId: 't',
      }),
      'GET /api/chat/v1/runs/:runId/events': ({ runId }, request) => {
        const after = new URL(request.url).searchParams.get('after_seq')
        asked.push(`${runId}@${after}`)
        const events =
          Number(after) === 0
            ? [said(runId!, 1, 'p1', `${runId} hello`)]
            : [event(runId!, 2, 'RUN.CLOSED')]
        return new Response(
          events.map((item) => `data: ${JSON.stringify(item)}\n\n`).join(''),
          { headers: { 'content-type': 'text/event-stream' } },
        )
      },
    }
    restore = installFakeTheorem(routes)
    await bootstrap(true)
    noteThread(
      thread([
        ['ptc_a', 'run-a'],
        ['ptc_b', 'run-b'],
      ]),
    )
    const signal = new AbortController().signal
    await Promise.all([
      followPeerRun('run-a', signal, instant),
      followPeerRun('run-b', signal, instant),
    ])
    expect(asked.sort()).toEqual(['run-a@0', 'run-a@1', 'run-b@0', 'run-b@1'])
    expect(text(run('run-a'))).toEqual(['run-a hello'])
    expect(text(run('run-b'))).toEqual(['run-b hello'])
    expect([run('run-a').ended, run('run-b').ended]).toEqual([
      'RUN.CLOSED',
      'RUN.CLOSED',
    ])
  })

  test('stopping a participant posts its own id to the thread, once', async () => {
    const stopped: Array<{
      threadId: string
      body: unknown
      csrf: string | null
    }> = []
    restore = installFakeTheorem({
      'GET /api/chat/v1/bootstrap': () => ({
        csrfToken: 'csrf',
        tenantId: 't',
      }),
      'POST /api/chat/v1/threads/:threadId/participants/stop': async (
        { threadId },
        request,
      ) => {
        stopped.push({
          threadId: threadId!,
          body: await request.json(),
          csrf: request.headers.get('X-CSRF-Token'),
        })
        return {
          stopped: { stoppedParticipantIds: ['ptc_b'] },
          cancellations: [],
        }
      },
      // The per-run cancel is not how a participant is stopped.
      'POST /api/chat/v1/runs/:runId/cancel': () =>
        new Response('{}', { status: 500 }),
    })
    await bootstrap(true)
    await stopParticipant('thread-1', 'ptc_b')
    expect(stopped).toEqual([
      { threadId: 'thread-1', body: { participantId: 'ptc_b' }, csrf: 'csrf' },
    ])
  })
})

describe('who is doing what', () => {
  const seat = (id: string, label: string, status = 'active') =>
    parseParticipant({
      participantId: id,
      model: { provider: 'p', model: label.toLowerCase() },
      label,
      status,
    })!
  const read = (
    participantId: string,
    runId: string,
    ended?: string,
  ): PeerRun => ({
    threadId: 't',
    runId,
    participantId,
    cursor: 0,
    parts: new Map(),
    ...(ended ? { ended } : {}),
  })

  test('names working, idle, stopped and failed, and drops a removed seat', () => {
    const room = [
      seat('ptc_a', 'Alpha'),
      seat('ptc_b', 'Beta'),
      seat('ptc_c', 'Gamma', 'stopped'),
      seat('ptc_d', 'Delta'),
      seat('ptc_e', 'Epsilon', 'removed'),
    ]
    const presence = presenceOf(
      room,
      [{ participantId: 'ptc_a', runId: 'run-a', cursor: 3 }],
      [read('ptc_a', 'run-a'), read('ptc_d', 'run-d', 'RUN.FAILED')],
    )
    expect(presence.map((p) => [p.label, p.state, p.runId])).toEqual([
      ['Alpha', 'working', 'run-a'],
      ['Beta', 'idle', undefined],
      ['Gamma', 'stopped', undefined],
      ['Delta', 'failed', undefined],
    ])
  })

  test('a finished run is not working even while a stale list still has it', () => {
    const presence = presenceOf(
      [seat('ptc_a', 'Alpha')],
      [{ participantId: 'ptc_a', runId: 'run-a', cursor: 3 }],
      [read('ptc_a', 'run-a', 'RUN.CLOSED')],
    )
    expect(presence[0]!.state).toBe('idle')
  })

  test('a run whose reply the transcript has is not drawn twice', () => {
    const settled = {
      ...read('ptc_a', 'run-a', 'RUN.CLOSED'),
      messageId: 'msg-a',
    }
    const going = read('ptc_b', 'run-b')
    const none = new Set<string>()
    expect(
      runsToShow([settled, going], {
        messageIds: new Set(['msg-a']),
        runIds: none,
      }).map((r) => r.runId),
    ).toEqual(['run-b'])
    expect(
      runsToShow([settled, going], {
        messageIds: none,
        runIds: new Set(['run-b']),
      }).map((r) => r.runId),
    ).toEqual(['run-a'])
  })
})
