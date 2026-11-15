// SOURCING: none — bun:test over ./conversation with a stub runtime shaped like assistant-ui's AssistantRuntime (thread and threads), no network

import { describe, expect, test } from 'bun:test'
import type { CreateAppendMessage, ThreadMessage } from '@assistant-ui/react'
import { createConversation, snapshotMessage } from './conversation'
import type {
  ConversationRuntime,
  ConversationServices,
  ConversationSnapshot,
} from './conversation'

function assistant(
  id: string,
  text: string,
  extra: Partial<{
    status: unknown
    parts: unknown[]
    runId: string
  }> = {},
): ThreadMessage {
  return {
    id,
    role: 'assistant',
    createdAt: new Date(0),
    content: [{ type: 'text', text }, ...(extra.parts ?? [])],
    status: extra.status ?? { type: 'running' },
    metadata: {
      unstable_state: null,
      unstable_annotations: [],
      unstable_data: [],
      steps: [],
      custom: extra.runId ? { theoremRunId: extra.runId } : {},
    },
  } as unknown as ThreadMessage
}

function approvalPart() {
  return {
    type: 'tool-call',
    toolCallId: 'tc1',
    toolName: 'shell',
    args: {},
    argsText: '{}',
    artifact: {
      theoremApproval: {
        approvalId: 'ap1',
        toolCallId: 'tc1',
        toolName: 'shell',
        status: 'requires_action',
        options: [
          { optionId: 'yes', kind: 'allow_once', name: 'Allow' },
          { optionId: 'no', kind: 'reject_once', name: 'Deny' },
        ],
      },
    },
  }
}

class StubRuntime {
  messages: ThreadMessage[] = []
  isRunning = false
  threadId = 'thread-1'
  remoteId: string | undefined = 'remote-1'
  appends: unknown[] = []
  cancels = 0
  starts: unknown[] = []
  /** Set to make append throw, or to drop the message instead of showing it. */
  appendThrows: unknown
  dropAppends = false
  edit = true
  private threadListeners = new Set<() => void>()
  private threadsListeners = new Set<() => void>()

  emit() {
    for (const l of [...this.threadListeners]) l()
  }
  emitThreads() {
    for (const l of [...this.threadsListeners]) l()
  }
  listenerCount() {
    return this.threadListeners.size + this.threadsListeners.size
  }

  runtime: ConversationRuntime = {
    thread: {
      getState: () => ({
        messages: this.messages,
        isRunning: this.isRunning,
        isLoading: false,
        isDisabled: false,
        capabilities: { edit: this.edit, reload: true },
      }),
      subscribe: (l) => {
        this.threadListeners.add(l)
        return () => this.threadListeners.delete(l)
      },
      append: (message: CreateAppendMessage) => {
        this.appends.push(message)
        if (this.appendThrows) throw this.appendThrows
        if (this.dropAppends || typeof message === 'string') return
        this.messages.push({
          id: `u${this.appends.length}`,
          role: 'user',
          createdAt: new Date(0),
          content: message.content,
          attachments: message.attachments ?? [],
          metadata: message.metadata ?? { custom: {} },
        } as unknown as ThreadMessage)
        this.emit()
      },
      startRun: (config) => {
        this.starts.push(config)
      },
      cancelRun: () => {
        this.cancels += 1
      },
    },
    threads: {
      getState: () => ({ mainThreadId: this.threadId }),
      subscribe: (l) => {
        this.threadsListeners.add(l)
        return () => this.threadsListeners.delete(l)
      },
      mainItem: { getState: () => ({ remoteId: this.remoteId }) },
      switchToThread: async (id) => {
        this.threadId = id
        this.remoteId = undefined
        this.messages = []
        this.emitThreads()
      },
      switchToNewThread: async () => {
        this.threadId = 'new'
        this.remoteId = undefined
        this.messages = []
        this.emitThreads()
      },
    },
  }
}

function setup() {
  const stub = new StubRuntime()
  const answers: unknown[] = []
  const inputs: unknown[] = []
  const services: ConversationServices = {
    answerApproval: async (r) => {
      answers.push(r)
    },
    sendInput: async (r) => {
      inputs.push(r)
    },
  }
  let frame: (() => void) | undefined
  let cancelled = 0
  const conversation = createConversation({
    runtime: stub.runtime,
    services,
    workspaceId: 'w1',
    schedule: (cb) => {
      frame = cb
      return () => {
        frame = undefined
        cancelled += 1
      }
    },
  })
  return {
    stub,
    answers,
    inputs,
    conversation,
    runFrame: () => {
      const cb = frame
      frame = undefined
      cb?.()
    },
    framePending: () => frame !== undefined,
    cancelled: () => cancelled,
  }
}

