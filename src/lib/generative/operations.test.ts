import { beforeEach, describe, expect, test } from 'bun:test'
import type { ThreadMessage } from '@assistant-ui/react'
import {
  GENERATIVE_OPERATIONS,
  PRESENT,
  presentRequestsOf,
  resetPresentRequests,
  servePresentRequests,
} from './operations'
import type { PresentReceipt, PresentRequest } from './operations'

const request = (
  args: Record<string, unknown>,
  requestRef = 'ref_1',
): PresentRequest => ({
  runId: 'run_1',
  requestRef,
  args,
  expectedRevision: 3,
})

/** An assistant message carrying one pending present operation. */
const message = (args: Record<string, unknown>): ThreadMessage =>
  ({
    id: 'm1',
    role: 'assistant',
    status: { type: 'running' },
    metadata: { custom: { theoremRunId: 'run_1' } },
    content: [
      {
        type: 'data',
        name: 'theorem-client_operation',
        data: {
          requestRef: 'ref_1',
          operation: PRESENT,
          state: 'pending',
          args,
          expectedRevision: 3,
        },
      },
    ],
  }) as unknown as ThreadMessage

describe('present requests', () => {
  beforeEach(() => resetPresentRequests())

  test('the declared schema fits the server\'s 8 KB cap', () => {
    const schema = GENERATIVE_OPERATIONS[0].inputSchema
    expect(Buffer.byteLength(JSON.stringify(schema))).toBeLessThan(8 * 1024)
    expect(GENERATIVE_OPERATIONS[0].effect).toBe('presentation')
  })

  test('only a live turn\'s pending present calls are read', () => {
    const tree = { _type: 'Card' }
    expect(presentRequestsOf([message(tree)], true)).toHaveLength(1)
    expect(presentRequestsOf([message(tree)], false)).toHaveLength(0)
  })

  test('a paintable tree is applied once, with the revision the run expected', async () => {
    const posted: Array<PresentReceipt> = []
    const post = (_: PresentRequest, receipt: PresentReceipt) => {
      posted.push(receipt)
      return Promise.resolve()
    }
    const asked = request({ _type: 'Card', children: 'hello' })
    await servePresentRequests([asked], post)
    await servePresentRequests([asked], post)
    expect(posted).toHaveLength(1)
    expect(posted[0]).toMatchObject({
      outcome: 'applied',
      revision: 3,
      result: { painted: 'Card' },
    })
  })

  test('a tree whose root names no component is refused plainly', async () => {
    const posted: Array<PresentReceipt> = []
    const post = (_: PresentRequest, receipt: PresentReceipt) => {
      posted.push(receipt)
      return Promise.resolve()
    }
    await servePresentRequests([request({ _type: 'NoSuchComponent' })], post)
    expect(posted[0]?.outcome).toBe('rejected')
    expect(posted[0]?.reason).toContain('_type')
  })
})
