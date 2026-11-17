// SOURCING: none — the contract between the effect dispatcher and the owners it does not call directly: what an owner answers with, and the one function that turns any owner module's completion into that answer
import type { Outcome } from './environment/result'
import type { CompletionPayload, Effect, HostMessage, Revision } from './wire'

/** Effects whose kind starts with `prefix`: the slice of the wire one owner serves. */
export type Of<TPrefix extends string> = Extract<
  Effect,
  { kind: `${TPrefix}${string}` }
>

/** What an owner answers with: the wire outcome, and for `accepted` the data and, if it moved, the revision. */
export type OwnerReply =
  | {
      outcome: 'accepted'
      value?: CompletionPayload
      /** Set when the effect moved the resource's version; otherwise the effect's own is echoed. */
      revision?: Revision
    }
  | {
      outcome: 'refused'
      code: string
      reason: string
      /** The owner's state when the refusal is itself information (a document conflict names the current text). */
      value?: CompletionPayload
    }
  | { outcome: 'uncertain'; reason: string }
  | { outcome: 'failed'; reason: string }

/**
 * An owner as the adapter needs it: one method that performs an effect of its kinds. `requestId` is
 * stable per effect (a retry of the same effect reuses it), so an owner that deduplicates can
 * recognise it. `subscribe` is for owners that push host events.
 */
export interface OwnerPort<TEffect extends Effect> {
  perform: (effect: TEffect, requestId: string) => Promise<OwnerReply>
  subscribe?: (listener: (message: HostMessage) => void) => () => void
}

type Accepted = Extract<OwnerReply, { outcome: 'accepted' }>

/** Any owner module's outcome (this repo's modules share the discriminants), with or without its request identity, as an OwnerReply. */
export function reply<T>(
  answer: Outcome<T>,
  accepted: (value: T) => Partial<Accepted> = () => ({}),
): OwnerReply {
  switch (answer.outcome) {
    case 'accepted':
      return { outcome: 'accepted', ...accepted(answer.value) }
    case 'refused':
      return { outcome: 'refused', code: answer.code, reason: answer.reason }
    case 'uncertain':
      return { outcome: 'uncertain', reason: answer.reason }
    case 'failed':
      return { outcome: 'failed', reason: answer.reason }
  }
}

/** A refusal an owner port makes itself, before any owner call. */
export const refusal = (code: string, reason: string): OwnerReply => ({
  outcome: 'refused',
  code,
  reason,
})
