// SOURCING: none — bun:test over ./deliver with a stub thread shaped like assistant-ui's thread runtime
import { beforeEach, describe, expect, test } from 'bun:test'
import type { ThreadMessage } from '@assistant-ui/react'
import {
  registerRunInputQueue,
  useRunInputs,
} from '@/lib/theorem/run-input-store'
import { createRunInputQueue } from '@/lib/theorem/run-input'
import type { InputReceipt } from '@/lib/theorem/run-input'
import { assistant } from '../conversation/test-runtime'
import { deliverNotices, startSessionNoticeDelivery } from './deliver'
import { noticeText, useSessionNotices } from './sessions'
import type { SessionNotice } from './sessions'

const notice = (runId: string, session = 't1'): SessionNotice => ({
  runId,
  session,
  what: 'Claude Code (Herdr)',
  state: 'finished',
})

function thread(
  messages: ThreadMessage[],
  isRunning = false,
  id = 'local-thread',
  remoteId?: string,
) {
  const appended: unknown[] = []
  const listeners = new Set<() => void>()
  return {
    appended,
    runtime: {
      threads: {
        mainItem: {
          getState: () => ({ id, remoteId }),
          subscribe: (listener: () => void) => {
            listeners.add(listener)
            return () => listeners.delete(listener)
          },
        },
      },
      thread: {
        getState: () => ({ messages, isRunning }),
        append: (message: unknown) => void appended.push(message),
        subscribe: (listener: () => void) => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
      },
    },
  }
}

beforeEach(() => useSessionNotices.setState({ pending: [] }))

