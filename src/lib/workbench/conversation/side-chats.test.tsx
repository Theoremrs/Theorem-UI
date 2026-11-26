import { afterEach, expect, test } from 'bun:test'
import {
  AssistantRuntimeProvider,
  useAui,
  useLocalRuntime,
} from '@assistant-ui/react'
import type { ChatModelAdapter } from '@assistant-ui/react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { createConversation } from './conversation'
import type { Conversation } from './conversation'
import { conversationRuntimeOf } from './runtime'
import { createSideChats } from './side-chats'
import { detaching } from './side-chat-model'
import type { SideChatModel } from './side-chat-model'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

let root: Root | undefined
afterEach(() => {
  if (root) act(() => root?.unmount())
  root = undefined
  globalThis.sessionStorage?.clear()
})

const base = (requestId: string) => ({ workspaceId: 'w1', requestId })

/**
 * A model whose turns wait until the signal aborts (an abort stands for Theorem cancelling the
 * run), that records what it was sent, and that detaches the way the real one does.
 */
function model(
  sent: string[],
  aborted: { count: number },
  reopen?: string,
): SideChatModel {
  let threadId: string | undefined = reopen
  const detached = detaching()
  const turn: ChatModelAdapter = {
    async *run({ messages, abortSignal }) {
      threadId ??= 'durable-side'
      const last = messages.at(-1)?.content[0]
      sent.push(last?.type === 'text' ? last.text : '')
      yield { content: [{ type: 'text', text: 'working' }] }
      await new Promise<void>((resolve) =>
        abortSignal.addEventListener(
          'abort',
          () => {
            aborted.count += 1
            resolve()
          },
          { once: true },
        ),
      )
    },
  }
  const adapter: ChatModelAdapter = {
    async *run(options) {
      const abortSignal = detached.signal(options.abortSignal)
      const steps = turn.run({ ...options, abortSignal })
      if (Symbol.asyncIterator in steps) yield* detached.read(steps)
      else yield await steps
    },
  }
  return {
    adapter,
    detach: detached.detach,
    history: {
      load: async () => ({ messages: [] }),
      append: async () => undefined,
    },
    threadId: () => threadId,
  }
}

function mount(
  mainSent: string[],
  sideSent: string[],
  aborted: { count: number },
  historyAsked: string[] = [],
) {
  return mountWith(
    createSideChats(async () => model(sideSent, aborted)),
    mainSent,
    historyAsked,
  )
}

function mountWith(
  side: ReturnType<typeof createSideChats>,
  mainSent: string[] = [],
  historyAsked: string[] = [],
) {
  const mainAdapter: ChatModelAdapter = {
    async *run({ messages }) {
      const last = messages.at(-1)?.content[0]
      mainSent.push(last?.type === 'text' ? last.text : '')
      yield { content: [{ type: 'text', text: 'ok' }] }
    },
  }
  let conversation: Conversation | undefined
  function Main() {
    const runtime = useLocalRuntime(mainAdapter)
    return (
      <AssistantRuntimeProvider runtime={runtime}>
        <Owner />
        <side.Hosts />
      </AssistantRuntimeProvider>
    )
  }
  function Owner() {
    const aui = useAui()
    conversation ??= createConversation({
      runtime: conversationRuntimeOf(aui),
      sideChats: side.sideChats,
      services: {
        answerApproval: async () => undefined,
        sendInput: async ({ text }) => ({
          inputId: 'in-1',
          text,
          status: 'queued',
        }),
        history: async (threadId) => {
          historyAsked.push(threadId)
          return null
        },
      },
      workspaceId: 'w1',
    })
    return null
  }
  const container = document.createElement('div')
  root = createRoot(container)
  act(() => root?.render(<Main />))
  if (!conversation) throw new Error('not mounted')
  return { conversation, side }
}

