// SOURCING: assistant-ui's thread runtime (`append` starts a turn, as the composer's send does) and lib/theorem/run-input-runtime's sendRunInput (words for a working run, as the composer sends them mid-turn); zustand's subscribe on ./sessions. The choice between the two is the only logic here.
import { useEffect } from 'react'
import type { ThreadMessage } from '@assistant-ui/react'
import { sendRunInput } from '@/lib/theorem/run-input-runtime'
import { runIdOf } from '../conversation/transcript'
import { noticeText, useSessionNotices } from './sessions'

/** The part of an assistant-ui thread runtime a notice is delivered through. */
interface ChatThread {
  readonly thread: {
    getState: () => {
      readonly messages: readonly ThreadMessage[]
      readonly isRunning: boolean
    }
    append: (message: {
      role: 'user'
      content: { type: 'text'; text: string }[]
    }) => void
  }
}

type SendInput = (runId: string, text: string, key: string) => Promise<unknown>

/**
 * Tells the open chat about the sessions its runs started that have stopped
 * working: as words for its run while one works, else as a new turn, so the
 * agent wakes and can read the workbench. A notice for a run this chat does
 * not hold waits for the chat that does; one that fails to go is kept.
 */
export async function deliverNotices(
  runtime: ChatThread,
  sendInput: SendInput = sendRunInput,
): Promise<void> {
  const { messages, isRunning } = runtime.thread.getState()
  const runs = messages.map(runIdOf).filter((id) => id !== undefined)
  const held = new Set(runs)
  const mine = useSessionNotices
    .getState()
    .pending.filter((notice) => held.has(notice.runId))
  if (mine.length === 0) return
  const take = (keep: boolean) =>
    useSessionNotices.setState((s) => ({
      pending: keep
        ? [...s.pending, ...mine.filter((n) => !s.pending.includes(n))]
        : s.pending.filter((n) => !mine.includes(n)),
    }))
  take(false)
  const text = noticeText(mine)
  try {
    const working = isRunning ? runs.at(-1) : undefined
    if (working)
      await sendInput(working, text, `workbench-notice:${crypto.randomUUID()}`)
    else
      runtime.thread.append({ role: 'user', content: [{ type: 'text', text }] })
  } catch (error) {
    console.warn('The workbench could not tell the chat', error)
    take(true)
  }
}

/** Delivers notices to this chat whenever one arrives or the chat changes. */
export function useSessionNoticeDelivery(
  runtime: ChatThread & {
    thread: { subscribe: (callback: () => void) => () => void }
  },
) {
  useEffect(() => {
    let delivering = false
    const deliver = () => {
      if (delivering) return
      delivering = true
      void deliverNotices(runtime).finally(() => {
        delivering = false
      })
    }
    deliver()
    const stopNotices = useSessionNotices.subscribe(deliver)
    const stopThread = runtime.thread.subscribe(deliver)
    return () => {
      stopNotices()
      stopThread()
    }
  }, [runtime])
}
