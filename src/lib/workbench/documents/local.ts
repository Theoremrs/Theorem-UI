// SOURCING: ../layout/checkpoint (`createLocalStore`: @rustyreddb/browser's shared database, whose Web
// Lock and BroadcastChannel give one owner per account) holds the records; this file only says what a
// document draft record is and names its three states (SPEC-THEO-WEB-TERMINAL-WORKBENCH 11: draft,
// locally checkpointed, accepted). It adds no storage, locking or sync of its own.

import type { Outcome } from '../environment/result'
import { CorruptRecord, storageOutcome } from '../layout/checkpoint'
import type { LocalStore } from '../layout/checkpoint'
import type { PendingEdit } from './documents'

/** Why a draft is not (or may not be) on this device. `code` is the storage outcome's, or `no_local_store`. */
export interface LocalProblem {
  code: string
  reason: string
}

/**
 * Where the work the owner holds but the document authority has not accepted stands.
 * - `accepted`: there is no such work. Every edit this owner received is accepted by the authority at the revision shown.
 * - `draft`: there is, and no durable local copy of its current contents is confirmed. `problem` says why when a write failed.
 * - `checkpointed`: there is, and the local database committed a copy of exactly its current contents. `recovered` is true when
 *   the contents were read back from the device after a reload rather than made in this session.
 * `problem` can also ride on `accepted`: the local copy that is no longer needed could not be cleared.
 */
export type LocalState = (
  | { state: 'accepted' }
  | { state: 'draft' }
  | { state: 'checkpointed'; savedAtMs: number; recovered: boolean }
) & { problem?: LocalProblem }

/** What the device holds for one document: the edits the authority had not accepted, and the revision they were last known against. */
export interface Draft {
  path: string
  revision: number
  pending: PendingEdit[]
  savedAtMs: number
}

export interface DraftStore {
  read: (path: string) => Promise<Outcome<Draft | undefined>>
  write: (
    path: string,
    draft: Pick<Draft, 'revision' | 'pending'>,
  ) => Promise<Outcome<{ savedAtMs: number }>>
  clear: (path: string) => Promise<Outcome<undefined>>
}

const LABEL = 'WorkbenchDraft'
const nodeId = (workspaceId: string, path: string) =>
  `theorem-workbench:draft:${workspaceId}:${path}`

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

function pendingEdits(value: unknown): PendingEdit[] {
  if (!Array.isArray(value)) throw new CorruptRecord('The draft has no edits')
  return value.map((entry): PendingEdit => {
    if (
      !isObject(entry) ||
      typeof entry.operationId !== 'string' ||
      !isObject(entry.baseRevision) ||
      entry.baseRevision.scheme !== 'seq' ||
      typeof entry.baseRevision.value !== 'number' ||
      !Array.isArray(entry.edits) ||
      !entry.edits.every(
        (edit) =>
          isObject(edit) &&
          typeof edit.start === 'number' &&
          typeof edit.end === 'number' &&
          typeof edit.insert === 'string',
      )
    ) {
      throw new CorruptRecord(
        'A kept edit is not in the shape this version writes',
      )
    }
    return {
      operationId: entry.operationId,
      baseRevision: { scheme: 'seq', value: entry.baseRevision.value },
      edits: entry.edits as PendingEdit['edits'],
      state: 'restored',
    }
  })
}

export function createDraftStore(options: {
  store: LocalStore
  workspaceId: string
  now?: () => number
}): DraftStore {
  const { store, workspaceId } = options
  const now = options.now ?? Date.now
  return {
    async read(path) {
      const done = await store.read(nodeId(workspaceId, path))
      if (done.outcome !== 'accepted' || !done.value) {
        return done as Outcome<undefined>
      }
      const { revision, draft, savedAtMs } = done.value
      if (
        typeof revision !== 'number' ||
        typeof draft !== 'string' ||
        typeof savedAtMs !== 'number'
      ) {
        return storageOutcome(
          new CorruptRecord(
            'The local draft is not in the shape this version writes',
          ),
        )
      }
      try {
        return {
          outcome: 'accepted',
          value: {
            path,
            revision,
            pending: pendingEdits(JSON.parse(draft)),
            savedAtMs,
          },
        }
      } catch (error) {
        return storageOutcome(
          error instanceof CorruptRecord
            ? error
            : new CorruptRecord('The local draft is not readable JSON'),
        )
      }
    },

    async write(path, draft) {
      const savedAtMs = now()
      const done = await store.write(LABEL, nodeId(workspaceId, path), {
        workspaceId,
        path,
        revision: draft.revision,
        draft: JSON.stringify(
          draft.pending.map(({ operationId, baseRevision, edits }) => ({
            operationId,
            baseRevision,
            edits,
          })),
        ),
        savedAtMs,
      })
      return done.outcome === 'accepted'
        ? { outcome: 'accepted', value: { savedAtMs } }
        : done
    },

    clear: (path) => store.clear(nodeId(workspaceId, path)),
  }
}