describe('deliverNotices', () => {
  test('an idle chat holding the run is told in a new turn, and the notice is gone', async () => {
    useSessionNotices.setState({ pending: [notice('run1')] })
    const t = thread([assistant('a1', 'started it', { runId: 'run1' })])
    await deliverNotices(t.runtime, async () => {
      throw new Error('no input while idle')
    })
    expect(t.appended).toHaveLength(1)
    expect(JSON.stringify(t.appended[0])).toContain(
      'Claude Code (Herdr) (t1) finished its work',
    )
    expect(useSessionNotices.getState().pending).toEqual([])
  })

  test('a working chat is told through its run, not a new turn', async () => {
    useSessionNotices.setState({ pending: [notice('run1')] })
    const t = thread(
      [
        assistant('a1', 'started it', { runId: 'run1' }),
        assistant('a2', 'still going', { runId: 'run2' }),
      ],
      true,
    )
    const inputs: { runId: string; text: string }[] = []
    await deliverNotices(t.runtime, async (runId, text) => {
      inputs.push({ runId, text })
      return { inputId: 'notice-input', text, status: 'delivered' }
    })
    expect(t.appended).toEqual([])
    expect(inputs.map((i) => i.runId)).toEqual(['run2'])
    expect(useSessionNotices.getState().pending).toEqual([])
  })

  test('a notice for a run another chat holds waits for that chat', async () => {
    useSessionNotices.setState({ pending: [notice('elsewhere')] })
    const t = thread([assistant('a1', 'x', { runId: 'run1' })])
    await deliverNotices(t.runtime, async () => undefined)
    expect(t.appended).toEqual([])
    expect(useSessionNotices.getState().pending).toHaveLength(1)
  })

  test('several notices for the chat go in one turn', async () => {
    useSessionNotices.setState({
      pending: [notice('run1', 't1'), notice('run1', 'side-2')],
    })
    const t = thread([assistant('a1', 'x', { runId: 'run1' })])
    await deliverNotices(t.runtime, async () => undefined)
    expect(t.appended).toHaveLength(1)
    expect(JSON.stringify(t.appended[0])).toContain('side-2')
  })

  test('a failed delivery keeps the notice for the next try', async () => {
    useSessionNotices.setState({ pending: [notice('run1')] })
    const t = thread([assistant('a1', 'x', { runId: 'run1' })], true)
    await deliverNotices(t.runtime, async () => {
      throw new Error('offline')
    })
    expect(useSessionNotices.getState().pending).toHaveLength(1)
  })

  test('an accepted input is kept until its receipt says the run read it', async () => {
    const original = notice('run1')
    useSessionNotices.setState({ pending: [original] })
    const t = thread(
      [assistant('a1', 'x', { runId: 'run1' })],
      true,
      'local-thread',
      'stored-thread',
    )
    const receipt: InputReceipt = {
      inputId: 'notice-input',
      text: '',
      status: 'queued',
    }
    const keys: string[] = []
    const queue = createRunInputQueue({
      snapshot: () => ({
        threadId: 'stored-thread',
        runId: 'run1',
        isRunning: true,
        isLoading: false,
        inputs: [],
      }),
      refresh: async () => ({
        active: true,
        runId: 'run1',
        inputs: [],
      }),
      send: async () => receipt,
      receipts: async () => [],
      append: () => {},
      changed: () => {},
      describeError: (error) => String(error),
    })
    const stop = registerRunInputQueue('local-thread', queue)
    try {
      await deliverNotices(t.runtime, async (_runId, text, key) => {
        keys.push(key)
        receipt.text = text
        queue.submit(text, key)
        await new Promise((resolve) => setTimeout(resolve, 0))
        return receipt
      })
      expect(useSessionNotices.getState().pending).toEqual([original])
      expect(t.appended).toEqual([])

      useRunInputs.setState({
        'local-thread': [{ id: keys[0]!, text: receipt.text, state: 'queued' }],
      })
      await deliverNotices(t.runtime, async () => {
        throw new Error('the same notice must not be sent twice')
      })
      expect(useSessionNotices.getState().pending).toEqual([original])

      useRunInputs.setState({ 'local-thread': [] })
      t.runtime.thread.getState = () => ({
        messages: [assistant('a1', 'x', { runId: 'run1' })],
        isRunning: false,
      })
      await deliverNotices(t.runtime)
      expect(useSessionNotices.getState().pending).toEqual([])
    } finally {
      stop()
      queue.dispose()
      useRunInputs.setState({ 'local-thread': undefined })
    }
  })

  test('a run that ended before reading the notice wakes the chat in one new turn', async () => {
    const original = notice('run1')
    useSessionNotices.setState({ pending: [original] })
    let running = true
    let storedInputs: readonly InputReceipt[] = []
    let receipt: InputReceipt = {
      inputId: 'notice-input',
      text: '',
      status: 'queued',
    }
    const t = thread([assistant('a1', 'x', { runId: 'run1' })])
    t.runtime.thread.getState = () => ({
      messages: [assistant('a1', 'x', { runId: 'run1' })],
      isRunning: running,
    })
    const queue = createRunInputQueue({
      snapshot: () => ({
        threadId: 'stored-thread',
        runId: running ? 'run1' : undefined,
        isRunning: running,
        isLoading: false,
        inputs: storedInputs,
      }),
      refresh: async () => ({
        active: running,
        runId: running ? 'run1' : undefined,
        inputs: storedInputs,
      }),
      send: async (_runId, text) => {
        receipt = { ...receipt, text }
        return receipt
      },
      receipts: async () => [
        { ...receipt, status: 'not_delivered', reason: 'run_ended' },
      ],
      append: (text) => t.runtime.thread.append({ role: 'user', text }),
      changed: () => {},
      describeError: (error) => String(error),
    })
    const stop = registerRunInputQueue('local-thread', queue)
    try {
      await deliverNotices(t.runtime, async (_runId, text, key) => {
        queue.submit(text, key)
        await new Promise((resolve) => setTimeout(resolve, 0))
        return receipt
      })
      expect(useSessionNotices.getState().pending).toEqual([original])
      running = false
      storedInputs = [
        { ...receipt, status: 'not_delivered', reason: 'run_ended' },
      ]
      queue.observe()
      await new Promise((resolve) => setTimeout(resolve, 0))
      await deliverNotices(t.runtime)
      expect(t.appended).toHaveLength(1)
      expect(JSON.stringify(t.appended[0])).toContain('finished its work')
      expect(useSessionNotices.getState().pending).toEqual([])
    } finally {
      stop()
      queue.dispose()
      useRunInputs.setState({ 'local-thread': undefined })
    }
  })

  test('a new notice arriving during settlement is delivered after the first request finishes', async () => {
    const first = notice('run1', 't1')
    const second = notice('run1', 't2')
    useSessionNotices.setState({ pending: [first] })
    const t = thread([assistant('a1', 'x', { runId: 'run1' })], true)
    let finish!: () => void
    const pending = new Promise<void>((resolve) => {
      finish = resolve
    })
    let calls = 0
    const delivery = startSessionNoticeDelivery(t.runtime, async () => {
      calls += 1
      if (calls === 1) await pending
      return {
        inputId: `input-${calls}`,
        text: noticeText(useSessionNotices.getState().pending),
        status: 'delivered',
      }
    })
    try {
      useSessionNotices.setState({ pending: [second] })
      finish()
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(calls).toBe(2)
      expect(useSessionNotices.getState().pending).toEqual([])
    } finally {
      delivery()
    }
  })
})
