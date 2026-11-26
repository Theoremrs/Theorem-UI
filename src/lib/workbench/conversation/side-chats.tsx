// SOURCING: @assistant-ui/react useLocalRuntime (a runtime is hook-only, so each side chat is a mounted component, the way the terminal drawer's per-session Agent is); React useSyncExternalStore for the list of mounted side chats
import { useLocalRuntime } from '@assistant-ui/react'
import { useEffect, useLayoutEffect, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import type {
  ConversationRuntime,
  SideChats,
  SideChatScope,
  SideRuntime,
} from './conversation'
import type { SideChatModel } from './side-chat-model'

interface Entry {
  key: number
  model: SideChatModel
  ready: (runtime: ConversationRuntime) => void
}

/**
 * Side chats for one mounted `Hosts`. `open` makes a second assistant-ui runtime over the
 * same factory as the main one; `close` unmounts it and drops it. Closing, a project switch
 * and an unmount detach: the run keeps working on its own thread, and `open` with `reopen`
 * shows it again. Only a stop asked of the side chat's own conversation cancels its run.
 */
export function createSideChats(
  makeModel: (request: {
    scope: SideChatScope
    from?: string
    reopen?: string
  }) => Promise<SideChatModel>,
  /** The project these side chats make their threads in: closed ones are kept per project. */
  key?: string,
): {
  sideChats: SideChats
  Hosts: () => ReactNode
} {
  let entries: readonly Entry[] = []
  let mounted = 0
  let next = 0
  const listeners = new Set<() => void>()
  const set = (value: readonly Entry[]) => {
    entries = value
    for (const listener of [...listeners]) listener()
  }

  function Host({ entry }: { entry: Entry }) {
    // Before the runtime's own teardown, which aborts its run: a layout cleanup declared first
    // runs ahead of every other cleanup here, so that abort no longer reaches Theorem.
    useLayoutEffect(() => {
      entry.model.attach?.()
      return () => entry.model.detach?.()
    }, [entry])
    const runtime = useLocalRuntime(entry.model.adapter, {
      adapters: { history: entry.model.history },
    })
    useEffect(() => {
      entry.ready(ownConversation(runtime, entry.model))
    }, [runtime, entry])
    return null
  }

  function Hosts() {
    const current = useSyncExternalStore(
      (listener) => {
        listeners.add(listener)
        return () => void listeners.delete(listener)
      },
      () => entries,
    )
    useEffect(() => {
      mounted += 1
      return () => void (mounted -= 1)
    }, [])
    return current.map((entry) => <Host key={entry.key} entry={entry} />)
  }

  return {
    Hosts,
    sideChats: {
      ...(key ? { key } : {}),
      open: async (request) => {
        if (mounted === 0) throw new Error('No side chat host is mounted')
        const model = await makeModel(request)
        return new Promise<SideRuntime>((resolve) => {
          const entry: Entry = {
            key: (next += 1),
            model,
            ready: (runtime) =>
              resolve({
                runtime,
                threadId: model.threadId,
                close: () => {
                  model.detach?.()
                  set(entries.filter((e) => e !== entry))
                },
              }),
          }
          set([...entries, entry])
        })
      },
    },
  }
}

/**
 * A local runtime names its one thread the same way in every instance, so the
 * conversation id is the side chat's own durable thread once its first turn made it, and
 * a key of its own before that.
 */
function ownConversation(
  runtime: ConversationRuntime,
  model: SideChatModel,
): ConversationRuntime {
  const local = `side-${crypto.randomUUID()}`
  return {
    thread: runtime.thread,
    threads: {
      ...runtime.threads,
      getState: () => ({ mainThreadId: model.threadId() ?? local }),
      // The durable id only: a key of its own names no thread Theorem has.
      mainItem: { getState: () => ({ remoteId: model.threadId() }) },
    },
  }
}