const base = (requestId: string) => ({ requestId })

describe('snapshots and revisions', () => {
  test('the revision goes up only when the content changes, and across a switch', async () => {
    const { stub, conversation } = setup()
    const first = conversation.snapshot()
    expect(conversation.snapshot().revision).toBe(first.revision)
    expect(first.conversationId).toBe('remote-1')

    stub.messages.push(
      assistant('a1', 'hello', {
        status: { type: 'complete', reason: 'stop' },
      }),
    )
    const second = conversation.snapshot()
    expect(second.revision).toBeGreaterThan(first.revision)
    expect(second.messages[0]).toMatchObject({ id: 'a1', role: 'assistant' })

    const switched = await conversation.switchTo({
      ...base('s'),
      threadId: 'other',
    })
    expect(switched.outcome).toBe('accepted')
    const third = conversation.snapshot()
    expect(third.conversationId).toBe('other')
    expect(third.revision).toBeGreaterThan(second.revision)
  })

  test('an action drawn against another conversation is refused as stale', async () => {
    const { conversation } = setup()
    const result = await conversation.stop({
      ...base('r'),
      conversationId: 'not-open',
    })
    expect(result).toMatchObject({
      outcome: 'refused',
      code: 'stale_conversation',
    })
  })

  test('the host message carries the revision and the thread', () => {
    const { conversation } = setup()
    const message = snapshotMessage('p1', conversation.snapshot())
    expect(message.resource).toEqual({
      type: 'conversation',
      project: 'p1',
      thread: 'remote-1',
    })
    expect(message.revision).toEqual({
      scheme: 'seq',
      value: conversation.snapshot().revision,
    })
    expect(JSON.parse(message.snapshot).conversationId).toBe('remote-1')
  })
})

describe('streaming', () => {
  test('many updates in a frame deliver once, and the end delivers the final state at once', () => {
    const { stub, conversation, runFrame, framePending } = setup()
    const seen: ConversationSnapshot[] = []
    conversation.subscribe((s) => seen.push(s))
    conversation.snapshot()

    stub.isRunning = true
    stub.messages = [assistant('a1', 'h')]
    stub.emit() // run starts: delivered at once
    const afterStart = seen.length
    expect(afterStart).toBe(1)

    for (const text of ['he', 'hel', 'hell', 'hello']) {
      stub.messages = [assistant('a1', text)]
      stub.emit()
    }
    expect(seen.length).toBe(afterStart)
    expect(framePending()).toBe(true)
    runFrame()
    expect(seen.length).toBe(afterStart + 1)
    expect(seen.at(-1)!.messages[0]?.parts[0]).toMatchObject({ text: 'hello' })
    expect(seen.at(-1)!.run.state).toBe('streaming')

    stub.messages = [
      assistant('a1', 'hello world', {
        status: { type: 'complete', reason: 'stop' },
      }),
    ]
    stub.isRunning = false
    stub.emit()
    expect(seen.at(-1)!.run.state).toBe('idle')
    expect(seen.at(-1)!.messages[0]?.parts[0]).toMatchObject({
      text: 'hello world',
    })
    const revisions = seen.map((s) => s.revision)
    expect(revisions).toEqual([...revisions].sort((a, b) => a - b))
  })

  test('a change after the last delivery is still delivered at the next frame', () => {
    const { stub, conversation, runFrame } = setup()
    const seen: ConversationSnapshot[] = []
    conversation.subscribe((s) => seen.push(s))
    stub.isRunning = true
    stub.messages = [assistant('a1', 'x')]
    stub.emit()
    stub.messages = [assistant('a1', 'xy')]
    stub.emit()
    runFrame()
    expect(seen.at(-1)!.messages[0]?.parts[0]).toMatchObject({ text: 'xy' })
  })

  test('run states: failed, stopped and waiting for approval', () => {
    const { stub, conversation } = setup()
    stub.messages = [
      assistant('a1', 'x', {
        status: {
          type: 'incomplete',
          reason: 'error',
          error: new Error('boom'),
        },
      }),
    ]
    expect(conversation.snapshot().run.state).toBe('failed')
    stub.messages = [
      assistant('a1', 'x', {
        status: { type: 'incomplete', reason: 'cancelled' },
      }),
    ]
    expect(conversation.snapshot().run.state).toBe('stopped')
    stub.isRunning = true
    stub.messages = [
      assistant('a1', 'x', { parts: [approvalPart()], runId: 'run1' }),
    ]
    const snapshot = conversation.snapshot()
    expect(snapshot.run.state).toBe('waiting_approval')
    expect(snapshot.approval).toMatchObject({
      approvalId: 'ap1',
      runId: 'run1',
    })
  })
})

