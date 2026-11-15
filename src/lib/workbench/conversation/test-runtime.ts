// SOURCING: none — a stub runtime shaped like assistant-ui's AssistantRuntime (thread and threads), shared by the conversation owner's tests, no network
import type { CreateAppendMessage, ThreadMessage } from '@assistant-ui/react'
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
