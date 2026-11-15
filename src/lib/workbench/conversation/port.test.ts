// SOURCING: none — bun:test over ./port, with the real conversation owner over the stub runtime
import { describe, expect, test } from 'bun:test'
import type { Effect, HostMessage, ResourceRef } from '../wire'
import { createConversation } from './conversation'
import { createConversationPort } from './port'
import { StubRuntime, approvalPart, assistant } from './test-runtime'

const thread = (id: string): ResourceRef => ({
  type: 'conversation',
  project: 'p1',
  thread: id,
})

function setup() {
  const stub = new StubRuntime()
  const answers: unknown[] = []
  const inputs: unknown[] = []
  let frame: (() => void) | undefined
  const conversation = createConversation({
    runtime: stub.runtime,
    services: {
      answerApproval: async (request) => void answers.push(request),
      sendInput: async (request) => void inputs.push(request),
    },
    workspaceId: 'w1',
    schedule: (callback) => {
      frame = callback
      return () => void (frame = undefined)
    },
  })
  const port = createConversationPort({ conversation, project: 'p1' })
  let id = 0
  const perform = (
    kind: Effect['kind'],
    payload?: unknown,
    resource: ResourceRef = thread('remote-1'),
  ) =>
    port.perform(
      {
        id: (id += 1),
        resource,
        kind,
        ...(payload === undefined ? {} : { payload }),
      } as never,
      `req-${id}`,
    )
  return {
    stub,
    answers,
    inputs,
    port,
    perform,
    runFrame: () => frame?.(),
  }
}

describe('send', () => {
  test('answers conversationSent with the client message id, and the runtime message keeps it', async () => {
    const { perform, stub } = setup()
    const done = await perform('conversationSend', {
      clientMessageId: 'c1',
      text: 'hello',
      attachments: [],
    })
    expect(done).toEqual({
      outcome: 'accepted',
      value: {
        type: 'conversationSent',
        clientMessageId: 'c1',
        messageId: 'u1',
      },
    })
    expect(stub.appends).toHaveLength(1)
    expect(stub.appends[0]).toMatchObject({
      role: 'user',
      content: [{ type: 'text', text: 'hello' }],
      metadata: { custom: { clientMessageId: 'c1' } },
    })
  })

  test('an attachment reference becomes a complete attachment', async () => {
    const { perform, stub } = setup()
    await perform('conversationSend', {
      clientMessageId: 'c1',
      text: 'see',
      attachments: [
        { id: 'u1', name: 'a.png', contentType: 'image/png' },
        { id: 'u2', name: 'notes.txt' },
      ],
    })
    expect(stub.appends[0]).toMatchObject({
      attachments: [
        {
          id: 'u1',
          type: 'image',
          name: 'a.png',
          contentType: 'image/png',
          status: { type: 'complete' },
        },
        { id: 'u2', type: 'document', name: 'notes.txt' },
      ],
    })
  })

  test('the same client message id never sends twice', async () => {
    const { perform, stub } = setup()
    const payload = { clientMessageId: 'c1', text: 'hi', attachments: [] }
    await perform('conversationSend', payload)
    await perform('conversationSend', payload)
    expect(stub.appends).toHaveLength(1)
  })

  test('an effect drawn against another thread is refused as stale', async () => {
    const { perform, stub } = setup()
    expect(
      await perform(
        'conversationSend',
        { clientMessageId: 'c1', text: 'hi', attachments: [] },
        thread('old-thread'),
      ),
    ).toMatchObject({ outcome: 'refused', code: 'stale_conversation' })
    expect(stub.appends).toEqual([])
  })
})

