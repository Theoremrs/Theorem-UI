// SOURCING: @assistant-ui/react (the useAui client is the runtime the conversation owner drives); sendApprovalDecision and sendRunInput are the chat's own Theorem sends, reused so an approval or run input from the workbench takes the same path as the composer's
import type { AssistantClient } from '@assistant-ui/react'
import { sendApprovalDecision } from '@/lib/theorem/approval'
import { sendRunInput } from '@/lib/theorem/run-input-runtime'
import type { ConversationRuntime, ConversationServices } from './conversation'

/**
 * The conversation owner's view of the assistant-ui client. Every member reads the
 * client when it is called, so the view never goes stale when the thread changes.
 * The client lacks `subscribe` on the thread and `mainItem` on the list; both come
 * from the client's own state and its single subscription.
 */
export function conversationRuntimeOf(
  aui: AssistantClient,
): ConversationRuntime {
  return {
    thread: {
      getState: () => aui.thread().getState(),
      subscribe: (listener) => aui.subscribe(listener),
      append: (message) => aui.thread().append(message),
      startRun: (config) => aui.thread().startRun(config),
      cancelRun: () => aui.thread().cancelRun(),
    },
    threads: {
      getState: () => aui.threads().getState(),
      subscribe: (listener) => aui.subscribe(listener),
      mainItem: { getState: () => aui.threads().item('main').getState() },
      switchToThread: async (threadId) => {
        await aui.threads().switchToThread(threadId)
      },
      switchToNewThread: async () => {
        await aui.threads().switchToNewThread()
      },
    },
  }
}

/** What the conversation sends to Theorem that the runtime does not carry. */
export const conversationServices: ConversationServices = {
  answerApproval: async ({ runId, approvalId, toolCallId, choice }) => {
    await sendApprovalDecision(runId, { approvalId, toolCallId }, choice)
  },
  sendInput: async ({ runId, inputId, text }) => {
    await sendRunInput(runId, text, inputId)
  },
}
