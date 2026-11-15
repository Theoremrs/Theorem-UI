// SOURCING: @theoremharness/sdk — `client.workbench.get/save` (`/api/workbench/v1/:workspace_id`)
// through ../environment, which owns the session's CSRF token and the client; the record's
// schema string and its If-Match rule come from the backend's theorem_workbench.rs. The device copy
// is ./checkpoint over @rustyreddb/browser. This file is the one owner of the saved workbench
// record: it keeps the revision with every read and refuses a stale save as a conflict.

import type { TheoremClient } from '@theoremharness/sdk'
import type { Environment, HostClient } from '../environment/environment'
import {
  accepted,
  codeOf,
  failure,
  refused,
  statusOf,
} from '../environment/result'
import type { Answers, Completion, Outcome } from '../environment/result'
import { reason as readableReason } from '../environment/workspace-recovery'
import type { Checkpoint, Checkpoints } from './checkpoint'

/** The record's schema as the backend checks it (theorem_workbench.rs `WORKBENCH_SCHEMA`). */
export const WORKBENCH_SCHEMA = 'theoremweb.workspace/1'

/**
 * The two documents of the record. Opaque JSON: the Rust core owns what is inside, and this module
 * never reads into it.
 */
export interface LayoutDocument {
  current: unknown
  namedLayouts: Record<string, unknown>
}

/** What the server holds for a workspace. `document` is absent until the first save; the revision is then 0. */
export interface LayoutRecord {
  revision: number
  document: LayoutDocument | undefined
}

/** The calls the layout owner makes of a Theorem client; `TheoremClient` satisfies it. */
export type LayoutClient = HostClient & {
  workbench: Pick<TheoremClient['workbench'], 'get' | 'save'>
}

export interface Layout {
  load: (request?: { requestId?: string }) => Promise<Completion<LayoutRecord>>
  /**
   * Writes against `baseRevision`, the revision the document was edited from. The server refuses
   * the save when the record has moved: `refused` with code `conflict`, never last-write-wins.
   * A save whose answer is lost is `uncertain` and is sent once.
   */
  save: (
    document: LayoutDocument,
    options: { baseRevision: number; requestId?: string },
  ) => Promise<Completion<LayoutRecord>>
  /** The device copy for this workspace. Separate from the record: keeping one never implies the other. */
  readCheckpoint: () => Promise<Outcome<Checkpoint | undefined>>
  writeCheckpoint: (
    checkpoint: Omit<Checkpoint, 'savedAtMs'>,
  ) => Promise<Outcome<{ savedAtMs: number }>>
  clearCheckpoint: () => Promise<Outcome<undefined>>
}

export function createLayout(options: {
  environment: Environment<LayoutClient>
  checkpoints: Checkpoints
}): Layout {
  const { environment: env, checkpoints } = options
  const { workspaceId } = env

  const answers = (requestId: string | undefined): Answers => ({
    workspaceId,
    requestId: requestId ?? crypto.randomUUID(),
  })

  const recordOf = (
    record: Awaited<ReturnType<LayoutClient['workbench']['get']>>,
  ): LayoutRecord => ({
    revision: record.revision,
    document: {
      current: record.current,
      namedLayouts: record.namedLayouts ?? {},
    },
  })

  return {
    async load(request) {
      const mine = answers(request?.requestId)
      await env.settled()
      try {
        return accepted(
          mine,
          recordOf(await env.client.workbench.get({ workspaceId })),
        )
      } catch (error) {
        // No save yet is not a failure: the next save is made against revision 0.
        if (
          statusOf(error) === 404 &&
          codeOf(error) === 'workbench_not_found'
        ) {
          return accepted(mine, { revision: 0, document: undefined })
        }
        return failure(mine, error, false)
      }
    },

    async save(document, { baseRevision, requestId }) {
      const mine = answers(requestId)
      if (!Number.isSafeInteger(baseRevision) || baseRevision < 0) {
        return refused(
          mine,
          'invalid_revision',
          'A save needs the revision it was edited from',
        )
      }
      await env.settled()
      const headers = env.headers(mine.requestId)
      if (!headers['X-CSRF-Token']) {
        const availability = env.availability
        return refused(
          mine,
          'environment_unavailable',
          availability.status === 'unavailable'
            ? availability.reason
            : 'There is no signed-in session to save with',
        )
      }
      try {
        const saved = await env.client.workbench.save(
          {
            'X-CSRF-Token': headers['X-CSRF-Token'],
            'Idempotency-Key': headers['Idempotency-Key'],
            'If-Match': String(baseRevision),
            workspaceIdPath: workspaceId,
            body: {
              workspaceId,
              revision: baseRevision,
              schema: WORKBENCH_SCHEMA,
              current: document.current,
              namedLayouts: document.namedLayouts,
            },
          },
          { maxRetries: 0 },
        )
        return accepted(mine, recordOf(saved))
      } catch (error) {
        if (statusOf(error) === 409) {
          return refused(mine, 'conflict', readableReason(error))
        }
        return failure(mine, error, true)
      }
    },

    readCheckpoint: () => checkpoints.read(workspaceId),
    writeCheckpoint: (checkpoint) => checkpoints.write(workspaceId, checkpoint),
    clearCheckpoint: () => checkpoints.clear(workspaceId),
  }
}
