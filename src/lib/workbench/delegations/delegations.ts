// SOURCING: @theoremharness/sdk — each call is the generated client.chat.runs.delegations / delegationContent operation (types Theorem.ChatRunDelegations, Theorem.DelegationPart, Theorem.ChangeSetEntry; the content is the text the server sends). lru-cache holds the blobs: `max` and `maxSize` with `sizeCalculation` bound them, and `fetch()` with `fetchMethod` shares one load per key and does not keep a rejected load. TextEncoder is the platform's UTF-8 encoder, used to count the text's bytes. Behaviour follows the IDE's theorem-delegations provider and lib/theorem/delegations (LIVE_DELEGATION_STATES), whose Theia and React types are not imported.

import type { Theorem } from '@theoremharness/sdk'
import { LRUCache } from 'lru-cache'
import { accepted, failure, refused, statusOf } from '../environment/result'
import type { Answers, Completion } from '../environment/result'

/** The two calls this owner makes of a Theorem client. `TheoremClient` satisfies it, and a test stub can. */
export interface DelegationsClient {
  chat: {
    runs: {
      delegations: (request: {
        runId: string
      }) => PromiseLike<Pick<Theorem.ChatRunDelegations, 'delegations'>>
      delegationContent: (request: {
        runId: string
        delegationId: string
        ref: string
      }) => PromiseLike<string>
    }
  }
}

/** The longest text one side of a change is read as: 1 MiB. The side travels whole through an effect completion and into a read-only editor, and a larger file would stall both. Over it the read is refused, not truncated. */
export const MAX_TEXT_BYTES = 1024 * 1024
/** Blobs kept: at most this many, and at most {@link MAX_CACHE_BYTES} in all, the oldest dropped first. */
export const MAX_CACHED_BLOBS = 64
export const MAX_CACHE_BYTES = 8 * 1024 * 1024

/** The states in which a delegation's receipt can still grow (`lib/theorem/delegations` LIVE_DELEGATION_STATES). */
const LIVE_STATES: ReadonlySet<string> = new Set([
  'proposed',
  'admitted',
  'started',
])

export type ChangeKind = 'add' | 'modify' | 'delete'
export type Side = 'before' | 'after'

/** One change a delegation made. The content refs stay inside the owner. */
export interface DelegatedChange {
  path: string
  change: ChangeKind
  binary: boolean
  hasBefore: boolean
  hasAfter: boolean
}

export interface DelegationRequest {
  runId: string
  delegationId: string
}
export interface ContentRequest extends DelegationRequest {
  path: string
  side: Side
}
interface Options {
  requestId?: string
}

export interface Delegations {
  readonly workspaceId: string
  /**
   * The changes the delegation's receipt lists. Refused `no_such_delegation` when the run has no such
   * delegation. A delegation still working has its list read again each time.
   */
  changes: (
    request: DelegationRequest,
    options?: Options,
  ) => Promise<Completion<DelegatedChange[]>>
  /**
   * One side of one change as text. Refused: `no_such_change` (the path is not in the list),
   * `binary_skipped`, `no_such_side` (the before of an added file, the after of a deleted one),
   * `no_longer_stored` (the host answered 404), `too_large` (over {@link MAX_TEXT_BYTES}),
   * `stale_account` (the account changed while this was in flight).
   */
  content: (
    request: ContentRequest,
    options?: Options,
  ) => Promise<Completion<{ text: string }>>
  /** Blobs held now, for a test and for a panel that shows memory. */
  cached: () => { blobs: number; bytes: number }
  /** Drops what was read. Called by the account watch on a switch, and on `dispose`. */
  reset: () => void
  dispose: () => void
}

export interface DelegationsOptions {
  workspaceId: string
  client: DelegationsClient
  /** The account watch's `onChange`: a sign-out or switch drops every cached list and blob, and an answer still in flight is refused. */
  onAccountChange?: (listener: () => void) => () => void
}

/** A read the host or the bytes refused: thrown out of the load so lru-cache keeps nothing for it. */
class Refusal extends Error {
  constructor(
    readonly code: string,
    reason: string,
  ) {
    super(reason)
  }
}

