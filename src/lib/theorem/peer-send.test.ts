// SOURCING: bun:test over the real SDK client, lib/theorem/passthrough and lib/theorem/roster, with window.fetch answered in process by stories/fake-theorem; no Theorem is running
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from 'bun:test'
import { installFakeTheorem } from '@/stories/fake-theorem'
import type { FakeRoutes } from '@/stories/fake-theorem'
import { bootstrap } from './client'
import { usePeerRuns } from './peer-runs'
import {
  PeerSendRefused,
  parseOutcomes,
  roomTurnOptions,
  sendToRoom,
  settleRoom,
} from './peer-send'
import { parseParticipant, readConversationRoster, useRoster } from './roster'

const page = (
  window as unknown as { happyDOM: { setURL: (url: string) => void } }
).happyDOM
beforeAll(() => page.setURL('http://localhost:3000/'))
afterAll(() => page.setURL('about:blank'))

const THREAD = 'thread-1'
const CONVERSATION = 'conv-1'

type Sent = {
  ifMatch: string | null
  key: string | null
  csrf: string | null
  body: Record<string, unknown>
}
let sends: Sent[] = []
let puts = 0
let restore: () => void = () => {}

beforeEach(() => {
  sends = []
  puts = 0
  usePeerRuns.setState({ active: {}, runs: {}, problems: {} })
})
afterEach(() => {
  restore()
  useRoster.setState({ byConversation: {}, current: undefined, reads: {} })
})

const wire = (id: string, label: string) => ({
  participantId: id,
  actorId: `agent:${id}`,
  model: { provider: 'p', model: label.toLowerCase() },
  label,
  status: 'active',
  addedAtMs: 1,
})

const ROOM = [wire('ptc_a', 'Alpha'), wire('ptc_b', 'Beta')]

/** The room this browser holds for the conversation, as confirmed by Theorem. */
function hold(participants: unknown[], unsaved = false) {
  useRoster.setState({
    byConversation: {
      [CONVERSATION]: {
        remoteId: THREAD,
        roster: {
          revision: 7,
          participants: participants.map((row) => parseParticipant(row)!),
          activeRuns: [],
        },
        lead: undefined,
        unsaved,
        edits: unsaved ? 1 : 0,
        error: undefined,
      },
    },
    reads: { [THREAD]: 'read' },
  })
}

type Answer = (request: Request, attempt: number) => unknown

async function theorem(options: {
  cap?: number
  threadRevision?: () => number
  rosterRevision?: () => number
  answer?: Answer
}) {
  const routes: FakeRoutes = {
    'GET /api/chat/v1/bootstrap': () => ({
      csrfToken: 'csrf',
      tenantId: 't',
      ...(options.cap === undefined
        ? {}
        : { peerMaxOutputTokens: options.cap }),
    }),
    'GET /api/chat/v1/threads/:threadId': () => ({
      thread: {
        threadId: THREAD,
        revision: options.threadRevision?.() ?? 12,
        rosterRevision: options.rosterRevision?.() ?? 7,
        selectedBranchId: 'branch-1',
        participants: ROOM,
        activeRuns: [],
      },
      messages: [],
    }),
    'PUT /api/chat/v1/threads/:threadId/participants': () => {
      puts += 1
      return { roster: { revision: 8, participants: ROOM } }
    },
    'POST /api/chat/v1/threads/:threadId/messages': async (
      _params,
      request,
    ) => {
      sends.push({
        ifMatch: request.headers.get('If-Match'),
        key: request.headers.get('Idempotency-Key'),
        csrf: request.headers.get('X-CSRF-Token'),
        body: (await request.clone().json()) as Record<string, unknown>,
      })
      const answer = options.answer?.(request, sends.length)
      if (answer !== undefined) return answer
      return new Response(
        JSON.stringify({
          record: { messageId: 'msg-1' },
          receipt: {},
          threadRevision: 13,
          runs: [
            {
              participantId: 'ptc_a',
              status: 'started',
              run: { runId: 'run-a' },
            },
            { participantId: 'ptc_b', status: 'queued' },
          ],
        }),
        { status: 201, headers: { 'content-type': 'application/json' } },
      )
    },
  }
  restore = installFakeTheorem(routes)
  await bootstrap(true)
}

