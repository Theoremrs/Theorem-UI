// SOURCING: bun:test over deterministic run fixtures rendered through the real Thread inside an external-store runtime that names a durable thread (as error-history.test renders it), the real SDK client answered in process by stories/fake-theorem; no Theorem is running
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from 'bun:test'
import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
} from '@assistant-ui/react'
import type { ThreadMessageLike } from '@assistant-ui/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from '@tanstack/react-router'
import { Thread } from '../assistant-ui/elements/thread.aui'
import { TheoremPartRenderers } from './theorem-parts'
import { cleanup, click, render, waitFor } from '../../../test/blocks/render'
import { installFakeTheorem } from '@/stories/fake-theorem'
import { bootstrap } from '@/lib/theorem/client'
import { noteThread, usePeerRuns } from '@/lib/theorem/peer-runs'
import { parseParticipant, useRoster } from '@/lib/theorem/roster'
import type { Theorem } from '@/lib/theorem/client'

const page = (
  window as unknown as { happyDOM: { setURL: (url: string) => void } }
).happyDOM
beforeAll(() => page.setURL('http://localhost:3000/'))
afterAll(() => page.setURL('about:blank'))

const THREAD = 'thread-1'
const queryClient = new QueryClient()
let restore: () => void = () => {}
let stopped: unknown[] = []
/** What the open conversation's transcript already holds. */
let transcript: ThreadMessageLike[] = []

beforeEach(() => {
  stopped = []
  transcript = []
  usePeerRuns.setState({ active: {}, runs: {}, problems: {} })
})
afterEach(async () => {
  await cleanup()
  restore()
  useRoster.setState({ byConversation: {}, current: undefined, reads: {} })
})

/** A thread with the durable id the peer runs are keyed by. */
function Chat() {
  const runtime = useExternalStoreRuntime({
    messages: transcript,
    isRunning: false,
    onNew: async () => {},
    convertMessage: (message: ThreadMessageLike) => message,
    adapters: {
      threadList: {
        threadId: THREAD,
        threads: [{ id: THREAD, remoteId: THREAD, status: 'regular' as const }],
        onSwitchToThread: () => {},
      },
    },
  })
  return (
    <QueryClientProvider client={queryClient}>
      <AssistantRuntimeProvider runtime={runtime}>
        <TheoremPartRenderers />
        <Thread autoFocus={false} />
      </AssistantRuntimeProvider>
    </QueryClientProvider>
  )
}

async function mount(
  routes: Record<string, (runId: string) => Theorem.RunEvent[]>,
) {
  restore = installFakeTheorem({
    'GET /api/chat/v1/bootstrap': () => ({ csrfToken: 'csrf', tenantId: 't' }),
    'GET /api/chat/v1/runs/:runId/events': ({ runId }) =>
      new Response(
        (routes[runId!]?.(runId!) ?? [])
          .map((item) => `data: ${JSON.stringify(item)}\n\n`)
          .join(''),
        { headers: { 'content-type': 'text/event-stream' } },
      ),
    'POST /api/chat/v1/threads/:threadId/participants/stop': async (
      { threadId },
      request,
    ) => {
      stopped.push({ threadId, body: await request.json() })
      return { stopped: { stoppedParticipantIds: [] }, cancellations: [] }
    },
    // The roster is read again after a stop.
    'GET /api/chat/v1/threads/:threadId': () => ({
      thread: {
        threadId: THREAD,
        rosterRevision: 2,
        participants: [],
        activeRuns: [],
      },
      messages: [],
    }),
  })
  await bootstrap(true)
  const router = createRouter({
    routeTree: createRootRoute({ component: Chat }),
    history: createMemoryHistory(),
  })
  return render(<RouterProvider router={router} />)
}

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
const said = (runId: string, seq: number, text: string) =>
  event(runId, seq, 'CHAT.MESSAGE.PART', {
    part: { partId: 'answer', type: 'text', text },
  })

const seat = (participantId: string, label: string) =>
  parseParticipant({
    participantId,
    model: { provider: 'p', model: label.toLowerCase() },
    label,
  })!

/** The room the composer's picker would have read, keyed as the thread's conversation. */
function seatRoom(conversation: string, labels: Array<[string, string]>) {
  useRoster.setState({
    byConversation: {
      [conversation]: {
        remoteId: THREAD,
        roster: {
          revision: 1,
          participants: labels.map(([id, label]) => seat(id, label)),
          activeRuns: [],
        },
        lead: undefined,
        unsaved: false,
        edits: 0,
        error: undefined,
      },
    },
  })
}