describe('a run that works', () => {
  function working() {
    const s = setup()
    s.stub.isRunning = true
    s.stub.messages = [
      assistant('a1', 'x', { parts: [approvalPart()], runId: 'run1' }),
    ]
    return s
  }

  test('input goes to the run it names', async () => {
    const { perform, inputs } = working()
    expect(
      await perform('conversationInput', {
        runId: 'run1',
        clientMessageId: 'c1',
        text: 'also',
      }),
    ).toMatchObject({
      outcome: 'accepted',
      value: { type: 'conversationSent', clientMessageId: 'c1' },
    })
    expect(inputs).toMatchObject([{ runId: 'run1', text: 'also' }])
    expect(
      await perform('conversationInput', {
        runId: 'old',
        clientMessageId: 'c2',
        text: 'late',
      }),
    ).toMatchObject({ outcome: 'refused', code: 'stale_run' })
  })

  test('cancel names the run it stopped; another run is stale', async () => {
    const { perform, stub } = working()
    expect(await perform('conversationCancel', { runId: 'old' })).toMatchObject(
      { outcome: 'refused', code: 'stale_run' },
    )
    expect(await perform('conversationCancel', { runId: 'run1' })).toEqual({
      outcome: 'accepted',
      value: { type: 'conversationStopped', runId: 'run1' },
    })
    expect(await perform('conversationCancel', {})).toMatchObject({
      outcome: 'accepted',
      value: { type: 'conversationStopped', runId: 'run1' },
    })
    expect(stub.cancels).toBe(2)
  })

  test('an approval is a human decision on the run that asked', async () => {
    const { perform, answers } = working()
    expect(
      await perform('conversationApproval', {
        runId: 'old',
        approvalId: 'ap1',
        decision: 'allow',
      }),
    ).toMatchObject({ outcome: 'refused', code: 'stale_run' })
    expect(
      await perform('conversationApproval', {
        runId: 'run1',
        approvalId: 'ap1',
        decision: 'allow',
      }),
    ).toEqual({
      outcome: 'accepted',
      value: { type: 'conversationApproved', approvalId: 'ap1' },
    })
    expect(answers).toMatchObject([
      { runId: 'run1', approvalId: 'ap1', choice: { optionId: 'yes' } },
    ])
  })
})

describe('retry, edit, create and switch', () => {
  test('retry and edit address a message by id', async () => {
    const { perform, stub } = setup()
    await perform('conversationSend', {
      clientMessageId: 'c1',
      text: 'hi',
      attachments: [],
    })
    stub.messages.push(
      assistant('a1', 'x', { status: { type: 'complete', reason: 'stop' } }),
    )
    expect(await perform('conversationRetry', { messageId: 'a1' })).toEqual({
      outcome: 'accepted',
      // the owner answers with the user message whose reply runs again
      value: { type: 'conversationRetried', messageId: 'u1' },
    })
    expect(stub.starts).toEqual([{ parentId: 'u1' }])
    expect(
      await perform('conversationEdit', {
        messageId: 'u1',
        clientMessageId: 'c2',
        text: 'hey',
      }),
    ).toMatchObject({
      outcome: 'accepted',
      value: { type: 'conversationSent', clientMessageId: 'c2' },
    })
  })

  test('create and switch answer conversationOpened with the id the runtime now has', async () => {
    const { perform, stub } = setup()
    expect(
      await perform('conversationSwitch', { threadId: 't2' }, { type: 'none' }),
    ).toMatchObject({
      outcome: 'accepted',
      value: { type: 'conversationOpened', conversationId: 't2' },
    })
    expect(stub.threadId).toBe('t2')
    expect(
      await perform('conversationCreate', undefined, { type: 'none' }),
    ).toMatchObject({
      outcome: 'accepted',
      value: { type: 'conversationOpened', conversationId: 'new' },
    })
  })
})

describe('snapshots', () => {
  test('a subscriber is given the current snapshot, then each change, named by project and thread', async () => {
    const { port, stub, perform, runFrame } = setup()
    const heard: HostMessage[] = []
    port.subscribe?.((message) => heard.push(message))
    expect(heard).toHaveLength(1)
    expect(heard[0]).toMatchObject({
      type: 'conversationSnapshot',
      resource: thread('remote-1'),
      conversationId: 'remote-1',
      revision: { scheme: 'seq' },
    })
    await perform('conversationSend', {
      clientMessageId: 'c1',
      text: 'hi',
      attachments: [],
    })
    stub.emit()
    runFrame()
    const last = heard.at(-1)
    expect(last).toMatchObject({ type: 'conversationSnapshot' })
    if (last?.type !== 'conversationSnapshot') return
    expect(JSON.parse(last.snapshot).conversationId).toBe('remote-1')
  })
})
