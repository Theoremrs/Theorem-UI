// SOURCING: none — bun:test over ./conversation with a stub runtime shaped like assistant-ui's AssistantRuntime (thread and threads), no network

import { describe, expect, test } from 'bun:test'
import { TheoremError } from '@theoremharness/sdk'
import { createConversation, snapshotMessage } from './conversation'
import { StubRuntime, approvalPart, assistant } from './test-runtime'
import type { ConversationServices, ConversationSnapshot } from './conversation'

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

describe('tool diff and open', () => {
  test('an edit tool part carries its result as a diff and the file and line it touched', () => {
    const { stub, conversation } = setup()
    const patch =
      '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,2 @@\n keep\n-old\n+new\n'
    stub.messages.push(
      assistant('a1', 'done', {
        status: { type: 'complete', reason: 'stop' },
        parts: [
          {
            type: 'tool-call',
            toolCallId: 'c1',
            toolName: 'edit',
            args: { path: 'src/a.ts' },
            argsText: '{"path":"src/a.ts"}',
            result: patch,
          },
          {
            type: 'tool-call',
            toolCallId: 'c2',
            toolName: 'read',
            args: { path: 'src/b.ts', start_line: 3, end_line: 9 },
            argsText: '{}',
            result: 'plain text',
          },
        ],
      }),
    )
    const tools = conversation
      .snapshot()
      .messages[0]!.parts.filter((part) => part.type === 'tool')
    expect(tools[0]).toMatchObject({
      id: 'c1',
      open: { path: 'src/a.ts', start: 1 },
    })
    const diff = (tools[0] as { diff?: { k: string }[] }).diff!
    expect(diff.map((line) => line.k)).toEqual(['hunk', 'ctx', 'del', 'add'])
    expect(tools[1]).toMatchObject({
      open: { path: 'src/b.ts', start: 3, end: 9 },
    })
    expect(tools[1]).not.toHaveProperty('diff')
  })
})

describe('delegations', () => {
  const part = (over: Record<string, unknown>) => ({
    type: 'data',
    name: 'theorem-delegation',
    data: {
      delegationId: 'd1',
      parentRunId: 'run-1',
      childRunId: 'run-2',
      roleLabel: 'Reviewer',
      objective: 'Check the shortcuts (documentId note:8183abcdef012345)',
      state: 'started',
      intent: {},
      ...over,
    },
  })

  test('a delegation part becomes a row with the run it was made in, its label and its state', () => {
    const { stub, conversation } = setup()
    stub.messages.push(
      assistant('a1', 'on it', {
        runId: 'run-1',
        parts: [
          part({}),
          part({ delegationId: 'd2', state: 'reviewed', verdict: 'accept' }),
        ],
      }),
    )
    const rows = conversation
      .snapshot()
      .messages[0]!.parts.filter((p) => p.type === 'delegation')
    expect(rows).toEqual([
      {
        type: 'delegation',
        delegationId: 'd1',
        runId: 'run-1',
        label: 'Reviewer',
        objective: 'Check the shortcuts',
        state: 'started',
      },
      {
        type: 'delegation',
        delegationId: 'd2',
        runId: 'run-1',
        label: 'Reviewer',
        objective: 'Check the shortcuts',
        state: 'reviewed',
        verdict: 'accept',
      },
    ])
  })

  test('a part that is not a delegation record is left out, and a run with none carries none', () => {
    const { stub, conversation } = setup()
    stub.messages.push(
      assistant('a1', 'no delegations here', {
        parts: [part({ delegationId: '' }), part({ intent: undefined })],
      }),
    )
    expect(
      conversation
        .snapshot()
        .messages[0]!.parts.some((p) => p.type === 'delegation'),
    ).toBe(false)
  })
})

