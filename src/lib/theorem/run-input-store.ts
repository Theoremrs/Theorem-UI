import { create } from 'zustand'
import type { PendingRunInput, RunInputQueue } from './run-input'

const queues = new Map<string, RunInputQueue>()
export const useRunInputs = create<
  Partial<Record<string, readonly PendingRunInput[]>>
>(() => ({}))

/** assistant-ui's local thread identity exists before its durable id does. */
export function registerRunInputQueue(threadKey: string, queue: RunInputQueue) {
  queues.set(threadKey, queue)
  useRunInputs.setState({ [threadKey]: queue.getSnapshot() })
  return () => {
    if (queues.get(threadKey) !== queue) return
    queues.delete(threadKey)
    useRunInputs.setState({ [threadKey]: undefined })
    queue.dispose()
  }
}

/**
 * Keeps `text` for the thread's working run. A caller that already names the message — the
 * workbench's composer mints a client id for every send, and the same id must never send
 * twice — gives it as `id`, so one message is kept and sent once however often it is offered.
 */
export const submitRunInput = (threadKey: string, text: string, id?: string) =>
  queues.get(threadKey)?.submit(text, id) ?? false

export const retryRunInput = (threadKey: string, id: string) =>
  queues.get(threadKey)?.retry(id)

export const stopRunInputs = (threadKey: string) =>
  queues.get(threadKey)?.stop()

export const dismissRunInput = (threadKey: string, id: string) =>
  queues.get(threadKey)?.dismiss(id)

export const observeRunInput = (threadKey: string) =>
  queues.get(threadKey)?.observe()
