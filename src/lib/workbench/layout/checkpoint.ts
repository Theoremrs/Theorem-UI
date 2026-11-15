// SOURCING: @rustyreddb/browser (the graph database, in a dedicated worker, on the origin private
// file system), through the worker entry the app already bundles for its App databases
// (src/lib/blocks/app-db.worker.ts). The App wiring (src/lib/blocks/app-db.ts) is not reused as a
// whole: it opens with keepHistory false, which docs/plans/theo-workbench/technical-requirements.md
// R15 forbids reusing blindly, and it only exports `openInMemory`. What this file adds is the
// durability outcome the package does not give: a write that returned is `accepted`, and each
// failure the package or its wasm names is mapped to refused, uncertain or failed.

import type { Database } from '@rustyreddb/browser'
import { reason as readableReason } from '../environment/workspace-recovery'
import type { Outcome } from '../environment/result'
import type { LayoutDocument } from './layout'

/** The device-local copy of a workspace's workbench: what was last kept here, and the revision it was based on. */
export interface Checkpoint {
  /** The shared record's revision this document was edited from. */
  baseRevision: number
  document: LayoutDocument
  savedAtMs: number
}

/** What a checkpoint needs of an open database; `@rustyreddb/browser`'s `Database` is one. */
export type CheckpointDatabase = Pick<Database, 'getNode' | 'mutate' | 'close'>

export type OpenCheckpointDatabase = (
  directory: string,
) => Promise<CheckpointDatabase>

export interface Checkpoints {
  read: (workspaceId: string) => Promise<Outcome<Checkpoint | undefined>>
  /** `accepted` means the database committed it: durable on this device, and nothing about the shared record. */
  write: (
    workspaceId: string,
    checkpoint: Omit<Checkpoint, 'savedAtMs'>,
  ) => Promise<Outcome<{ savedAtMs: number }>>
  clear: (workspaceId: string) => Promise<Outcome<undefined>>
  /** Closes the database if this module opened it. Later calls open it again. */
  dispose: () => Promise<void>
}

const LABEL = 'WorkbenchCheckpoint'
const nodeId = (workspaceId: string) =>
  `theorem-workbench:checkpoint:${workspaceId}`

/**
 * The directory of the checkpoint database for one account, in the origin private file system.
 * The workbench record is tenant-scoped on the server, so the device copy is scoped the same way.
 */
export function checkpointDirectory(accountId: string): string {
  return `theorem-workbench.${accountId.replace(/[^A-Za-z0-9_-]/g, '_')}`
}

/**
 * The shared database in a worker. One page holds the file and the other tabs reach it through
 * that page, so panes and tabs never compete as writers (R16). History is kept: this is not App data.
 */
export const openInBrowser: OpenCheckpointDatabase = async (directory) => {
  const [{ open }, { default: wasm }] = await Promise.all([
    import('@rustyreddb/browser'),
    import('@rustyreddb/browser/rustyred.wasm?url'),
  ])
  return open(directory, {
    shared: true,
    wasm,
    worker: () =>
      new Worker(new URL('../../blocks/app-db.worker.ts', import.meta.url), {
        type: 'module',
      }),
  })
}

interface Tagged {
  code?: unknown
  message?: unknown
}

/**
 * Names from the package's errors and the wasm's strings (gate-0 owners-documents-and-persistence 9).
 * A refusal changed nothing; an unknown commit state is uncertain; anything else failed.
 */
export function storageOutcome(error: unknown): Outcome<never> {
  const tagged: Tagged = error && typeof error === 'object' ? error : {}
  const text = `${String(tagged.code ?? '')} ${String(tagged.message ?? error)}`
  const why = readableReason(error)
  if (/quota/i.test(text)) {
    return { outcome: 'refused', code: 'storage_quota_exceeded', reason: why }
  }
  if (text.includes('chunk_store_browser_payload_too_large')) {
    return { outcome: 'refused', code: 'checkpoint_too_large', reason: why }
  }
  if (text.includes('chunk_store_browser_commit_state_unknown')) {
    return { outcome: 'uncertain', reason: why }
  }
  if (
    text.includes('chunk_store_browser_storage') ||
    text.includes('database_closed')
  ) {
    return { outcome: 'refused', code: 'storage_unavailable', reason: why }
  }
  return { outcome: 'failed', reason: why }
}

export function createCheckpoints(options: {
  /** From `checkpointDirectory`. */
  directory: string
  open?: OpenCheckpointDatabase
  now?: () => number
}): Checkpoints {
  const open = options.open ?? openInBrowser
  const now = options.now ?? Date.now
  let database: Promise<CheckpointDatabase> | undefined

  /** A failed open is not kept: the next call tries again. */
  function opened(): Promise<CheckpointDatabase> {
    if (!database) {
      const attempt = open(options.directory)
      database = attempt
      attempt.catch(() => {
        if (database === attempt) database = undefined
      })
    }
    return database
  }

  return {
    async read(workspaceId) {
      try {
        const node = await (await opened()).getNode(nodeId(workspaceId))
        if (!node) return { outcome: 'accepted', value: undefined }
        const { baseRevision, document, savedAtMs } = node.properties
        if (
          typeof baseRevision !== 'number' ||
          typeof document !== 'string' ||
          typeof savedAtMs !== 'number'
        ) {
          return {
            outcome: 'failed',
            reason:
              'The local checkpoint is not in the shape this version writes',
          }
        }
        return {
          outcome: 'accepted',
          value: {
            baseRevision,
            document: JSON.parse(document) as LayoutDocument,
            savedAtMs,
          },
        }
      } catch (error) {
        return storageOutcome(error)
      }
    },

    async write(workspaceId, checkpoint) {
      const savedAtMs = now()
      try {
        const db = await opened()
        await db.mutate({
          upsertNodes: [
            {
              id: nodeId(workspaceId),
              labels: [LABEL],
              properties: {
                workspaceId,
                baseRevision: checkpoint.baseRevision,
                document: JSON.stringify(checkpoint.document),
                savedAtMs,
              },
            },
          ],
        })
        return { outcome: 'accepted', value: { savedAtMs } }
      } catch (error) {
        return storageOutcome(error)
      }
    },

    async clear(workspaceId) {
      try {
        await (await opened()).mutate({ deleteNodes: [nodeId(workspaceId)] })
        return { outcome: 'accepted', value: undefined }
      } catch (error) {
        return storageOutcome(error)
      }
    },

    async dispose() {
      const held = database
      database = undefined
      if (!held) return
      try {
        await (await held).close()
      } catch {
        // The database was never open, or is already closed.
      }
    },
  }
}
