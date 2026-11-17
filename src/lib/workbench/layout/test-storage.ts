// SOURCING: none — test doubles for ./checkpoint: an in-memory database with the methods of
// `@rustyreddb/browser`'s `Database` that the local store calls, switches that make each of its
// operations throw what the browser or the wasm throws, and a Web Locks manager with the platform's
// queueing rules, so the package's own shared-database protocol can run in a test.

import type { Node } from '@rustyreddb/browser'
import type { CheckpointDatabase } from './checkpoint'

/** What a thrown browser error looks like: a DOMException's `name` carries the kind, its message may not. */
export function domError(name: string, message = ''): Error {
  const error = new Error(message)
  error.name = name
  return error
}

export interface MemoryDatabase extends CheckpointDatabase {
  nodes: Map<string, Node>
  /** What the next `mutate` throws; kept until cleared. */
  failWrite: unknown
  /** What the next `getNode` throws; kept until cleared. */
  failRead: unknown
  closed: number
}

export function memoryDatabase(
  nodes: Map<string, Node> = new Map(),
): MemoryDatabase {
  const database: MemoryDatabase = {
    nodes,
    closed: 0,
    failWrite: undefined,
    failRead: undefined,
    async getNode(id: string) {
      if (database.failRead) throw database.failRead
      return nodes.get(id) ?? null
    },
    async mutate(batch: { upsertNodes?: Node[]; deleteNodes?: string[] }) {
      if (database.failWrite) throw database.failWrite
      for (const id of batch.deleteNodes ?? []) nodes.delete(id)
      for (const node of batch.upsertNodes ?? []) nodes.set(node.id, node)
      return { txnId: nodes.size, graphVersion: nodes.size }
    },
    async close() {
      database.closed += 1
    },
  }
  return database
}

interface Waiter {
  mode: 'exclusive' | 'shared'
  run: () => void
}

/**
 * `navigator.locks` with the platform's rules: an exclusive request waits for every earlier holder, a
 * shared one only for an exclusive holder, in request order; an aborted request that is still waiting
 * rejects. Install with `Object.defineProperty(navigator, 'locks', { value: fakeLocks() })`.
 */
export function fakeLocks() {
  const names = new Map<
    string,
    { holders: Waiter['mode'][]; queue: Waiter[] }
  >()
  const state = (name: string) => {
    let entry = names.get(name)
    if (!entry) {
      entry = { holders: [], queue: [] }
      names.set(name, entry)
    }
    return entry
  }
  const grantable = (holders: Waiter['mode'][], mode: Waiter['mode']) =>
    mode === 'exclusive' ? holders.length === 0 : !holders.includes('exclusive')
  const drain = (name: string) => {
    const entry = state(name)
    while (entry.queue[0] && grantable(entry.holders, entry.queue[0].mode)) {
      entry.queue.shift()!.run()
    }
  }
  return {
    request(
      name: string,
      options: { mode?: Waiter['mode']; signal?: AbortSignal },
      callback: () => unknown,
    ): Promise<unknown> {
      const mode = options.mode ?? 'exclusive'
      const entry = state(name)
      return new Promise((resolve, reject) => {
        const waiter: Waiter = {
          mode,
          run: () => {
            entry.holders.push(mode)
            Promise.resolve()
              .then(callback)
              .then(resolve, reject)
              .finally(() => {
                entry.holders.splice(entry.holders.indexOf(mode), 1)
                drain(name)
              })
          },
        }
        options.signal?.addEventListener('abort', () => {
          const at = entry.queue.indexOf(waiter)
          if (at >= 0) {
            entry.queue.splice(at, 1)
            reject(domError('AbortError', 'aborted'))
          }
        })
        entry.queue.push(waiter)
        drain(name)
      })
    },
  }
}
