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
import type { SideChatModel } from './side-chat-model'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

let root: Root | undefined
afterEach(() => {
  if (root) act(() => root?.unmount())
  root = undefined
})

const base = (requestId: string) => ({ workspaceId: 'w1', requestId })

/** A model whose turns wait until the signal aborts, and that records what it was sent. */
function model(sent: string[], aborted: { count: number }): SideChatModel {
  let threadId: string | undefined
  const adapter: ChatModelAdapter = {
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
  return {
    adapter,
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
  const side = createSideChats(async () => model(sideSent, aborted))
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
        sendInput: async () => ({ inputId: 'in-1' }),
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

test("a side chat's sends never reach the main thread, and closing it ends its run", async () => {
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
  expect(aborted.count).toBe(1)
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