const section = (container: HTMLElement, runId: string) =>
  container.querySelector(
    `[data-slot="theorem-peer-run"][data-run-id="${runId}"]`,
  )

test('two participants show two replies, each under its own name, never merged', async () => {
  const { container } = await mount({
    'run-a': (id) => [
      said(id, 1, 'Alpha thinks the cache is stale.'),
      event(id, 2, 'RUN.CLOSED'),
    ],
    'run-b': (id) => [said(id, 1, 'Beta thinks the index is wrong.')],
  })
  seatRoom(THREAD, [
    ['ptc_a', 'Alpha'],
    ['ptc_b', 'Beta'],
  ])
  noteThread({
    threadId: THREAD,
    rosterRevision: 1,
    activeRuns: [
      { participantId: 'ptc_a', runId: 'run-a', cursor: 9 },
      { participantId: 'ptc_b', runId: 'run-b', cursor: 4 },
    ],
  })
  await waitFor(() =>
    section(container, 'run-a')?.textContent.includes('Alpha thinks'),
  )
  await waitFor(() =>
    section(container, 'run-b')?.textContent.includes('Beta thinks'),
  )

  const a = section(container, 'run-a')!
  const b = section(container, 'run-b')!
  expect(a.textContent).not.toContain('Beta thinks')
  expect(b.textContent).not.toContain('Alpha thinks')
  expect(a.getAttribute('data-participant-id')).toBe('ptc_a')
  expect(b.getAttribute('data-participant-id')).toBe('ptc_b')

  // Presence: A's run has closed, B's is still going, and neither ends the room.
  const state = (id: string) =>
    container
      .querySelector(`li[data-participant-id="${id}"]`)
      ?.getAttribute('data-state')
  await waitFor(() => state('ptc_a') === 'idle')
  expect(state('ptc_b')).toBe('working')

  // A finished run has no stop; the running participant stops by its own id.
  expect(container.querySelector('[aria-label="Stop Alpha"]')).toBeNull()
  await click(container.querySelector('[aria-label="Stop Beta"]')!)
  await waitFor(() => stopped.length > 0)
  // The participant is stopped by its own id, not by a run's.
  expect(stopped).toEqual([
    { threadId: THREAD, body: { participantId: 'ptc_b' } },
  ])
})

test('a conversation with one agent and no peer run draws nothing here', async () => {
  const { container } = await mount({})
  seatRoom(THREAD, [['ptc_a', 'Alpha']])
  noteThread({ threadId: THREAD, activeRunId: 'run-1', revision: 3 })
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(container.querySelector('[data-slot="theorem-peer-runs"]')).toBeNull()
})

test("a room's replies read from history keep their authors, and the send marker draws nothing", async () => {
  transcript = [
    {
      id: 'u1',
      role: 'user',
      content: [{ type: 'text', text: 'Compare the two designs.' }],
    },
    // The turn's own reply to a send to a room: nothing to show.
    {
      id: 'marker',
      role: 'assistant',
      content: [],
      status: { type: 'complete', reason: 'stop' },
      metadata: {
        custom: {
          theoremPeerSend: { messageId: 'u1', runIds: ['run-a', 'run-b'] },
        },
      },
    },
    {
      id: 'a1',
      role: 'assistant',
      content: [{ type: 'text', text: 'Alpha says the cache is stale.' }],
      status: { type: 'complete', reason: 'stop' },
      metadata: {
        custom: { theoremAuthor: { participantId: 'ptc_a', label: 'Alpha' } },
      },
    },
    {
      id: 'b1',
      role: 'assistant',
      content: [{ type: 'text', text: 'Beta says the index is wrong.' }],
      status: { type: 'complete', reason: 'stop' },
      metadata: {
        custom: { theoremAuthor: { participantId: 'ptc_b', label: 'Beta' } },
      },
    },
  ]
  const { container } = await mount({})
  await waitFor(() =>
    container.textContent.includes('Beta says the index is wrong.'),
  )
  const replies = [
    ...container.querySelectorAll('[data-slot="aui_assistant-message-root"]'),
  ]
  // Two replies, one per author, in the order stored; the marker is not a third.
  expect(replies).toHaveLength(2)
  expect(replies[0]!.textContent).toContain('Alpha says the cache is stale.')
  expect(replies[0]!.textContent).not.toContain('Beta')
  expect(replies[1]!.textContent).toContain('Beta says the index is wrong.')
  expect(replies[1]!.textContent).not.toContain('Alpha says')
})
