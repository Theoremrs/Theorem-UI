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
  const asked: [string, string | undefined][] = []
  let frame: (() => void) | undefined
  const conversation = createConversation({
    runtime: stub.runtime,
    services: {
      answerApproval: async (request) => void answers.push(request),
      sendInput: async (request) => void inputs.push(request),
      openUnder: (threadId, projectId) =>
        void asked.push([threadId, projectId]),
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
    asked,
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

  test('a switch that names a project says so before the thread opens, and one that names none says nothing', async () => {
    const { perform, stub, asked } = setup()
    const order: string[] = []
    const switchToThread = stub.runtime.threads.switchToThread
    stub.runtime.threads.switchToThread = async (id) => {
      order.push(`opened ${id} after ${asked.length} asked`)
      await switchToThread(id)
    }
    await perform('conversationSwitch', { threadId: 't2' }, { type: 'none' })
    expect(asked).toEqual([])
    await perform(
      'conversationSwitch',
      { threadId: 't3', projectId: 'p2' },
      { type: 'none' },
    )
    expect(asked).toEqual([['t3', 'p2']])
    expect(order).toEqual([
      'opened t2 after 0 asked',
      'opened t3 after 1 asked',
    ])
  })

  test('a switch that fails takes back the project it asked for', async () => {
    const { perform, stub, asked } = setup()
    stub.runtime.threads.switchToThread = async () => {
      throw new Error('gone')
    }
    expect(
      await perform(
        'conversationSwitch',
        { threadId: 't3', projectId: 'p2' },
        { type: 'none' },
      ),
    ).toMatchObject({ outcome: 'failed' })
    expect(asked).toEqual([
      ['t3', 'p2'],
      ['t3', undefined],
    ])
  })
})

describe('snapshots', () => {
  test('a subscriber is given the current snapshot, then each change, named by project and thread', async () => {
    const { port, stub, perform, runFrame } = setup()
    const heard: HostMessage[] = []
    // The followed runs have their own tests below.
    port.subscribe?.(
      (message) => message.type !== 'followedRuns' && heard.push(message),
    )
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

describe('side chats', () => {
  function withSides() {
    const main = new StubRuntime()
    const sides: StubRuntime[] = []
    const closed: number[] = []
    const opened: unknown[] = []
    const frames: (() => void)[] = []
    const conversation = createConversation({
      runtime: main.runtime,
      sideChats: {
        open: async (request) => {
          opened.push(request)
          const stub = new StubRuntime()
          stub.threadId = `side-${sides.length + 1}`
          stub.remoteId = undefined
          sides.push(stub)
          const index = sides.length
          return {
            runtime: stub.runtime,
            threadId: () => undefined,
            close: () => void closed.push(index),
          }
        },
      },
      services: {
        answerApproval: async () => undefined,
        sendInput: async () => undefined,
      },
      workspaceId: 'w1',
      schedule: (callback) => {
        frames.push(callback)
        return () => void frames.splice(frames.indexOf(callback), 1)
      },
    })
    const port = createConversationPort({ conversation, project: 'p1' })
    const heard: HostMessage[] = []
    port.subscribe?.((message) => heard.push(message))
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
    const open = async () => {
      const done = await perform('conversationSideChat', {})
      if (
        done.outcome !== 'accepted' ||
        done.value?.type !== 'conversationSideOpened'
      )
        throw new Error('the side chat did not open')
      return done.value.conversationId
    }
    const flush = () => {
      for (const frame of [...frames]) frame()
    }
    const snapshotsOf = (conversationId: string) =>
      heard.filter(
        (message) =>
          message.type === 'conversationSnapshot' &&
          message.resource.type === 'conversation' &&
          message.resource.thread === conversationId,
      ) as Extract<HostMessage, { type: 'conversationSnapshot' }>[]
    return {
      main,
      sides,
      closed,
      opened,
      port,
      perform,
      open,
      flush,
      heard,
      snapshotsOf,
    }
  }

  test('the scope reaches the owner, and the list answers the side chats open with their scope', async () => {
    const { perform, opened, port } = withSides()
    expect(port.canSideChat).toBe(true)
    await perform('conversationSideChat', {})
    await perform('conversationSideChat', { scope: 'forked' })
    expect(opened).toEqual([
      { scope: 'fresh', from: 'remote-1' },
      { scope: 'forked', from: 'remote-1' },
    ])
    const listed = await perform('conversationSideList')
    expect(listed).toMatchObject({
      outcome: 'accepted',
      value: {
        type: 'conversationSideList',
        chats: [{ scope: 'fresh' }, { scope: 'forked', from: 'remote-1' }],
      },
    })
  })

  const send = (clientMessageId: string, text: string) => ({
    clientMessageId,
    text,
    attachments: [],
  })

  test('opening one answers conversationSideOpened with its own id and sends its first snapshot under that id', async () => {
    const { open, snapshotsOf, sides, opened } = withSides()
    const id = await open()
    expect(id).not.toBe('remote-1')
    expect(sides).toHaveLength(1)
    expect(opened).toEqual([{ scope: 'fresh', from: 'remote-1' }])
    expect(snapshotsOf(id)).toHaveLength(1)
    expect(snapshotsOf(id)[0]).toMatchObject({
      conversationId: id,
      revision: { scheme: 'seq', value: 1 },
    })
  })

  test('a send for a side chat the port does not hold is refused and nothing reaches the main conversation or any side chat', async () => {
    const { open, perform, main, sides } = withSides()
    await open()
    const done = await perform(
      'conversationSend',
      send('c1', 'lost'),
      thread('no-such-side'),
    )
    expect(done).toMatchObject({
      outcome: 'refused',
      code: 'stale_conversation',
    })
    expect(main.appends).toEqual([])
    expect(sides[0]!.appends).toEqual([])
  })

  test('a send names its conversation: the side chat gets it and the main conversation does not', async () => {
    const { open, perform, main, sides } = withSides()
    const id = await open()
    const done = await perform(
      'conversationSend',
      send('c1', 'aside'),
      thread(id),
    )
    expect(done).toMatchObject({
      outcome: 'accepted',
      value: { type: 'conversationSent', clientMessageId: 'c1' },
    })
    expect(sides[0]!.appends).toHaveLength(1)
    expect(main.appends).toEqual([])
    await perform('conversationSend', send('c2', 'main'), thread('remote-1'))
    expect(main.appends).toHaveLength(1)
    expect(sides[0]!.appends).toHaveLength(1)
  })

  test("two side chats' snapshots never cross, and each counts its own revisions", async () => {
    const { open, perform, snapshotsOf, flush } = withSides()
    const a = await open()
    const b = await open()
    await perform('conversationSend', send('c1', 'only-in-a'), thread(a))
    flush()
    const inA = snapshotsOf(a)
    const inB = snapshotsOf(b)
    expect(inA.at(-1)!.snapshot).toContain('only-in-a')
    expect(inA.at(-1)!.revision).toEqual({ scheme: 'seq', value: 2 })
    expect(inB.map((message) => message.snapshot).join()).not.toContain(
      'only-in-a',
    )
    expect(inB.at(-1)!.revision).toEqual({ scheme: 'seq', value: 1 })
    for (const message of [...inA, ...inB]) {
      expect(JSON.parse(message.snapshot).conversationId).toBe(
        message.resource.type === 'conversation' ? message.resource.thread : '',
      )
    }
  })

  test('closing one disposes its runtime, stops its forwarding and refuses what comes after, without touching the other', async () => {
    const { open, perform, snapshotsOf, flush, sides, closed } = withSides()
    const a = await open()
    const b = await open()
    expect(
      await perform('conversationSideClose', undefined, thread(a)),
    ).toEqual({ outcome: 'accepted' })
    expect(closed).toEqual([1])
    const before = snapshotsOf(a).length
    sides[0]!.messages.push(assistant('late', 'x'))
    sides[0]!.emit()
    flush()
    expect(snapshotsOf(a)).toHaveLength(before)
    expect(
      await perform('conversationSend', send('c1', 'too late'), thread(a)),
    ).toMatchObject({ outcome: 'refused', code: 'stale_conversation' })
    expect(sides[0]!.appends).toEqual([])
    expect(
      await perform('conversationSend', send('c2', 'still here'), thread(b)),
    ).toMatchObject({ outcome: 'accepted' })
    expect(
      await perform('conversationSideClose', undefined, thread(a)),
    ).toMatchObject({ outcome: 'refused', code: 'unknown_conversation' })
  })

  test('cancel, retry, edit and approval go to the conversation the resource names', async () => {
    const { open, perform, main, sides } = withSides()
    const id = await open()
    sides[0]!.isRunning = true
    sides[0]!.messages.push(assistant('r1', 'working'))
    expect(await perform('conversationCancel', {}, thread(id))).toMatchObject({
      outcome: 'accepted',
    })
    expect(sides[0]!.cancels).toBe(1)
    expect(main.cancels).toBe(0)
    expect(
      await perform('conversationRetry', { messageId: 'nope' }, thread('gone')),
    ).toMatchObject({ outcome: 'refused', code: 'stale_conversation' })
  })

  test('create and switch are refused for a side chat, which keeps its own thread', async () => {
    const { open, perform, main } = withSides()
    const id = await open()
    expect(
      await perform('conversationCreate', undefined, thread(id)),
    ).toMatchObject({ outcome: 'refused', code: 'side_chat' })
    expect(
      await perform('conversationSwitch', { threadId: 'x' }, thread(id)),
    ).toMatchObject({ outcome: 'refused', code: 'side_chat' })
    expect(main.starts).toEqual([])
  })

  test('a conversation effect on another kind of resource is refused', async () => {
    const { perform, main } = withSides()
    expect(
      await perform('conversationSend', send('c1', 'x'), {
        type: 'document',
        workspace: 'w1',
        resourceId: 'a',
      } as never),
    ).toMatchObject({ outcome: 'refused', code: 'wrong_resource' })
    expect(main.appends).toEqual([])
  })

  test('a later subscriber is told the main conversation and every open side chat first', async () => {
    const { open, port } = withSides()
    const a = await open()
    const late: HostMessage[] = []
    port.subscribe?.((message) => late.push(message))
    const resources = late.flatMap((message) =>
      message.type === 'conversationSnapshot' &&
      message.resource.type === 'conversation'
        ? [message.resource.thread]
        : [],
    )
    expect(resources).toEqual(['remote-1', a])
  })
})

describe('switching a branch through the port', () => {
  test('the effect selects the branch and answers like a switch; a resource for another thread is stale', async () => {
    const stub = new StubRuntime()
    const selects: string[] = []
    const conversation = createConversation({
      runtime: stub.runtime,
      services: {
        answerApproval: async () => undefined,
        sendInput: async () => undefined,
        history: async () =>
          ({
            rootBranchId: 'b0',
            selectedBranchId: selects.at(-1) ?? 'b0',
            forks: [{ branchId: 'b1', createdAtMs: 1 }],
            activeRunId: null,
          }) as never,
        selectBranch: async (_thread, branch) => void selects.push(branch),
      },
      workspaceId: 'w1',
      schedule: () => () => {},
    })
    const port = createConversationPort({ conversation, project: 'p1' })
    expect(port.canSwitchBranch).toBe(true)
    const perform = (resource: ResourceRef, branchId: string) =>
      port.perform(
        {
          id: 1,
          resource,
          kind: 'conversationSwitchBranch',
          payload: { threadId: 'remote-1', branchId },
        } as never,
        'req-1',
      )
    expect(await perform(thread('remote-1'), 'b1')).toEqual({
      outcome: 'accepted',
      value: { type: 'conversationOpened', conversationId: 'remote-1' },
    })
    expect(selects).toEqual(['b1'])
    expect(await perform(thread('old'), 'b1')).toMatchObject({
      outcome: 'refused',
      code: 'stale_conversation',
    })
    expect(await perform(thread('remote-1'), 'zz')).toMatchObject({
      outcome: 'refused',
      code: 'unknown_branch',
    })
  })
})

describe('followed runs', () => {
  const delegation = (childRunId: string) => ({
    type: 'data',
    name: 'theorem-delegation',
    data: {
      delegationId: 'd1',
      parentRunId: 'run-1',
      childRunId,
      state: 'started',
      intent: {},
    },
  })
  const followed = (heard: HostMessage[]) =>
    heard.flatMap((message) =>
      message.type === 'followedRuns' ? [message.runs] : [],
    )

  test('the core hears the set once on connect, then each time it changes, and not when it is the same again', () => {
    const { port, stub } = setup()
    const heard: HostMessage[] = []
    port.subscribe?.((message) => heard.push(message))
    expect(followed(heard)).toEqual([[]])

    stub.messages = [assistant('m1', 'working', { runId: 'run-1' })]
    stub.emit()
    stub.emit()
    expect(followed(heard)).toEqual([[], ['run-1']])

    stub.messages = [
      assistant('m1', 'working', {
        runId: 'run-1',
        parts: [delegation('child-1')],
      }),
    ]
    stub.emit()
    expect(followed(heard)).toEqual([[], ['run-1'], ['run-1', 'child-1']])

    stub.messages = [
      assistant('m1', 'done', {
        runId: 'run-1',
        status: { type: 'complete', reason: 'stop' },
      }),
    ]
    stub.emit()
    expect(followed(heard).at(-1)).toEqual([])
  })

  test('a stopped subscription hears no more', () => {
    const { port, stub } = setup()
    const heard: HostMessage[] = []
    const stop = port.subscribe?.((message) => heard.push(message))
    stop?.()
    stub.messages = [assistant('m1', 'working', { runId: 'run-1' })]
    stub.emit()
    expect(followed(heard)).toEqual([[]])
  })
})
