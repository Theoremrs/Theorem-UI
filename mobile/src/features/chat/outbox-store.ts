// SOURCING: expo-sqlite through local-db.ts (one autocommit statement per write); the same narrow database type the other stores use, so tests run on bun:sqlite
//
// Messages waiting in the outbox survive termination here, under the command id
// they will be sent with. A row is the words the person queued and whether their
// last send had no definite answer. It never holds a credential, and it is
// cleared with the account (local-db.ts). The SDK journal owns a send once it is
// admitted; this store owns the words while they wait.
import type { QueuedMessage } from './queue'

/** The subset of expo-sqlite the store uses, so tests can supply their own. */
export type OutboxDatabase = {
  getAllSync<T>(sql: string, params: (string | number)[]): T[]
  runSync(sql: string, params: (string | number)[]): unknown
}

export type OutboxStore = {
  /** Every thread's waiting messages, in the order they will go. */
  load(): { threadId: string; items: QueuedMessage[] }[]
  /** Replaces one thread's waiting messages. Synchronous: durable before it returns. */
  save(threadId: string, items: QueuedMessage[]): void
  /** Signing out: nothing queued under one account may reach another. */
  clear(): void
}

type Row = { thread_id: string; id: string; text: string; uncertain: number; position: number }

export function createOutboxStore(database: OutboxDatabase): OutboxStore {
  return {
    load() {
      const rows = database.getAllSync<Row>(
        'SELECT thread_id, id, text, uncertain, position FROM outbox_message ORDER BY thread_id, position',
        [],
      )
      const byThread = new Map<string, QueuedMessage[]>()
      for (const row of rows) {
        const items = byThread.get(row.thread_id) ?? []
        items.push({ id: row.id, text: row.text, ...(row.uncertain ? { uncertain: true } : {}) })
        byThread.set(row.thread_id, items)
      }
      return [...byThread].map(([threadId, items]) => ({ threadId, items }))
    },
    save(threadId, items) {
      database.runSync('DELETE FROM outbox_message WHERE thread_id = ?', [threadId])
      items.forEach((item, position) => {
        database.runSync(
          'INSERT INTO outbox_message (thread_id, id, text, uncertain, position, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
          [threadId, item.id, item.text, item.uncertain ? 1 : 0, position, Date.now()],
        )
      })
    },
    clear() {
      database.runSync('DELETE FROM outbox_message', [])
    },
  }
}