describe('history', () => {
  test('the snapshot carries the thread tree once Theorem answers, and not before', async () => {
    const stub = new StubRuntime()
    const reads: string[] = []
    const conversation = createConversation({
      runtime: stub.runtime,
      services: {
        answerApproval: async () => undefined,
        sendInput: async () => undefined,
        history: async (threadId) => {
          reads.push(threadId)
          return {
            rootBranchId: 'b0',
            selectedBranchId: 'b1',
            forks: [
              {
                schema: 's',
                branchId: 'b1',
                tenantId: 't',
                threadId,
                createdAtMs: 5,
                parentBranchId: 'b0',
                forkedAfterMessageId: 'm1',
              },
            ],
            activeRunId: null,
            lastRunOutcome: undefined,
            lastReplyAtMs: 9,
            origin: { kind: 'continued', threadId: 'src' },
          } as never
        },
      },
      workspaceId: 'w1',
      schedule: () => () => {},
    })
    expect(conversation.snapshot().history).toBeUndefined()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(reads).toEqual(['remote-1'])
    expect(conversation.snapshot().history).toEqual({
      rootBranchId: 'b0',
      selectedBranchId: 'b1',
      forks: [
        {
          branchId: 'b1',
          parentBranchId: 'b0',
          forkedAfterMessageId: 'm1',
          createdAtMs: 5,
        },
      ],
      activeRunId: null,
      lastReplyAtMs: 9,
      origin: { kind: 'continued', threadId: 'src' },
    })
  })
})

describe('switching a branch', () => {
  const fork = (branchId: string) => ({
    schema: 's',
    branchId,
    tenantId: 't',
    threadId: 'remote-1',
    createdAtMs: 5,
    parentBranchId: 'b0',
  })
  function branches(selected = 'b0') {
    const stub = new StubRuntime()
    const state = {
      selected,
      selects: [] as string[],
      reloads: 0,
      fail: undefined as unknown,
      missing: false,
    }
    const tree = () =>
      ({
        rootBranchId: 'b0',
        selectedBranchId: state.selected,
        forks: [fork('b1')],
        activeRunId: null,
        lastRunOutcome: undefined,
        lastReplyAtMs: undefined,
        origin: undefined,
      }) as never
    stub.runtime.threads.reloadMainThread = async () =>
      void (state.reloads += 1)
    const conversation = createConversation({
      runtime: stub.runtime,
      services: {
        answerApproval: async () => undefined,
        sendInput: async () => undefined,
        history: async (threadId) => {
          if (state.missing || threadId !== 'remote-1')
            throw new TheoremError({ message: 'gone', statusCode: 404 })
          return tree()
        },
        selectBranch: async (_thread, branch) => {
          if (state.fail) throw state.fail
          state.selects.push(branch)
          state.selected = branch
        },
      },
      workspaceId: 'w1',
      schedule: () => () => {},
    })
    return { conversation, state, stub }
  }
  const ask = (branchId: string, threadId = 'remote-1') => ({
    requestId: 'r',
    threadId,
    branchId,
  })

  test('accepted: the branch is selected, the thread reloaded, and the snapshot at once carries the new selection', async () => {
    const { conversation, state } = branches()
    const heard: ConversationSnapshot[] = []
    conversation.subscribe((snapshot) => heard.push(snapshot))
    const done = await conversation.switchBranch(ask('b1'))
    expect(done).toMatchObject({
      outcome: 'accepted',
      value: { conversationId: 'remote-1' },
    })
    expect(state.selects).toEqual(['b1'])
    expect(state.reloads).toBe(1)
    expect(heard.at(-1)!.history).toMatchObject({
      rootBranchId: 'b0',
      selectedBranchId: 'b1',
      forks: [{ branchId: 'b1', parentBranchId: 'b0', createdAtMs: 5 }],
    })
    expect(heard.at(-1)!.revision).toBe(conversation.snapshot().revision)
  })

  test('a branch that is already selected is not written again', async () => {
    const { conversation, state } = branches('b1')
    expect(await conversation.switchBranch(ask('b1'))).toMatchObject({
      outcome: 'accepted',
    })
    expect(state.selects).toEqual([])
  })

  test('an unknown branch and an unknown thread are refused and select nothing', async () => {
    const { conversation, state } = branches()
    expect(await conversation.switchBranch(ask('zz'))).toMatchObject({
      outcome: 'refused',
      code: 'unknown_branch',
    })
    expect(await conversation.switchBranch(ask('b1', 'nope'))).toMatchObject({
      outcome: 'refused',
      code: 'unknown_thread',
    })
    expect(state.selects).toEqual([])
  })

  test('a write whose answer was lost is uncertain and is not repeated', async () => {
    const { conversation, state } = branches()
    state.fail = new Error('network')
    expect(await conversation.switchBranch(ask('b1'))).toMatchObject({
      outcome: 'uncertain',
    })
    expect(state.selects).toEqual([])
  })

  test('a request drawn against another conversation is stale and does nothing', async () => {
    const { conversation, state } = branches()
    expect(
      await conversation.switchBranch({ ...ask('b1'), conversationId: 'old' }),
    ).toMatchObject({ outcome: 'refused', code: 'stale_conversation' })
    expect(state.selects).toEqual([])
  })
})

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

  test('without a way to make a second runtime a side chat is refused as missing', async () => {
    const { conversation } = setup()
    expect(await conversation.sideChat(base('r'))).toMatchObject({
      outcome: 'refused',
      code: 'missing_capability',
    })
  })

  test('input and stop for another run than the one working are stale', async () => {
    const { stub, conversation, inputs } = setup()
    stub.isRunning = true
    stub.messages = [assistant('a1', 'x', { runId: 'run1' })]
    expect(
      await conversation.input({
        ...base('r1'),
        clientMessageId: 'c1',
        text: 'x',
        runId: 'old',
      }),
    ).toMatchObject({ outcome: 'refused', code: 'stale_run' })
    expect(inputs).toEqual([])
    expect(
      await conversation.stop({ ...base('r2'), runId: 'old' }),
    ).toMatchObject({ outcome: 'refused', code: 'stale_run' })
    expect(stub.cancels).toBe(0)
    expect(
      await conversation.stop({ ...base('r3'), runId: 'run1' }),
    ).toMatchObject({ outcome: 'accepted', value: { runId: 'run1' } })
  })
})