const send = (
  extra: Record<string, unknown> = {},
  signal = new AbortController().signal,
) =>
  sendToRoom({
    threadId: THREAD,
    text: 'Compare the two designs.',
    options: {
      webResearch: true,
      model: { provider: 'p', model: 'lead' },
      clientOperations: [{ name: 'kit.read' }],
      clientSurface: { revision: 3 },
      ...extra,
    },
    room: { revision: 7 },
    signal,
  })

const problem = (code: string, status = 409) =>
  new Response(JSON.stringify({ code, title: code }), {
    status,
    headers: { 'content-type': 'application/problem+json' },
  })

test('a conversation with one seat is not a room and nothing is written', async () => {
  await theorem({})
  hold([ROOM[0]!])
  expect(await settleRoom(CONVERSATION, THREAD)).toBeUndefined()
  expect(puts).toBe(0)
})

test('two seats not yet written are written first, and the send names that revision', async () => {
  await theorem({})
  hold(ROOM, true)
  expect(await settleRoom(CONVERSATION, THREAD)).toEqual({ revision: 8 })
  expect(puts).toBe(1)
})

test('a send joins a roster read already in progress', async () => {
  let release = () => {}
  const pending = new Promise<void>((resolve) => { release = resolve })
  let reads = 0
  restore = installFakeTheorem({
    'GET /api/chat/v1/threads/:threadId': async () => {
      reads += 1
      await pending
      return {
        thread: { threadId: THREAD, rosterRevision: 7, participants: ROOM },
        messages: [],
      }
    },
  })
  const read = readConversationRoster(CONVERSATION, THREAD)
  const room = settleRoom(CONVERSATION, THREAD)
  release()
  await read
  expect(await room).toEqual({ revision: 7 })
  expect(reads).toBe(1)
})

test('an unavailable roster is not treated as a single-agent room', async () => {
  restore = installFakeTheorem({
    'GET /api/chat/v1/threads/:threadId': () => problem('store_unavailable', 422),
  })
  await expect(settleRoom(CONVERSATION, THREAD)).rejects.toThrow(
    "The conversation's roster could not be checked.",
  )
})

test('a room that cannot be saved is refused, not sent to as the one it was', async () => {
  restore = installFakeTheorem({
    'GET /api/chat/v1/bootstrap': () => ({ csrfToken: 'csrf', tenantId: 't' }),
    'GET /api/chat/v1/threads/:threadId': () => ({
      thread: { threadId: THREAD },
      messages: [],
    }),
    'PUT /api/chat/v1/threads/:threadId/participants': () =>
      problem('chat_roster_refused', 422),
  })
  await bootstrap(true)
  hold(ROOM, true)
  await expect(settleRoom(CONVERSATION, THREAD)).rejects.toBeInstanceOf(
    PeerSendRefused,
  )
})

test('one send carries the roster revision, everyone as audience, and no model', async () => {
  await theorem({ cap: 4000 })
  const sent = await send()
  expect(sends).toHaveLength(1)
  const [request] = sends
  expect(request!.body).toEqual({
    webResearch: true,
    branchId: 'branch-1',
    text: 'Compare the two designs.',
    expectedRosterRevision: 7,
    audience: { kind: 'everyone' },
  })
  // Theorem's own guards: the thread's revision, a CSRF token, one send identity.
  expect(request!.ifMatch).toBe('12')
  expect(request!.csrf).toBe('csrf')
  expect(request!.key).toBeTruthy()
  expect(sent.messageId).toBe('msg-1')
})

