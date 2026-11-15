// SOURCING: bun:test over ./sessions' query options: how often an open session graph is read again
import { expect, test } from 'bun:test'
import { sessionGraphQuery } from './sessions'
import type { SessionGraphRead } from './sessions'

const read = (activeRunId?: string): SessionGraphRead => ({
  schema: 'theorem-session-graph/1',
  scope: { kind: 'tree', treeId: 'root' },
  trees: [
    {
      schema: 'theorem-session-tree/1',
      treeId: 'root',
      originThreadId: 'root',
      mainThreadId: 'root',
      mainResolution: 'origin',
      revision: 0,
      nodes: [
        {
          threadId: 'root',
          title: 'Root',
          projectId: 'p',
          status: 'regular',
          createdAtMs: 1,
          depth: 0,
          isMain: true,
          isOrigin: true,
          inScope: true,
          ...(activeRunId ? { activeRunId } : {}),
        },
      ],
    },
  ],
  connections: [],
  artifacts: {},
  documents: {},
  tools: {},
  notServed: [],
})

const every = (data?: SessionGraphRead) =>
  (
    sessionGraphQuery({ kind: 'tree', treeId: 'root' })
      .refetchInterval as (query: {
      state: { data?: SessionGraphRead }
    }) => number
  )({ state: { data } })

test('an open graph is read again, sooner while a session is running', () => {
  expect(every(read('run-1'))).toBe(4_000)
  expect(every(read())).toBe(15_000)
  expect(every()).toBe(15_000)
})