test("a side chat's sends never reach the main thread, and closing it leaves its run working", async () => {
  const mainSent: string[] = []
  const sideSent: string[] = []
  const aborted = { count: 0 }
  const { conversation } = mount(mainSent, sideSent, aborted)

  let opened: Awaited<ReturnType<Conversation['sideChat']>> | undefined
  await act(async () => {
    opened = await conversation.sideChat(base('r1'))
  })
  if (opened?.outcome !== 'accepted') throw new Error(String(opened?.outcome))
  const chat = opened.value
  expect(chat.conversationId).toMatch(/^side-/)
  expect(chat.conversationId).not.toBe(conversation.snapshot().conversationId)

  await act(async () => {
    await chat.conversation.send({
      ...base('r2'),
      clientMessageId: 'c1',
      text: 'aside',
    })
  })
  expect(sideSent).toEqual(['aside'])
  expect(mainSent).toEqual([])
  expect(chat.conversation.snapshot().conversationId).toBe('durable-side')

  await act(async () => {
    await conversation.send({
      ...base('r3'),
      clientMessageId: 'c2',
      text: 'main',
    })
  })
  expect(mainSent).toEqual(['main'])
  expect(sideSent).toEqual(['aside'])

  await act(async () => chat.close())
  expect(aborted.count).toBe(0)
  // The closed side chat stays listed to reopen, on its own stored thread.
  expect(conversation.sideChats()).toEqual([
    {
      conversationId: chat.conversationId,
      scope: 'fresh',
      threadId: 'durable-side',
      detached: true,
    },
  ])
})

test("only a stop asked of the side chat's own conversation cancels its run", async () => {
  const aborted = { count: 0 }
  const { conversation } = mount([], [], aborted)
  let opened: Awaited<ReturnType<Conversation['sideChat']>> | undefined
  await act(async () => {
    opened = await conversation.sideChat(base('r1'))
  })
  if (opened?.outcome !== 'accepted') throw new Error(String(opened?.outcome))
  const chat = opened.value
  await act(async () => {
    await chat.conversation.send({
      ...base('r2'),
      clientMessageId: 'c1',
      text: 'aside',
    })
  })
  let stopped: Awaited<ReturnType<Conversation['stop']>> | undefined
  await act(async () => {
    stopped = await chat.conversation.stop(base('r3'))
  })
  expect(stopped?.outcome).toBe('accepted')
  expect(aborted.count).toBe(1)
  await act(async () => chat.close())
})

test('a closed side chat reopens on its own thread, and never as the main one', async () => {
  const sideSent: string[] = []
  const reopened: (string | undefined)[] = []
  const aborted = { count: 0 }
  const side = createSideChats(async (request) => {
    reopened.push(request.reopen)
    return model(sideSent, aborted, request.reopen)
  })
  const { conversation } = mountWith(side)
  let opened: Awaited<ReturnType<Conversation['sideChat']>> | undefined
  await act(async () => {
    opened = await conversation.sideChat(base('r1'))
  })
  if (opened?.outcome !== 'accepted') throw new Error(String(opened?.outcome))
  const first = opened.value
  await act(async () => {
    await first.conversation.send({
      ...base('r2'),
      clientMessageId: 'c1',
      text: 'aside',
    })
  })
  await act(async () => first.close())

  let again: Awaited<ReturnType<Conversation['sideChat']>> | undefined
  await act(async () => {
    again = await conversation.sideChat({ ...base('r3'), reopen: 'durable-side' })
  })
  expect(again?.outcome).toBe('accepted')
  expect(reopened).toEqual([undefined, 'durable-side'])
  // Open again, so it is listed once and not as closed.
  expect(conversation.sideChats().filter((c) => c.detached)).toEqual([])
  expect(
    await conversation.sideChat({ ...base('r4'), reopen: 'durable-side' }),
  ).toMatchObject({ outcome: 'refused', code: 'conflict' })
  expect(aborted.count).toBe(0)
  const shown = again
  if (shown?.outcome === 'accepted') await act(async () => shown.value.close())
})

test('a side chat with no durable thread yet asks for no history, then asks for its own', async () => {
  const historyAsked: string[] = []
  const { conversation } = mount([], [], { count: 0 }, historyAsked)
  let opened: Awaited<ReturnType<Conversation['sideChat']>> | undefined
  await act(async () => {
    opened = await conversation.sideChat(base('r1'))
  })
  if (opened?.outcome !== 'accepted') throw new Error(String(opened?.outcome))
  const chat = opened.value
  chat.conversation.snapshot()
  expect(historyAsked.filter((id) => id.startsWith('side-'))).toEqual([])

  await act(async () => {
    await chat.conversation.send({
      ...base('r2'),
      clientMessageId: 'c1',
      text: 'aside',
    })
  })
  chat.conversation.snapshot()
  expect(historyAsked).toContain('durable-side')
  expect(historyAsked.filter((id) => id.startsWith('side-'))).toEqual([])
  await act(async () => chat.close())
})

test('with no host mounted a side chat fails instead of waiting', async () => {
  const side = createSideChats(async () => model([], { count: 0 }))
  await expect(side.sideChats.open({ scope: 'fresh' })).rejects.toThrow(
    'No side chat host',
  )
})
