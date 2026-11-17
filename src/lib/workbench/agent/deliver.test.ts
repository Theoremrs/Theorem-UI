// SOURCING: none — bun:test over ./deliver with a stub thread shaped like assistant-ui's thread runtime
import { beforeEach, describe, expect, test } from 'bun:test'
import type { ThreadMessage } from '@assistant-ui/react'
import { assistant } from '../conversation/test-runtime'
import { deliverNotices } from './deliver'
import { useSessionNotices } from './sessions'
import type { SessionNotice } from './sessions'

const notice = (runId: string, session = 't1'): SessionNotice => ({
  runId,
  session,
  what: 'Claude Code (Herdr)',
  state: 'finished',
})

function thread(messages: ThreadMessage[], isRunning = false) {
  const appended: unknown[] = []
  return {
    appended,
    runtime: {
      thread: {
        getState: () => ({ messages, isRunning }),
        append: (message: unknown) => void appended.push(message),
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
})
