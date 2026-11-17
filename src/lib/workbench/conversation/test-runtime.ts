// SOURCING: none — a stub runtime shaped like assistant-ui's AssistantRuntime (thread and threads), plus the classic chat's own run-input binding (lib/theorem/run-input-runtime's bindRunInput) over it, shared by the conversation owner's tests, no network
import type { CreateAppendMessage, ThreadMessage } from '@assistant-ui/react'
import { createRunInputQueue, inputReceipt } from '@/lib/theorem/run-input'
import {
  registerRunInputQueue,
  useRunInputs,
} from '@/lib/theorem/run-input-store'
import type { InputReceipt } from '@/lib/theorem/run-input'
import { runIdOf } from './transcript'
import type { ConversationRuntime } from './conversation'

export function assistant(
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

/** The receipt part the run shows for input it took, as the SDK names it. */
export function userInputPart(receipt: {
  inputId: string
  text: string
  status: string
  reason?: string
}) {
  return { type: 'data', name: 'theorem-user_input', data: receipt }
}

/**
 * A sessionStorage-shaped store, so one test can hand a conversation's recovery
 * records to its next owner the way a reload does. The real one is shared by
 * every conversation of a thread, which is what makes recovery work; a test
 * needs its own to see only what it put there.
 */
export function createMemoryStorage(): Pick<
  Storage,
  'getItem' | 'setItem' | 'removeItem'
> {
  const held = new Map<string, string>()
  return {
    getItem: (key) => held.get(key) ?? null,
    setItem: (key, value) => void held.set(key, value),
    removeItem: (key) => void held.delete(key),
  }
}

export function approvalPart() {
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

export class StubRuntime {
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
      mainItem: {
        getState: () => ({ id: this.threadId, remoteId: this.remoteId }),
      },
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

/** Where a conversation's kept input is recorded, as the session's storage holds it. */
export type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

/** What Theorem stores about a thread's run: whether a run works, and what became of its input. */
export type ThreadStanding = {
  active: boolean
  runId?: string
  inputs: readonly InputReceipt[]
  /** User text the thread already holds. */
  userTexts?: readonly string[]
}

const receiptsOf = (messages: readonly ThreadMessage[]): InputReceipt[] =>
  messages.flatMap((message) =>
    message.content.flatMap((part) => {
      const receipt =
        part.type === 'data' && part.name === 'theorem-user_input'
          ? inputReceipt(part.data)
          : undefined
      return receipt ? [receipt] : []
    }),
  )

const lastRunOf = (messages: readonly ThreadMessage[]) => {
  const last = messages.at(-1)
  return last ? runIdOf(last) : undefined
}

/**
 * The queue the classic chat binds for its own thread — `bindRunInput` over this stub
 * runtime, with the SDK reads replaced by what the test scripts. The workbench drives the
 * same runtime the chat bound, so the thread has this one queue: a test that asks what the
 * owner does with run input is asking about *this*, not about a second queue of its own.
 */
export function bindThreadInputs(
  stub: StubRuntime,
  options: {
    storage: StorageLike
    /** What Theorem stores; default: whatever this runtime is showing. */
    thread?: () => ThreadStanding
    /** How a send to Theorem turns out; default: it is accepted and queued. */
    send?: (
      runId: string,
      text: string,
      id: string,
    ) => Promise<InputReceipt | void>
  },
) {
  const key = stub.runtime.threads.getState().mainThreadId
  const sent: { runId: string; inputId: string; text: string }[] = []
  const standing = (): ThreadStanding =>
    options.thread?.() ?? {
      active: stub.isRunning,
      runId: stub.isRunning ? lastRunOf(stub.messages) : undefined,
      inputs: receiptsOf(stub.messages),
    }
  const queue = createRunInputQueue({
    snapshot: () => ({
      threadId: stub.remoteId,
      runId: stub.isRunning ? lastRunOf(stub.messages) : undefined,
      isRunning: stub.isRunning,
      isLoading: false,
      inputs: receiptsOf(stub.messages),
      localUserTexts: stub.messages.flatMap((message) =>
        message.role === 'user'
          ? message.content.flatMap((part) =>
              part.type === 'text' ? [part.text] : [],
            )
          : [],
      ),
    }),
    refresh: async () => {
      const thread = standing()
      return {
        active: thread.active,
        runId: thread.runId,
        inputs: thread.inputs,
        userTexts: thread.userTexts ?? [],
      }
    },
    send: async (runId, text, id) => {
      sent.push({ runId, inputId: id, text })
      return (
        (await options.send?.(runId, text, id)) ?? {
          inputId: `srv-${id}`,
          text,
          status: 'queued' as const,
        }
      )
    },
    receipts: async () => standing().inputs,
    append: (text) =>
      stub.runtime.thread.append({
        role: 'user',
        content: [{ type: 'text', text }],
        runConfig: { custom: { theoremRunInput: true } },
      }),
    changed: (items) => useRunInputs.setState({ [key]: items }),
    describeError: (error) =>
      error instanceof Error ? error.message : 'Request failed.',
    attemptId: key,
    storage: options.storage,
  })
  const unregister = registerRunInputQueue(key, queue)
  const offThread = stub.runtime.thread.subscribe(queue.observe)
  queue.observe()
  return { key, queue, sent, dispose: () => void (offThread(), unregister()) }
}