describe('send', () => {
  test('the same client message id sends once', async () => {
    const { stub, conversation } = setup()
    const request = { ...base('r1'), clientMessageId: 'c1', text: 'hi' }
    const first = await conversation.send(request)
    const again = await conversation.send({ ...request, requestId: 'r2' })
    expect(first.outcome).toBe('accepted')
    expect(again).toMatchObject({ outcome: 'accepted', requestId: 'r2' })
    expect(stub.appends.length).toBe(1)
  })

  test('a send the thread did not show is uncertain and is not resent', async () => {
    const { stub, conversation } = setup()
    stub.dropAppends = true
    const request = { ...base('r1'), clientMessageId: 'c1', text: 'hi' }
    expect((await conversation.send(request)).outcome).toBe('uncertain')
    expect(
      (await conversation.send({ ...request, requestId: 'r2' })).outcome,
    ).toBe('uncertain')
    expect(stub.appends.length).toBe(1)
  })

  test('a connection error is uncertain, and a 4xx is refused and may be sent again', async () => {
    const { stub, conversation } = setup()
    stub.appendThrows = new Error('socket closed')
    const lost = { ...base('r1'), clientMessageId: 'c1', text: 'hi' }
    expect((await conversation.send(lost)).outcome).toBe('uncertain')
    await conversation.send(lost)
    expect(stub.appends.length).toBe(1)

    stub.appendThrows = Object.assign(new Error('no'), { statusCode: 422 })
    const denied = { ...base('r2'), clientMessageId: 'c2', text: 'hi' }
    expect((await conversation.send(denied)).outcome).toBe('refused')
  })

  test('a send while a run works is refused, and input joins the run instead', async () => {
    const { stub, conversation, inputs } = setup()
    stub.isRunning = true
    stub.messages = [assistant('a1', 'x', { runId: 'run1' })]
    const turn = await conversation.send({
      ...base('r1'),
      clientMessageId: 'c1',
      text: 'hi',
    })
    expect(turn).toMatchObject({ outcome: 'refused', code: 'run_active' })
    const input = await conversation.input({
      ...base('r2'),
      clientMessageId: 'c2',
      text: 'also',
    })
    expect(input.outcome).toBe('accepted')
    expect(inputs).toEqual([{ runId: 'run1', inputId: 'c2', text: 'also' }])
    expect(conversation.snapshot().queued).toEqual([
      { clientMessageId: 'c2', text: 'also', state: 'queued' },
    ])
    await conversation.input({
      ...base('r3'),
      clientMessageId: 'c2',
      text: 'also',
    })
    expect(inputs.length).toBe(1)
  })

  test('side chat is refused as a missing capability', () => {
    const { conversation } = setup()
    expect(conversation.sideChat(base('r'))).toMatchObject({
      outcome: 'refused',
      code: 'missing_capability',
    })
  })
})

