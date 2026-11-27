// SOURCING: bun:test over ./agent-row rendered into happy-dom (test/workspace's render, which supplies the QueryClient) against a fake WorkSource that records each assignment, with the run owner's snapshot and cancel routes answered by a stubbed fetch through the real SDK client
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  spyOn,
  test,
} from 'bun:test'
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import { TheoremError } from '@theoremharness/sdk'
import { act } from 'react'
import { cleanup, render, waitFor } from '../../../test/workspace'
import { AgentRow } from './agent-row'
import type {
  AgentAssignmentResult,
  AssignAgentInput,
  WorkItem,
} from './contract'
import { fakeSource, item } from './fixtures'
import { WorkSourceProvider } from './source'
import type { WorkSource } from './source'

const page = (
  window as unknown as { happyDOM: { setURL: (url: string) => void } }
).happyDOM
let runStatus = { status: 'running', terminal: false }
let chat: string[] = []
let fetchSpy: ReturnType<typeof spyOn>
beforeAll(() => {
  page.setURL('http://localhost:3000/')
  fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async (
    input,
    init,
  ) => {
    const request = new Request(input, init)
    const path = new URL(request.url).pathname
    if (path.endsWith('/bootstrap'))
      return Response.json({ csrfToken: 'csrf', tenantId: 't' })
    chat.push(`${request.method} ${path}`)
    if (path.endsWith('/cancel')) {
      runStatus = { status: 'cancelled', terminal: true }
      return Response.json({ runId: 'run-1', seq: 2 })
    }
    return Response.json({
      schema: 'theorem.run-snapshot/1',
      runId: 'run-1',
      threadId: 'thread-1',
      actor: null,
      events: [],
      nextAfterSeq: 0,
      hasMore: false,
      undeliveredMessages: [],
      ...runStatus,
    })
  }) as typeof fetch)
})
afterAll(() => {
  fetchSpy.mockRestore()
  page.setURL('about:blank')
})
beforeEach(() => {
  runStatus = { status: 'running', terminal: false }
  chat = []
})
afterEach(cleanup)

function source(
  answer: (input: AssignAgentInput) => Promise<AgentAssignmentResult>,
) {
  const asked: AssignAgentInput[] = []
  const fake: WorkSource = fakeSource({
    listAgents: async () => [
      { id: 'theorem', label: 'Theorem', available: true },
      {
        id: 'codex',
        label: 'Codex',
        available: false,
        unavailableReason: 'not installed',
      },
    ],
    assignAgent: async (_itemId, input) => {
      asked.push(input)
      return answer(input)
    },
  })
  return { fake, asked }
}

const started = (base: WorkItem): AgentAssignmentResult => ({
  assignment: {
    assignmentId: 'as-1',
    itemId: base.id,
    agentId: 'theorem',
    assignedBy: { id: 'local:me', name: 'Me' },
    assignedAt: '2026-11-27T00:00:00Z',
    runId: 'run-1',
    threadId: 'thread-1',
  },
  item: { ...base, runId: 'run-1', threadId: 'thread-1' },
})

/** The row at `/`, inside a router so its conversation link resolves. */
function mount(fake: WorkSource, base: WorkItem) {
  const root = createRootRoute({ component: Outlet })
  const here = createRoute({
    getParentRoute: () => root,
    path: '/',
    component: () => (
      <WorkSourceProvider source={fake}>
        <AgentRow item={base} />
      </WorkSourceProvider>
    ),
  })
  const thread = createRoute({
    getParentRoute: () => root,
    path: 'c/$threadId',
    component: () => null,
  })
  const router = createRouter({
    routeTree: root.addChildren([here, thread]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  return render(<RouterProvider router={router} />)
}

const button = (name: string) =>
  [...document.querySelectorAll('button')].find((b) => b.textContent === name)

async function chooseAgent(label: string) {
  await waitFor(
    () =>
      !button('Assign agent')?.disabled && !button('Assign again')?.disabled,
  )
  await act(async () =>
    (button('Assign agent') ?? button('Assign again'))!.click(),
  )
  await waitFor(() =>
    [...document.querySelectorAll('[role=option]')].some(
      (o) => o.textContent === label,
    ),
  )
  const option = [
    ...document.querySelectorAll<HTMLElement>('[role=option]'),
  ].find((o) => o.textContent === label)!
  await act(async () => option.click())
}

test('rendering an item starts nothing; choosing an agent assigns it once, and only an available one is offered', async () => {
  const base = item('1')
  const { fake, asked } = source(async () => started(base))
  await mount(fake, base)
  await waitFor(() => button('Assign agent') !== undefined)
  expect(asked).toEqual([])
  await chooseAgent('Theorem')
  await waitFor(() => asked.length === 1)
  expect(asked).toEqual([{ agentId: 'theorem' }])
  expect(
    [...document.querySelectorAll('[role=option]')].some(
      (o) => o.textContent === 'Codex',
    ),
  ).toBe(false)
})

test('an agent still working is stopped only when the person says so', async () => {
  const base = item('2', { runId: 'run-1', threadId: 'thread-1' })
  const { fake, asked } = source(async (input) => {
    if (input.replaceRunning) return started(base)
    throw new TheoremError({
      message: 'running',
      statusCode: 409,
      body: { code: 'work_agent_running', runId: 'run-1' },
    })
  })
  await mount(fake, base)
  await waitFor(() => document.body.textContent.includes('Working'))
  await chooseAgent('Theorem')
  await waitFor(() =>
    document.body.textContent.includes('An agent is still working on this.'),
  )
  // The refusal stopped nothing.
  expect(chat.some((c) => c.endsWith('/cancel'))).toBe(false)
  await act(async () => button('Stop it and assign')!.click())
  await waitFor(() => asked.length === 2)
  expect(asked[1]).toEqual({ agentId: 'theorem', replaceRunning: true })
})

test('Stop cancels the run; leaving the item does not', async () => {
  const base = item('3', { runId: 'run-1', threadId: 'thread-1' })
  const { fake } = source(async () => started(base))
  const view = await mount(fake, base)
  await waitFor(() => button('Stop') !== undefined)
  act(() => view.root.unmount())
  expect(chat.some((c) => c.endsWith('/cancel'))).toBe(false)

  await mount(fake, base)
  await waitFor(() => button('Stop') !== undefined)
  await act(async () => button('Stop')!.click())
  await waitFor(() => document.body.textContent.includes('Stopped'))
  expect(chat.filter((c) => c.endsWith('/cancel'))).toEqual([
    'POST /api/chat/v1/runs/run-1/cancel',
  ])
})