describe('side chat', () => {
  function withSide() {
    const main = setup()
    const side = new StubRuntime()
    side.threadId = 'side-1'
    side.remoteId = undefined
    let closed = 0
    let made = 0
    const opens: unknown[] = []
    const stored: { threadId?: string } = {}
    const conversation = createConversation({
      runtime: main.stub.runtime,
      sideChats: {
        open: async (request) => {
          made += 1
          opens.push(request)
          return {
            runtime: side.runtime,
            threadId: () => stored.threadId,
            close: () => void (closed += 1),
          }
        },
      },
      services: {
        answerApproval: async () => undefined,
        sendInput: async () => undefined,
      },
      workspaceId: 'w1',
      schedule: () => () => undefined,
    })
    return {
      main,
      side,
      conversation,
      opens,
      stored,
      closed: () => closed,
      made: () => made,
    }
  }

  test('has its own conversation resource, and its sends never reach the main thread', async () => {
    const t = withSide()
    const done = await t.conversation.sideChat(base('r1'))
    if (done.outcome !== 'accepted') throw new Error(done.outcome)
    const chat = done.value
    expect(chat.conversationId).toBe('side-1')
    expect(chat.conversationId).not.toBe(
      t.conversation.snapshot().conversationId,
    )
    expect(
      await chat.conversation.send({
        ...base('r2'),
        clientMessageId: 'c1',
        text: 'aside',
      }),
    ).toMatchObject({ outcome: 'accepted' })
    expect(t.side.appends).toHaveLength(1)
    expect(t.main.stub.appends).toHaveLength(0)
    // The main conversation's own send goes to the main runtime only.
    await t.conversation.send({
      ...base('r3'),
      clientMessageId: 'c2',
      text: 'main',
    })
    expect(t.main.stub.appends).toHaveLength(1)
    expect(t.side.appends).toHaveLength(1)
    // An action drawn against the main thread is stale for the side chat.
    expect(
      await chat.conversation.send({
        ...base('r4'),
        clientMessageId: 'c3',
        text: 'x',
        conversationId: t.conversation.snapshot().conversationId,
      }),
    ).toMatchObject({ outcome: 'refused', code: 'stale_conversation' })
  })

  test('closing disposes its conversation and its runtime, once', async () => {
    const t = withSide()
    const done = await t.conversation.sideChat(base('r1'))
    if (done.outcome !== 'accepted') throw new Error(done.outcome)
    expect(t.side.listenerCount()).toBeGreaterThan(0)
    done.value.close()
    done.value.close()
    expect(t.closed()).toBe(1)
    expect(t.side.listenerCount()).toBe(0)
    expect(
      await done.value.conversation.send({
        ...base('r2'),
        clientMessageId: 'c1',
        text: 'late',
      }),
    ).toMatchObject({ outcome: 'refused', code: 'disposed' })
  })

  test('a continued or forked side chat is opened from the main conversation stored thread, and a main one with none stored refuses', async () => {
    const t = withSide()
    for (const scope of ['continued', 'forked'] as const) {
      expect(
        (await t.conversation.sideChat({ ...base('r'), scope })).outcome,
      ).toBe('accepted')
    }
    await t.conversation.sideChat(base('r'))
    expect(t.opens).toEqual([
      { scope: 'continued', from: 'remote-1' },
      { scope: 'forked', from: 'remote-1' },
      { scope: 'fresh', from: 'remote-1' },
    ])
    t.main.stub.remoteId = undefined
    expect(
      await t.conversation.sideChat({ ...base('r'), scope: 'forked' }),
    ).toMatchObject({ outcome: 'refused', code: 'not_stored' })
    expect(t.opens).toHaveLength(3)
    expect((await t.conversation.sideChat(base('r'))).outcome).toBe('accepted')
  })

  test('lists the side chats open now with their scope and, once it exists, their stored thread; a closed one is gone', async () => {
    const t = withSide()
    expect(t.conversation.sideChats()).toEqual([])
    const done = await t.conversation.sideChat({
      ...base('r'),
      scope: 'continued',
    })
    if (done.outcome !== 'accepted') throw new Error(done.outcome)
    expect(t.conversation.sideChats()).toEqual([
      { conversationId: 'side-1', scope: 'continued', from: 'remote-1' },
    ])
    t.stored.threadId = 'stored-9'
    expect(t.conversation.sideChats()[0]).toMatchObject({
      conversationId: 'side-1',
      threadId: 'stored-9',
    })
    done.value.close()
    expect(t.conversation.sideChats()).toEqual([])
  })

  test('disposing the owner closes every side chat', async () => {
    const t = withSide()
    await t.conversation.sideChat(base('r1'))
    t.conversation.dispose()
    expect(t.closed()).toBe(1)
  })

  test('a runtime that cannot be made is a failure, not a refusal', async () => {
    const main = setup()
    const conversation = createConversation({
      runtime: main.stub.runtime,
      sideChats: {
        open: async () => {
          throw new Error('no runtime')
        },
      },
      services: {
        answerApproval: async () => undefined,
        sendInput: async () => undefined,
      },
      workspaceId: 'w1',
    })
    expect((await conversation.sideChat(base('r'))).outcome).toBe('failed')
    conversation.dispose()
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

  test('an edit keeps the attachments of the message it edits', async () => {
    const { stub, conversation } = setup()
    await conversation.send({
      ...base('r'),
      clientMessageId: 'c1',
      text: 'hi',
      attachments: [{ id: 'up1', name: 'notes.txt', contentType: 'text/plain' }],
    })
    const result = await conversation.edit({
      ...base('r2'),
      messageId: 'u1',
      clientMessageId: 'c2',
      text: 'hey',
    })
    expect(result.outcome).toBe('accepted')
    expect(stub.appends.at(-1)).toMatchObject({
      sourceId: 'u1',
      attachments: [
        expect.objectContaining({ id: 'up1', name: 'notes.txt' }),
      ],
    })
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
