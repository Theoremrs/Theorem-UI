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

  test('the description fits the server\'s 1 KB cap and teaches View', () => {
    const { description } = GENERATIVE_OPERATIONS[0]
    expect(Buffer.byteLength(description)).toBeLessThanOrEqual(1024)
    for (const helper of ['linked', 'graph', 'tree', 'timeline', 'param'])
      expect(description).toContain(`views.${helper}(`)
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

  test('a tree whose root names a component outside the vocabulary is painted, with a warning', async () => {
    const posted: Array<PresentReceipt> = []
    const post = (_: PresentRequest, receipt: PresentReceipt) => {
      posted.push(receipt)
      return Promise.resolve()
    }
    await servePresentRequests([request({ _type: 'NoSuchComponent', label: 'x', value: 1 })], post)
    expect(posted[0]?.outcome).toBe('applied')
    expect(JSON.stringify(posted[0]?.result)).toContain('NoSuchComponent')
  })

  test('A2UI from any catalog is painted, and its surfaces named in the receipt', async () => {
    const posted: Array<PresentReceipt> = []
    const post = (_: PresentRequest, receipt: PresentReceipt) => {
      posted.push(receipt)
      return Promise.resolve()
    }
    const a2ui = [
      { version: 'v0.9', createSurface: { surfaceId: 's1', catalogId: 'https://agent.example/c.json' } },
      {
        version: 'v0.9',
        updateComponents: { surfaceId: 's1', components: [{ id: 'root', component: 'Dial', value: 3 }] },
      },
    ]
    await servePresentRequests([request({ a2ui })], post)
    expect(posted[0]).toMatchObject({ outcome: 'applied', result: { painted: 's1' } })
  })

  test('a view whose cells will fail is painted, and the receipt says which cell and why', async () => {
    const posted: Array<PresentReceipt> = []
    const post = (_: PresentRequest, receipt: PresentReceipt) => {
      posted.push(receipt)
      return Promise.resolve()
    }
    const cells = ['viewof k = Inputs.range([0, 1], {label: html`k ${kk}`})', 'Plot.dotX(data, {x: (d) => d * k}).plot()']
    await servePresentRequests([request({ _type: 'Card', children: [{ _type: 'View', cells }] })], post)
    expect(posted[0]?.outcome).toBe('applied')
    expect(JSON.stringify(posted[0]?.result)).toContain('Cell 1 reads `kk`, which no cell defines.')
  })

  test('a call with nothing to paint is refused plainly', async () => {
    const posted: Array<PresentReceipt> = []
    const post = (_: PresentRequest, receipt: PresentReceipt) => {
      posted.push(receipt)
      return Promise.resolve()
    }
    await servePresentRequests([request({ caption: 'nothing' })], post)
    expect(posted[0]?.outcome).toBe('rejected')
    expect(posted[0]?.reason).toContain('a2ui')
  })
})