export function createDelegations({
  workspaceId,
  client,
  onAccountChange,
}: DelegationsOptions): Delegations {
  let epoch = 0
  let disposed = false
  let counter = 0
  const lists = new Map<string, Promise<Theorem.DelegationPart[]>>()
  const settledLists = new Map<string, Theorem.DelegationPart[]>()

  const answersOf = (options?: Options): Answers => ({
    workspaceId,
    requestId: options?.requestId ?? `delegations-${(counter += 1)}`,
  })

  const reset = () => {
    epoch += 1
    lists.clear()
    settledLists.clear()
    blobs.clear()
  }
  const off = onAccountChange?.(reset)

  /** The run's delegations: the one list read in flight is shared; `fresh` reads again. */
  const read = (runId: string, fresh: boolean) => {
    const held = lists.get(runId)
    if (held && !fresh) return held
    const started = epoch
    const next = Promise.resolve(client.chat.runs.delegations({ runId })).then(
      ({ delegations }) => {
        if (started === epoch) settledLists.set(runId, delegations)
        return delegations
      },
    )
    lists.set(runId, next)
    next.catch(() => {
      if (lists.get(runId) === next) lists.delete(runId)
    })
    return next
  }

  /**
   * The delegation as the receipts have it. A list already read is used when it holds the delegation and the delegation
   * has stopped working; otherwise the list is read again, because a live delegation keeps adding to its receipt.
   */
  const find = async ({ runId, delegationId }: DelegationRequest) => {
    const held = settledLists.get(runId)
    const heldOne = held?.find((d) => d.delegationId === delegationId)
    if (heldOne && !LIVE_STATES.has(heldOne.state)) return heldOne
    const fresh = await read(runId, true)
    return fresh.find((d) => d.delegationId === delegationId)
  }

  const kindOf = (change: Theorem.ChangeSetEntry): ChangeKind => change.change

  /** Blobs by (run, delegation, ref): at most 64 and 8 MiB, the least recently used dropped first; a size is at least 1, so an empty file counts. */
  const blobs = new LRUCache<
    string,
    { text: string; size: number },
    { request: DelegationRequest; ref: string }
  >({
    max: MAX_CACHED_BLOBS,
    maxSize: MAX_CACHE_BYTES,
    sizeCalculation: ({ size }) => Math.max(1, size),
    fetchMethod: async (_key, _stale, { context: { request, ref } }) => {
      let text: string
      try {
        text = await client.chat.runs.delegationContent({ ...request, ref })
      } catch (error) {
        if (statusOf(error) === 404)
          throw new Refusal(
            'no_longer_stored',
            'This change is no longer stored',
          )
        throw error
      }
      const size = new TextEncoder().encode(text).byteLength
      if (size > MAX_TEXT_BYTES)
        throw new Refusal(
          'too_large',
          `The file is ${size} bytes; changes are shown up to ${MAX_TEXT_BYTES}`,
        )
      return { text, size }
    },
  })
  const fetchText = (request: DelegationRequest, ref: string) =>
    blobs.fetch(`${request.runId}\0${request.delegationId}\0${ref}`, {
      context: { request, ref },
    })

  return {
    workspaceId,
    cached: () => ({ blobs: blobs.size, bytes: blobs.calculatedSize }),
    reset,
    dispose() {
      if (disposed) return
      disposed = true
      off?.()
      reset()
    },

    async changes(request, options) {
      const answers = answersOf(options)
      if (disposed)
        return refused(answers, 'disposed', 'The delegations owner is closed')
      const started = epoch
      try {
        const delegation = await find(request)
        if (started !== epoch)
          return refused(
            answers,
            'stale_account',
            'The account changed while this was in flight',
          )
        if (!delegation)
          return refused(
            answers,
            'no_such_delegation',
            'This run has no such delegation',
          )
        return accepted(
          answers,
          (delegation.receipt?.changes ?? []).map((change) => ({
            path: change.path,
            change: kindOf(change),
            binary: change.binary,
            hasBefore: Boolean(change.beforeRef),
            hasAfter: Boolean(change.afterRef),
          })),
        )
      } catch (error) {
        return failure(answers, error, false)
      }
    },

    async content(request, options) {
      const answers = answersOf(options)
      if (disposed)
        return refused(answers, 'disposed', 'The delegations owner is closed')
      const started = epoch
      try {
        // A listed, settled delegation answers from what was read; a path it does not list is refused without a call.
        const delegation = await find(request)
        const change = delegation?.receipt?.changes.find(
          (entry) => entry.path === request.path,
        )
        if (started !== epoch)
          return refused(
            answers,
            'stale_account',
            'The account changed while this was in flight',
          )
        if (!delegation)
          return refused(
            answers,
            'no_such_delegation',
            'This run has no such delegation',
          )
        if (!change)
          return refused(
            answers,
            'no_such_change',
            `${request.path} is not one of this delegation's changes`,
          )
        if (change.binary)
          return refused(
            answers,
            'binary_skipped',
            `${request.path} is a binary change and is not shown`,
          )
        const kind = kindOf(change)
        if (
          (request.side === 'before' && kind === 'add') ||
          (request.side === 'after' && kind === 'delete')
        )
          return refused(
            answers,
            'no_such_side',
            `A ${kind === 'add' ? 'new' : 'deleted'} file has no ${request.side} content`,
          )
        const ref =
          request.side === 'before' ? change.beforeRef : change.afterRef
        if (!ref)
          return refused(
            answers,
            'no_longer_stored',
            'This change is no longer stored',
          )
        const stored = await fetchText(request, ref)
        if (started !== epoch)
          return refused(
            answers,
            'stale_account',
            'The account changed while this was in flight',
          )
        // fetch() resolves undefined only for a load that returned nothing, which this one never does.
        if (!stored)
          return failure(answers, new Error('The read returned nothing'), false)
        return accepted(answers, { text: stored.text })
      } catch (error) {
        // clear() aborts a load in flight ("deleted"), so a switch mid-read surfaces here as an error of any kind.
        if (started !== epoch)
          return refused(
            answers,
            'stale_account',
            'The account changed while this was in flight',
          )
        if (error instanceof Refusal)
          return refused(answers, error.code, error.message)
        return failure(answers, error, false)
      }
    },
  }
}
