// SOURCING: @theoremharness/sdk — each call is the generated client.ide.history list / preview / restore operation (types ListHistoryRequest, PreviewHistoryRequest, RestoreHistoryRequest; the answer is NativeResult, read here), sent through ../ask with the request id as the idempotency key, as ../language/language does. The SDK's WorkspaceHistory-style helpers are not used for the reasons language.ts gives. Behaviour follows the IDE's theorem-timeline (history.list entries by operation id, newest first, the first 50; history.restore after the session's edits are flushed).

import type { TheoremClient } from '@theoremharness/sdk'
import type { Environment, HostClient } from '../environment/environment'
import { refused, statusOf } from '../environment/result'
import type { Completion, Outcome } from '../environment/result'
import { createAsk, num, outsideWorkspace, raw, str } from '../ask'

/** The calls the history owner makes of a Theorem client. */
export type HistoryClient = HostClient & {
  ide: {
    history: Pick<
      TheoremClient['ide']['history'],
      'list' | 'preview' | 'restore'
    >
  }
}

/** The host operations this owner needs; each is refused `unavailable` when the host does not list it. */
export const HISTORY_OPERATIONS = {
  list: 'history.list',
  preview: 'history.preview',
  restore: 'history.restore',
} as const

/** The most entries a list returns: the newest 50, as the IDE's timeline shows. The host's journal has one entry per sent edit and grows without a bound. */
export const HISTORY_LIMIT = 50

export interface HistoryEntry {
  /** The journal point to preview or restore: the host's operation id. Opaque to the caller. */
  point: string
  revision: number
}

interface Options {
  requestId?: string
}

export interface DocumentHistory {
  readonly workspaceId: string
  /**
   * The journaled revisions of one document, newest first. A document the journal has not seen has none:
   * accepted with an empty list, which is the empty state and not an error.
   */
  list: (
    document: string,
    options?: Options,
  ) => Promise<Completion<{ entries: HistoryEntry[] }>>
  /** The document's text at one point. Refused `no_text` when the host holds none for it. */
  preview: (
    document: string,
    point: string,
    options?: Options,
  ) => Promise<Completion<{ text: string }>>
  /**
   * Puts the document back to a point. The document's pending edits are flushed first through `flush`; when that
   * is refused, uncertain or failed, this is refused `pending_edits` and nothing is sent. A restore whose answer
   * is lost is `uncertain` and is never sent again here. An accepted restore reaches the documents owner as a new
   * revision on the live stream; this owner does not touch the local text.
   */
  restore: (
    document: string,
    point: string,
    options: { requestId: string },
  ) => Promise<Completion<{ point: string }>>
  dispose: () => void
}

export interface HistoryOptions {
  /** Sends what the document owes the host, and answers whether it was accepted. */
  flush: (
    document: string,
    request: { requestId: string },
  ) => Promise<Outcome<unknown>>
}

export function createHistory(
  env: Environment<HistoryClient>,
  { flush }: HistoryOptions,
): DocumentHistory {
  const { ask, workspaceId, dispose } = createAsk(env)
  const api = () => env.client.ide.history
  let counter = 0
  const idOf = (options?: Options) =>
    options?.requestId ?? `history-${(counter += 1)}`

  /** Refused before anything is sent: a document outside the workspace, or an operation the host does not list. */
  const gate = (
    document: string,
    operations: string[],
    requestId: string,
  ): Completion<never> | undefined => {
    const answers = { workspaceId, requestId }
    if (outsideWorkspace(document))
      return refused(
        answers,
        'outside_workspace',
        `${document} is outside the workspace`,
      )
    for (const operation of operations) {
      const availability = env.availabilityFor(operation, true)
      if (availability.status === 'unavailable')
        return refused(
          answers,
          'unavailable',
          `${operation}: ${availability.reason}`,
        )
    }
    return undefined
  }

  const entriesOf = (answer: unknown): HistoryEntry[] => {
    const rows = raw(answer).entries
    // The journal can hold several entries for one operation; the later one stands.
    const points = new Map<string, HistoryEntry>()
    for (const row of Array.isArray(rows) ? rows : []) {
      const body = raw(row)
      const point = str(body.operation_id)
      const revision = num(body.revision)
      if (point !== undefined && revision !== undefined)
        points.set(point, { point, revision })
    }
    return [...points.values()]
      .sort((a, b) => b.revision - a.revision)
      .slice(0, HISTORY_LIMIT)
  }

  return {
    workspaceId,
    dispose,

    async list(document, options) {
      const requestId = idOf(options)
      const bad = gate(document, [HISTORY_OPERATIONS.list], requestId)
      if (bad) return bad
      // A file the journal has not seen is the empty state, whatever code the host gives its 404; any other error stands.
      return ask(
        requestId,
        HISTORY_OPERATIONS.list,
        false,
        async (headers) => {
          try {
            return await api().list({
              ...headers,
              body: { resource_id: document },
            })
          } catch (error) {
            if (statusOf(error) === 404) return { entries: [] }
            throw error
          }
        },
        (answer) => ({ entries: entriesOf(answer) }),
      )
    },

    async preview(document, point, options) {
      const requestId = idOf(options)
      const bad = gate(document, [HISTORY_OPERATIONS.preview], requestId)
      if (bad) return bad
      const done = await ask(
        requestId,
        HISTORY_OPERATIONS.preview,
        false,
        (headers) =>
          api().preview({
            ...headers,
            body: { point, resource_id: document },
          }),
        (answer) => str(raw(answer).text),
      )
      if (done.outcome !== 'accepted') return done
      return done.value === undefined
        ? refused(
            { workspaceId, requestId },
            'no_text',
            `${document} has no text at that point`,
          )
        : { ...done, value: { text: done.value } }
    },

    async restore(document, point, { requestId }) {
      const bad = gate(document, [HISTORY_OPERATIONS.restore], requestId)
      if (bad) return bad
      const flushed = await flush(document, { requestId })
      if (flushed.outcome !== 'accepted')
        return refused(
          { workspaceId, requestId },
          'pending_edits',
          `${document} has edits that could not be sent first (${flushed.outcome}); nothing was restored`,
        )
      return ask(
        requestId,
        HISTORY_OPERATIONS.restore,
        true,
        (headers) =>
          api().restore(
            {
              ...headers,
              body: {
                point,
                resource_id: document,
                workspace_id: workspaceId,
              },
            },
            // A restore is sent once; the SDK's own retries are off, so the host sees it once.
            { maxRetries: 0 },
          ),
        () => ({ point }),
      )
    },
  }
}
