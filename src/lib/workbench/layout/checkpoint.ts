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
  name?: unknown
  code?: unknown
  message?: unknown
}

/** A record that was read but is not what this version writes. Refused, never papered over. */
export class CorruptRecord extends Error {
  constructor(what: string) {
    super(what)
    this.name = 'CorruptRecord'
  }
}

/**
 * Names from the package's errors, the wasm's strings (gate-0 owners-documents-and-persistence 9) and
 * the browser's own DOMException names. A refusal changed nothing; an unknown commit state is
 * uncertain; anything else failed. The codes are what a panel can show:
 * `storage_quota_exceeded`, `storage_denied`, `storage_blocked`, `storage_unavailable`,
 * `checkpoint_too_large`, `checkpoint_corrupt`, `account_changed`.
 */
export function storageOutcome(error: unknown): Outcome<never> {
  const tagged: Tagged = error && typeof error === 'object' ? error : {}
  const name = String(tagged.name ?? '')
  const text = `${name} ${String(tagged.code ?? '')} ${String(tagged.message ?? error)}`
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
    name === 'CorruptRecord' ||
    /corrupt|checksum|malformed/i.test(String(tagged.message ?? ''))
  ) {
    return { outcome: 'refused', code: 'checkpoint_corrupt', reason: why }
  }
  if (
    /^(SecurityError|NotAllowedError)\b/.test(name) ||
    /permission denied|not allowed/i.test(text)
  ) {
    return { outcome: 'refused', code: 'storage_denied', reason: why }
  }
  if (name === 'NoModificationAllowedError' || /\bblocked\b/i.test(text)) {
    return { outcome: 'refused', code: 'storage_blocked', reason: why }
  }
  if (
    /^(NotSupportedError|InvalidStateError|NotFoundError)\b/.test(name) ||
    text.includes('chunk_store_browser_storage') ||
    text.includes('database_closed') ||
    /getDirectory|not supported|unsupported/i.test(text)
  ) {
    return { outcome: 'refused', code: 'storage_unavailable', reason: why }
  }
  return { outcome: 'failed', reason: why }
}

/** One record in the account's local database. `properties` are what the node carries beside the account. */
export type StoredRecord = Record<string, string | number | boolean>

/**
 * The account's database, opened once and shared (see `openInBrowser`): reads, writes and clears of
 * one node each, every one answered with an `Outcome`, so no caller can mistake a thrown error for a save.
 */
export interface LocalStore {
  read: (id: string) => Promise<Outcome<StoredRecord | undefined>>
  /** `accepted` means the database committed it: durable on this device, and nothing about any shared record. */
  write: (
    label: string,
    id: string,
    properties: StoredRecord,
  ) => Promise<Outcome<undefined>>
  clear: (id: string) => Promise<Outcome<undefined>>
  /**
   * The account that owned this store is gone: close the database and refuse every later call as
   * `account_changed`. What was kept stays on disk under that account's directory, unread.
   */
  retire: (reason: string) => Promise<void>
  /** Closes the database if this store opened it. Later calls open it again. */
  dispose: () => Promise<void>
}

export function createLocalStore(options: {
  /** From `checkpointDirectory`. */
  directory: string
  /**
   * The account this store belongs to. It is written into every record and checked on every read, so a
   * record that reached this directory from another account is refused as `wrong_account`, not shown.
   */
  account?: string
  open?: OpenCheckpointDatabase
}): LocalStore {
  const open = options.open ?? openInBrowser
  const { account } = options
  let database: Promise<CheckpointDatabase> | undefined
  let retired: string | undefined

  const gone = (): Outcome<never> | undefined =>
    retired === undefined
      ? undefined
      : { outcome: 'refused', code: 'account_changed', reason: retired }

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

  async function dispose() {
    const held = database
    database = undefined
    if (!held) return
    try {
      await (await held).close()
    } catch {
      // The database was never open, or is already closed.
    }
  }

  return {
    async read(id) {
      const stopped = gone()
      if (stopped) return stopped
      try {
        const node = await (await opened()).getNode(id)
        if (!node) return { outcome: 'accepted', value: undefined }
        const { accountId, ...rest } = node.properties
        if (account !== undefined && accountId !== account) {
          return {
            outcome: 'refused',
            code: 'wrong_account',
            reason: 'This record belongs to another account',
          }
        }
        return { outcome: 'accepted', value: rest as StoredRecord }
      } catch (error) {
        return storageOutcome(error)
      }
    },

    async write(label, id, properties) {
      const stopped = gone()
      if (stopped) return stopped
      try {
        const db = await opened()
        await db.mutate({
          upsertNodes: [
            {
              id,
              labels: [label],
              properties: {
                ...properties,
                ...(account !== undefined ? { accountId: account } : {}),
              },
            },
          ],
        })
        return { outcome: 'accepted', value: undefined }
      } catch (error) {
        return storageOutcome(error)
      }
    },

    async clear(id) {
      const stopped = gone()
      if (stopped) return stopped
      try {
        await (await opened()).mutate({ deleteNodes: [id] })
        return { outcome: 'accepted', value: undefined }
      } catch (error) {
        return storageOutcome(error)
      }
    },

    async retire(reason) {
      retired = reason
      await dispose()
    },

    dispose,
  }
}

export function createCheckpoints(options: {
  /** From `checkpointDirectory`. */
  directory: string
  /** The signed-in account: see `createLocalStore`. Absent, records are not account-checked. */
  account?: string
  open?: OpenCheckpointDatabase
  now?: () => number
  /** Share one store with other owners of the same account (the document drafts). */
  store?: LocalStore
}): Checkpoints {
  const now = options.now ?? Date.now
  const store = options.store ?? createLocalStore(options)

  return {
    async read(workspaceId) {
      const done = await store.read(nodeId(workspaceId))
      if (done.outcome !== 'accepted' || !done.value) {
        return done as Outcome<undefined>
      }
      const { baseRevision, document, savedAtMs } = done.value
      if (
        typeof baseRevision !== 'number' ||
        typeof document !== 'string' ||
        typeof savedAtMs !== 'number'
      ) {
        return storageOutcome(
          new CorruptRecord(
            'The local checkpoint is not in the shape this version writes',
          ),
        )
      }
      try {
        return {
          outcome: 'accepted',
          value: {
            baseRevision,
            document: JSON.parse(document) as LayoutDocument,
            savedAtMs,
          },
        }
      } catch {
        return storageOutcome(
          new CorruptRecord('The local checkpoint is not readable JSON'),
        )
      }
    },

    async write(workspaceId, checkpoint) {
      const savedAtMs = now()
      const done = await store.write(LABEL, nodeId(workspaceId), {
        workspaceId,
        baseRevision: checkpoint.baseRevision,
        document: JSON.stringify(checkpoint.document),
        savedAtMs,
      })
      return done.outcome === 'accepted'
        ? { outcome: 'accepted', value: { savedAtMs } }
        : done
    },

    clear: (workspaceId) => store.clear(nodeId(workspaceId)),

    dispose: () => store.dispose(),
  }
}
