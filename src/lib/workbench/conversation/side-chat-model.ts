// SOURCING: lib/theorem/runtime (runTurn and createHistoryAdapter) is the factory the main chat and the terminal drawer's Agent run their turns through; a side chat takes a second instance of it. terminal-screen.tsx's Agent builds the same adapter inline and is not editable here, so the duplication is the adapter's six lines
import type {
  ChatModelAdapter,
  ThreadHistoryAdapter,
} from '@assistant-ui/react'
import { mutate, theorem } from '@/lib/theorem/client'
import { createHistoryAdapter, runTurn } from '@/lib/theorem/runtime'
import type { TurnOptions } from '@/lib/theorem/runtime'

/** What one side chat's runtime is made from. */
export interface SideChatModel {
  adapter: ChatModelAdapter
  history: ThreadHistoryAdapter
  /** The durable thread this side chat owns, once its first turn has made it. */
  threadId: () => string | undefined
}

/** A side chat works in the same mode the terminal drawer's agent does. */
const TURN_OPTIONS: TurnOptions = { executionMode: 'coding' }

/** A side chat's own durable thread, created on its first turn and never shared with the main thread. */
export function createSideChatModel(projectId: string): SideChatModel {
  let threadId: string | undefined
  return {
    threadId: () => threadId,
    adapter: {
      async *run(options) {
        if (!threadId) {
          const created = await mutate((headers) =>
            theorem().chat.threads.create({
              projectId,
              title: 'Side chat',
              ...headers,
            }),
          )
          threadId = created.record.threadId
        }
        yield* runTurn(threadId, options, TURN_OPTIONS)
      },
    },
    history: createHistoryAdapter(() => threadId),
  }
}
