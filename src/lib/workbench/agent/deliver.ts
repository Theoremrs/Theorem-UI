// SOURCING: assistant-ui's thread runtime and the chat's existing run-input queue. The queue owns delivery receipts and the confirmed next-turn fallback; this module retains the notices until that queue settles them.
import { useEffect } from 'react'
import type { ThreadMessage } from '@assistant-ui/react'
import { sendRunInput } from '@/lib/theorem/run-input-runtime'
import { inputReceipt } from '@/lib/theorem/run-input'
import type { InputReceipt } from '@/lib/theorem/run-input'
import { observeRunInput, useRunInputs } from '@/lib/theorem/run-input-store'
import { runIdOf } from '../conversation/transcript'
import { noticeText, useSessionNotices } from './sessions'
import type { SessionNotice } from './sessions'

interface ChatThread {
  readonly threads: {
    readonly mainItem: {
      getState: () => { readonly id: string }
      subscribe: (callback: () => void) => () => void
    }
  }
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

type SendInput = (
  runId: string,
  text: string,
  key: string,
) => Promise<InputReceipt | void>

type NoticeDelivery = {
  readonly threadKey: string
  readonly notices: readonly SessionNotice[]
  readonly key: string
}

const deliveries = new Map<string, NoticeDelivery>()

const forget = (notices: readonly SessionNotice[]) => {
  const keys = new Set(
    [...deliveries.entries()]
      .filter(([, delivery]) =>
        delivery.notices.some((notice) => notices.includes(notice)),
      )
      .map(([key]) => key),
  )
  for (const key of keys) deliveries.delete(key)
  useSessionNotices.setState((state) => ({
    pending: state.pending.filter((notice) => !notices.includes(notice)),
  }))
}

export function clearSessionNotices() {
  deliveries.clear()
  useSessionNotices.setState({ pending: [] })
}

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
  const threadKey = runtime.threads.mainItem.getState().id
  const waiting = useRunInputs.getState()[threadKey] ?? []
  const settled: SessionNotice[] = []
  const unconfirmed = new Set<SessionNotice>()
  for (const [key, delivery] of deliveries) {
    if (delivery.threadKey !== threadKey) continue
    const present = delivery.notices.filter((notice) =>
      useSessionNotices.getState().pending.includes(notice),
    )
    if (present.length === 0) {
      deliveries.delete(key)
      continue
    }
    if (waiting.some((item) => item.id === key)) {
      for (const notice of present) unconfirmed.add(notice)
      continue
    }
    const text = noticeText(delivery.notices)
    const local = runtime.thread
      .getState()
      .messages.some(
        (message) =>
          message.role === 'user' &&
          message.content.some(
            (part) => part.type === 'text' && part.text === text,
          ),
      )
    if (local || !isRunning) {
      settled.push(...present)
      deliveries.delete(key)
    } else {
      for (const notice of present) unconfirmed.add(notice)
    }
  }
  if (settled.length) forget(settled)
  const fresh = mine.filter(
    (notice) => !unconfirmed.has(notice) && !settled.includes(notice),
  )
  if (fresh.length === 0) return
  const text = noticeText(fresh)
  const working = isRunning ? runs.at(-1) : undefined
  if (!working) {
    try {
      runtime.thread.append({ role: 'user', content: [{ type: 'text', text }] })
      forget(fresh)
    } catch (error) {
      console.warn('The workbench could not tell the chat', error)
    }
    return
  }
  const key = `workbench-notice:${crypto.randomUUID()}`
  deliveries.set(key, { threadKey, notices: fresh, key })
  try {
    const receipt = inputReceipt(await sendInput(working, text, key))
    if (receipt?.status === 'delivered') {
      deliveries.delete(key)
      forget(fresh)
    } else if (receipt?.status === 'not_delivered') {
      deliveries.delete(key)
      if (!runtime.thread.getState().isRunning) {
        runtime.thread.append({
          role: 'user',
          content: [{ type: 'text', text }],
        })
        forget(fresh)
      }
    }
  } catch (error) {
    console.warn('The workbench could not tell the chat', error)
  }
}

export function startSessionNoticeDelivery(
  runtime: ChatThread & {
    thread: { subscribe: (callback: () => void) => () => void }
  },
  sendInput: SendInput = sendRunInput,
) {
  let delivering = false
  let again = false
  let stopped = false
  const pending = () => again && !stopped
  const deliver = () => {
    if (stopped) return
    if (delivering) {
      again = true
      return
    }
    delivering = true
    void (async () => {
      do {
        again = false
        observeRunInput(runtime.threads.mainItem.getState().id)
        await deliverNotices(runtime, sendInput)
      } while (pending())
    })().finally(() => {
      delivering = false
      if (pending()) deliver()
    })
  }
  deliver()
  const stopNotices = useSessionNotices.subscribe(deliver)
  const stopThread = runtime.thread.subscribe(deliver)
  const stopInputs = useRunInputs.subscribe(deliver)
  const stopItem = runtime.threads.mainItem.subscribe(deliver)
  return () => {
    stopped = true
    stopNotices()
    stopThread()
    stopInputs()
    stopItem()
  }
}

/** Delivers notices to this chat whenever one arrives or the chat changes. */
export function useSessionNoticeDelivery(
  runtime: ChatThread & {
    thread: { subscribe: (callback: () => void) => () => void }
  },
) {
  useEffect(() => startSessionNoticeDelivery(runtime), [runtime])
}