test('each participant has its own outcome; only started runs are followed', async () => {
  await theorem({
    cap: 4000,
    answer: () => ({
      record: { messageId: 'msg-1' },
      runs: [
        { participantId: 'ptc_a', status: 'started', run: { runId: 'run-a' } },
        {
          participantId: 'ptc_b',
          status: 'failed',
          problem: {
            code: 'chat_peer_admission_failed',
            detail: 'No credential for this model.',
          },
        },
        { participantId: 'ptc_c', status: 'queued' },
      ],
    }),
  })
  await send()
  const state = usePeerRuns.getState()
  expect(state.active[THREAD]!.map((r) => [r.participantId, r.runId])).toEqual([
    ['ptc_a', 'run-a'],
  ])
  expect(state.problems[THREAD]).toEqual([
    { participantId: 'ptc_b', message: 'No credential for this model.' },
  ])
})

test('a Theorem with no shared output limit refuses the send and sends nothing', async () => {
  await theorem({})
  const refused = await send().catch((error: unknown) => error)
  expect(refused).toBeInstanceOf(PeerSendRefused)
  expect((refused as Error).message).toContain('Your message was not sent.')
  expect(sends).toHaveLength(0)
})

test('a limit that is not a positive number is no limit', async () => {
  await theorem({ cap: 0 })
  expect(await send().catch((error: unknown) => error)).toBeInstanceOf(
    PeerSendRefused,
  )
  expect(sends).toHaveLength(0)
})

test.each([
  [{ planning: true }],
  [{ plan: { planId: 'p' } }],
  [{ role: 'reviewer' }],
  [{ regime: 'strict' }],
])('a turn setting for one agent (%o) is refused for a room', async (extra) => {
  await theorem({ cap: 4000 })
  expect(await send(extra).catch((error: unknown) => error)).toBeInstanceOf(
    PeerSendRefused,
  )
  expect(sends).toHaveLength(0)
})

test('Plan left off is not a plan', () => {
  expect(roomTurnOptions({ planning: false, webResearch: true })).toEqual({
    planning: false,
    webResearch: true,
  })
})

test('a conversation that moved is sent against its new revision when the room did not', async () => {
  let revision = 12
  await theorem({
    cap: 4000,
    threadRevision: () => revision,
    answer: (_request, attempt) => {
      if (attempt > 1) return undefined
      revision = 14
      return problem('chat_revision_conflict')
    },
  })
  await send()
  expect(sends.map((request) => request.ifMatch)).toEqual(['12', '14'])
  // A new attempt is a new send: it must not replay the refused one.
  expect(new Set(sends.map((request) => request.key)).size).toBe(2)
})

test('a room that moved is not sent to under the old revision again', async () => {
  let roster = 7
  await theorem({
    cap: 4000,
    rosterRevision: () => roster,
    answer: () => {
      roster = 9
      return problem('chat_revision_conflict')
    },
  })
  const refused = await send().catch((error: unknown) => error)
  expect(refused).toBeInstanceOf(PeerSendRefused)
  expect((refused as Error).message).toContain('room changed')
  expect(sends).toHaveLength(1)
})

test('a send that got no answer is retried as the same send', async () => {
  await theorem({
    cap: 4000,
    answer: (_request, attempt) => {
      if (attempt === 1) throw new Error('network down')
      return undefined
    },
  })
  expect(await send().catch((error: unknown) => error)).toBeInstanceOf(
    PeerSendRefused,
  )
  await send()
  expect(sends).toHaveLength(2)
  expect(sends[1]!.key).toBe(sends[0]!.key)
  expect(sends[1]!.ifMatch).toBe(sends[0]!.ifMatch)
})

test('an answer without runs starts nothing', () => {
  expect(parseOutcomes({ record: { messageId: 'm' } })).toEqual({
    started: [],
    problems: [],
  })
  expect(parseOutcomes(undefined)).toEqual({ started: [], problems: [] })
})