describe('stop, retry and edit', () => {
  test('stop cancels a working run and refuses when none works', async () => {
    const { stub, conversation } = setup()
    expect((await conversation.stop(base('r1'))).outcome).toBe('refused')
    stub.isRunning = true
    expect((await conversation.stop(base('r2'))).outcome).toBe('accepted')
    expect(stub.cancels).toBe(1)
  })

  test('retry runs the reply again from the user message before it', async () => {
    const { stub, conversation } = setup()
    await conversation.send({ ...base('r'), clientMessageId: 'c1', text: 'hi' })
    stub.messages.push(
      assistant('a1', 'x', { status: { type: 'complete', reason: 'stop' } }),
    )
    const result = await conversation.retry({ ...base('r2'), messageId: 'a1' })
    expect(result.outcome).toBe('accepted')
    expect(stub.starts).toEqual([{ parentId: 'u1' }])
  })

  test('edit appends on the message before it, and is refused when the runtime cannot', async () => {
    const { stub, conversation } = setup()
    await conversation.send({ ...base('r'), clientMessageId: 'c1', text: 'hi' })
    const edit = {
      ...base('r2'),
      messageId: 'u1',
      clientMessageId: 'c2',
      text: 'hey',
    }
    expect((await conversation.edit(edit)).outcome).toBe('accepted')
    expect(stub.appends.at(-1)).toMatchObject({
      parentId: null,
      sourceId: 'u1',
    })
    stub.edit = false
    expect(
      await conversation.edit({ ...edit, clientMessageId: 'c3' }),
    ).toMatchObject({ outcome: 'refused', code: 'missing_capability' })
  })
})

describe('approvals', () => {
  function waiting() {
    const s = setup()
    s.stub.isRunning = true
    s.stub.messages = [
      assistant('a1', 'x', { parts: [approvalPart()], runId: 'run1' }),
    ]
    return s
  }

  test('an approval is answered once', async () => {
    const { conversation, answers } = waiting()
    const request = {
      ...base('r1'),
      approvalId: 'ap1',
      decision: 'allow' as const,
      actor: { type: 'human' as const },
    }
    expect((await conversation.approve(request)).outcome).toBe('accepted')
    expect(
      await conversation.approve({
        ...request,
        requestId: 'r2',
        decision: 'deny',
      }),
    ).toMatchObject({
      outcome: 'refused',
      code: 'already_answered',
    })
    expect(answers).toEqual([
      {
        runId: 'run1',
        approvalId: 'ap1',
        toolCallId: 'tc1',
        choice: { optionId: 'yes' },
      },
    ])
  })

  test('a model cannot answer, and only the pending approval can be answered', async () => {
    const { conversation, answers } = waiting()
    const agent = await conversation.approve({
      ...base('r1'),
      approvalId: 'ap1',
      decision: 'allow',
      actor: { type: 'agent', runId: 'run1' },
    })
    expect(agent).toMatchObject({ outcome: 'refused', code: 'human_only' })
    const other = await conversation.approve({
      ...base('r2'),
      approvalId: 'zzz',
      decision: 'allow',
      actor: { type: 'human' },
    })
    expect(other).toMatchObject({
      outcome: 'refused',
      code: 'approval_not_pending',
    })
    expect(answers.length).toBe(0)
  })

  test('an answer whose result is unknown stands and is not sent again', async () => {
    const s = waiting()
    const calls: number[] = []
    const conversation = createConversation({
      runtime: s.stub.runtime,
      workspaceId: 'w1',
      services: {
        answerApproval: async () => {
          calls.push(1)
          throw new Error('socket closed')
        },
        sendInput: async () => {},
      },
    })
    const request = {
      ...base('r1'),
      approvalId: 'ap1',
      decision: 'allow' as const,
      actor: { type: 'human' as const },
    }
    expect((await conversation.approve(request)).outcome).toBe('uncertain')
    expect(
      (await conversation.approve({ ...request, requestId: 'r2' })).outcome,
    ).toBe('refused')
    expect(calls.length).toBe(1)
    conversation.dispose()
  })
})

describe('dispose', () => {
  test('stops all delivery, drops the runtime subscriptions and refuses actions', async () => {
    const { stub, conversation, runFrame, framePending, cancelled } = setup()
    const seen: ConversationSnapshot[] = []
    conversation.subscribe((s) => seen.push(s))
    expect(stub.listenerCount()).toBe(2)
    stub.isRunning = true
    stub.messages = [assistant('a1', 'x')]
    stub.emit()
    stub.messages = [assistant('a1', 'xy')]
    stub.emit()
    expect(framePending()).toBe(true)
    const before = seen.length
    conversation.dispose()
    expect(cancelled()).toBe(1)
    expect(stub.listenerCount()).toBe(0)
    runFrame()
    stub.emit()
    expect(seen.length).toBe(before)
    expect(
      await conversation.send({
        ...base('r'),
        clientMessageId: 'c',
        text: 'hi',
      }),
    ).toMatchObject({ outcome: 'refused', code: 'disposed' })
  })
})
