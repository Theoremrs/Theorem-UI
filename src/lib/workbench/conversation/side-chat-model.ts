// SOURCING: lib/theorem/runtime (runTurn and createHistoryAdapter; the SDK adapter cancels the server run only when its abort signal fires, and ending iteration stops reading without cancelling) is the factory the main chat and the terminal drawer's Agent run their turns through; a side chat takes a second instance of it. terminal-screen.tsx's Agent builds the same adapter inline and is not editable here, so the duplication is the adapter's six lines
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
  /**
   * Stops reading this side chat's run without stopping the run (UAE DR-, IN-: closing a view
   * never cancels work). After it, an abort from the runtime no longer reaches Theorem; only a
   * stop asked for before it does.
   */
  detach?: () => void
  /** A view shows this side chat again: turns read from here on, and a stop reaches Theorem. */
  attach?: () => void
}

/**
 * Yields `source` until `detached` fires, then ends without waiting for its next step and
 * tells `source` to finish. Ending a turn this way runs its cleanup (unsubscribe, close the
 * reader) but never its cancel, which only an abort starts.
 */
export async function* untilDetached<T>(
  source: AsyncIterable<T>,
  detached: AbortSignal,
): AsyncGenerator<T, void> {
  if (detached.aborted) return
  const iterator = source[Symbol.asyncIterator]()
  let wake: () => void = () => {}
  const gone = new Promise<'gone'>((resolve) => {
    wake = () => resolve('gone')
  })
  detached.addEventListener('abort', wake, { once: true })
  try {
    while (true) {
      const step = await Promise.race([iterator.next(), gone])
      if (step === 'gone') {
        void iterator.return?.()?.catch(() => undefined)
        return
      }
      if (step.done) return
      yield step.value
    }
  } finally {
    detached.removeEventListener('abort', wake)
  }
}

/**
 * One side chat's way to stop reading without stopping: `signal` is the abort a turn is given,
 * which follows the runtime's until `detach`, and `read` ends a turn's stream at `detach`.
 */
export function detaching(): {
  detach: () => void
  attach: () => void
  signal: (outer: AbortSignal) => AbortSignal
  read: <T>(source: AsyncIterable<T>) => AsyncGenerator<T, void>
} {
  // Each attachment has its own controller: a detach ends the reads begun under it, and a
  // later attach (a remount) starts a new one rather than staying silent.
  let detached = new AbortController()
  return {
    detach: () => detached.abort(),
    attach: () => {
      if (detached.signal.aborted) detached = new AbortController()
    },
    signal: (outer) => stopUnlessDetached(outer, detached.signal),
    read: (source) => untilDetached(source, detached.signal),
  }
}

/** A signal that follows `outer` until `detached` fires, and never after. */
function stopUnlessDetached(
  outer: AbortSignal,
  detached: AbortSignal,
): AbortSignal {
  const stop = new AbortController()
  const forward = () => {
    if (!detached.aborted) stop.abort(outer.reason)
  }
  if (outer.aborted) forward()
  else outer.addEventListener('abort', forward, { once: true })
  return stop.signal
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
  {
    scope,
    from,
    reopen,
  }: { scope: SideChatScope; from?: string; reopen?: string } = {
    scope: 'fresh',
  },
): Promise<SideChatModel> {
  // A reopened side chat is its own stored thread again: its history loads and a run still
  // working there is resumed, never started over.
  let threadId: string | undefined = reopen
  const detached = detaching()
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
  if (scope !== 'fresh' && !reopen) await create()
  const history = createHistoryAdapter(() => threadId)
  const resume = history.resume?.bind(history)
  return {
    threadId: () => threadId,
    detach: detached.detach,
    attach: detached.attach,
    adapter: {
      async *run(options) {
        if (!threadId) await create()
        const abortSignal = detached.signal(options.abortSignal)
        yield* detached.read(
          runTurn(threadId!, { ...options, abortSignal }, TURN_OPTIONS),
        )
      },
    },
    history: {
      ...history,
      ...(resume
        ? {
            async *resume(options) {
              const abortSignal = detached.signal(options.abortSignal)
              yield* detached.read(resume({ ...options, abortSignal }))
            },
          }
        : {}),
    },
  }
}
