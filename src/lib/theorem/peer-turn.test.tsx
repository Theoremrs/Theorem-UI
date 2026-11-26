// SOURCING: bun:test over the real thread-list runtime (TheoremRuntimeProvider) sending from its composer, the real SDK client and lib/theorem/send-recovery, with window.fetch answered in process by stories/fake-theorem; no Theorem is running
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from 'bun:test'
import { useAui, useAuiState } from '@assistant-ui/react'
import { createElement, useEffect } from 'react'
import { cleanup, render, waitFor } from '../../../test/workspace'
import { installFakeTheorem } from '@/stories/fake-theorem'
import { bootstrap, takeRefusedText } from './client'
import { usePeerRuns } from './peer-runs'
import { parseParticipant, useRoster } from './roster'
import { TheoremRuntimeProvider } from './runtime'

const page = (
  window as unknown as { happyDOM: { setURL: (url: string) => void } }
).happyDOM
beforeAll(() => page.setURL('http://localhost:3000/'))
afterAll(() => page.setURL('about:blank'))

type Posted = { key: string | null; body: Record<string, unknown> }
let posted: Posted[] = []
let restore: () => void = () => {}

beforeEach(() => {
  posted = []
  usePeerRuns.setState({ active: {}, runs: {}, problems: {} })
})
afterEach(async () => {
  await cleanup()
  restore()
  useRoster.setState({ byConversation: {}, current: undefined, reads: {} })
})

const seat = (id: string, label: string) =>
  parseParticipant({
    participantId: id,
    model: { provider: 'p', model: label.toLowerCase() },
    label,
  })!

async function theorem(cap: number | undefined) {
  restore = installFakeTheorem({
    'GET /api/chat/v1/bootstrap': () => ({
      csrfToken: 'csrf',
      tenantId: 't',
      ...(cap === undefined ? {} : { peerMaxOutputTokens: cap }),
    }),
    'GET /api/chat/v1/projects/:projectId/threads': () => ({ items: [] }),
    'GET /api/chat/v1/threads': () => ({ items: [] }),
    'GET /api/chat/v1/threads/:threadId': ({ threadId }) => ({
      thread: {
        threadId,
        projectId: 'project',
        title: 'An existing chat',
        status: 'regular',
        selectedBranchId: 'branch-1',
        revision: 5,
        rosterRevision: 3,
      },
      messages: [],
    }),
    'POST /api/chat/v1/threads/:threadId/messages': async (
      _params,
      request,
    ) => {
      posted.push({
        key: request.headers.get('Idempotency-Key'),
        body: (await request.json()) as Record<string, unknown>,
      })
      const room = 'audience' in posted.at(-1)!.body
      return new Response(
        JSON.stringify(
          room
            ? {
                record: { messageId: 'user-1' },
                runs: [
                  {
                    participantId: 'ptc_a',
                    status: 'started',
                    run: { runId: 'run-a' },
                  },
                  {
                    participantId: 'ptc_b',
                    status: 'started',
                    run: { runId: 'run-b' },
                  },
                ],
              }
            : { record: { messageId: 'user-1' }, run: { runId: 'run-1' } },
        ),
        { status: 201, headers: { 'content-type': 'application/json' } },
      )
    },
    'GET /api/chat/v1/runs/:runId/events': () =>
      new Response(
        `data: ${JSON.stringify({ seq: 1, sourceEventType: 'RUN.CLOSED', payload: {} })}\n\n`,
        { headers: { 'content-type': 'text/event-stream' } },
      ),
  })
  await bootstrap(true)
}

/** The real composer of an open durable chat, sending `text` once the room is seated. */
async function chat(
  threadId: string,
  room: Array<[string, string]>,
  text = 'Compare the two designs.',
) {
  const seen: { text?: string; messages?: readonly unknown[]; error?: string } =
    {}
  function Sender() {
    const aui = useAui()
    const composer = useAuiState((s) => s.composer.text)
    const messages = useAuiState((s) => s.thread.messages)
    seen.text = composer
    seen.messages = messages
    useEffect(() => {
      const conversation = aui.threadListItem.getState().id
      useRoster.setState({
        byConversation: {
          [conversation]: {
            remoteId: threadId,
            roster: {
              revision: 3,
              participants: room.map(([id, label]) => seat(id, label)),
              activeRuns: [],
            },
            lead: room[0]?.[0],
            unsaved: false,
            edits: 0,
            error: undefined,
          },
        },
        current: conversation,
        reads: { [threadId]: 'read' },
      })
      aui.composer.setText(text)
      aui.composer.send()
    }, [aui])
    return null
  }
  await render(
    createElement(TheoremRuntimeProvider, {
      projectId: 'project',
      threadId,
      onThreadIdChange: () => {},
      children: createElement(Sender),
    }),
  )
  return seen
}

const lastReply = (seen: { messages?: readonly unknown[] }) =>
  (seen.messages ?? []).at(-1) as
    | {
        role: string
        status?: { type: string; error?: unknown }
        metadata: { custom: Record<string, unknown> }
      }
    | undefined

test('a room of two sends once to the room, and each started run is followed on its own', async () => {
  await theorem(4000)
  const seen = await chat('thread-room', [
    ['ptc_a', 'Alpha'],
    ['ptc_b', 'Beta'],
  ])
  await waitFor(() => posted.length === 1)
  expect(posted[0]!.body).toEqual({
    branchId: 'branch-1',
    text: 'Compare the two designs.',
    expectedRosterRevision: 3,
    audience: { kind: 'everyone' },
  })
  await waitFor(
    () => lastReply(seen)?.metadata.custom.theoremPeerSend !== undefined,
  )
  // The turn's own reply is an empty marker for the room's two runs; nothing
  // is made up as a combined answer.
  expect(lastReply(seen)!.metadata.custom.theoremPeerSend).toEqual({
    messageId: 'user-1',
    runIds: ['run-a', 'run-b'],
  })
  expect(
    usePeerRuns
      .getState()
      .active['thread-room']!.map((run) => run.participantId),
  ).toEqual(['ptc_a', 'ptc_b'])
  expect(seen.text).toBe('')
})

test('a room on a Theorem with no shared limit gives the draft back and sends to no model', async () => {
  await theorem(undefined)
  const seen = await chat('thread-nocap', [
    ['ptc_a', 'Alpha'],
    ['ptc_b', 'Beta'],
  ])
  await waitFor(() => seen.text === 'Compare the two designs.')
  expect(posted).toHaveLength(0)
  expect(lastReply(seen)?.status?.type).toBe('incomplete')
  expect(JSON.stringify(lastReply(seen)?.status)).toContain('was not sent')
  expect(takeRefusedText('thread-nocap')).toBeUndefined()
})

test('a conversation of one agent sends as it always has', async () => {
  await theorem(4000)
  const seen = await chat('thread-solo', [['ptc_a', 'Alpha']])
  await waitFor(() => posted.length === 1)
  expect(posted[0]!.body).not.toHaveProperty('audience')
  expect(posted[0]!.body).not.toHaveProperty('expectedRosterRevision')
  // The lead's own model rides the single send, as before rooms.
  expect(posted[0]!.body.model).toEqual({ provider: 'p', model: 'alpha' })
  await waitFor(() => lastReply(seen)?.status?.type === 'complete')
  expect(usePeerRuns.getState().active['thread-solo']).toBeUndefined()
})
