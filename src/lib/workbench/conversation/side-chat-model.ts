// SOURCING: lib/theorem/runtime (runTurn and createHistoryAdapter) is the factory the main chat and the terminal drawer's Agent run their turns through; a side chat takes a second instance of it. terminal-screen.tsx's Agent builds the same adapter inline and is not editable here, so the duplication is the adapter's six lines
import type {
  ChatModelAdapter,
  ThreadHistoryAdapter,
} from '@assistant-ui/react'
import { mutate, theorem } from '@/lib/theorem/client'
import { createHistoryAdapter, runTurn } from '@/lib/theorem/runtime'
import type { TurnOptions } from '@/lib/theorem/runtime'
import { threadOriginFor } from '@/lib/theorem/thread-origin'
import type { SideChatScope } from './conversation'

/** What one side chat's runtime is made from. */
export interface SideChatModel {
  adapter: ChatModelAdapter
  history: ThreadHistoryAdapter
  /** The durable thread this side chat owns, once its first turn has made it. */
  threadId: () => string | undefined
}

/** A side chat works in the same mode the terminal drawer's agent does. */
const TURN_OPTIONS: TurnOptions = { executionMode: 'coding' }

/**
 * A side chat's own durable thread, never shared with the main thread. A `fresh` one is created on its
 * first turn. A `continued` or `forked` one starts from the main conversation's stored thread, so its
 * thread is created now: a fork's history has to be there for the runtime to load.
 */
export async function createSideChatModel(
  projectId: string,
  { scope, from }: { scope: SideChatScope; from?: string } = {
    scope: 'fresh',
  },
): Promise<SideChatModel> {
  let threadId: string | undefined
  const create = async () => {
    const start =
      scope === 'fresh' || !from
        ? undefined
        : await threadOriginFor({ kind: scope, threadId: from })
    const created = await mutate((headers) =>
      theorem().chat.threads.create({
        projectId: start?.projectId ?? projectId,
        title: scope === 'forked' && start?.title ? start.title : 'Side chat',
        ...(start ? { origin: start.origin } : {}),
        ...headers,
      }),
    )
    threadId = created.record.threadId
  }
  if (scope !== 'fresh') await create()
  return {
    threadId: () => threadId,
    adapter: {
      async *run(options) {
        if (!threadId) await create()
        yield* runTurn(threadId!, options, TURN_OPTIONS)
      },
    },
    history: createHistoryAdapter(() => threadId),
  }
}
