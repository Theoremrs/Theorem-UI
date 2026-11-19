// SOURCING: zustand (the same thin external store the artifact panels and the
// run-input queue use), because a held question must outlive the view that asked
// it. No library owns a conversation's pending App questions.
//
// Questions an App asked while its conversation's turn runs. They are held with
// the conversation and the App they were asked from, not with the view that
// asked them: a transcript App is remounted whenever a newer revision arrives
// (artifact-message renders the live App only for the latest revision of a part,
// and an older one becomes a saved-revision card), so a queue kept in the view's
// own state would be discarded with the old mount and the questions it was
// holding would never reach the conversation.
import { create } from 'zustand'
import { markUndelivered } from './app-dossier'
import type { HeldQuestion, questionBinding } from './app-dossier'

/** A question held while the conversation's turn runs, and where it must go. */
export interface Queued extends HeldQuestion {
  /** The revision and binding resolved when it was asked; sent unchanged. */
  asked: ReturnType<typeof questionBinding>
  /** The conversation it was asked in; it is sent there or not at all. */
  conversation: string | undefined
  /** The App it was asked from; its dossier is the only one it belongs to. */
  documentId: string
}

interface DossierQueue {
  /** Held questions by conversation and App. An emptied place is forgotten, so
   * this grows only with what is genuinely waiting, never with visits. */
  buckets: Readonly<Record<string, ReadonlyArray<Queued>>>
}

const NO_QUEUED: ReadonlyArray<Queued> = Object.freeze([])

/** The one place a conversation's questions about one App are held. */
const place = (conversation: string | undefined, documentId: string) =>
  `${conversation ?? ''}\u0000${documentId}`

export const useDossierQueue = create<DossierQueue>()(() => ({ buckets: {} }))

/** What the App is holding now, in the order it was asked. Read at the moment of
 * sending, not carried through a render, so two views of one App in one
 * conversation cannot both send the same question. */
export const queued = (
  conversation: string | undefined,
  documentId: string,
): ReadonlyArray<Queued> =>
  useDossierQueue.getState().buckets[place(conversation, documentId)] ?? NO_QUEUED

/** The same, followed by a view: what the App is told it is holding. */
export const useQueued = (
  conversation: string | undefined,
  documentId: string,
): ReadonlyArray<Queued> =>
  useDossierQueue(
    (s) => s.buckets[place(conversation, documentId)] ?? NO_QUEUED,
  )

/** Holds one, after whatever was asked before it. */
export const hold = (question: Queued): void => {
  const key = place(question.conversation, question.documentId)
  useDossierQueue.setState((s) => ({
    buckets: {
      ...s.buckets,
      [key]: [...(s.buckets[key] ?? NO_QUEUED), question],
    },
  }))
}

/** Records that one has gone: the turn that held it ended and it was sent. */
export const sent = (question: Queued): void => {
  const key = place(question.conversation, question.documentId)
  const { buckets } = useDossierQueue.getState()
  const held = buckets[key]
  if (!held) return
  const rest = held.filter((other) => other.id !== question.id)
  const { [key]: _, ...others } = buckets
  useDossierQueue.setState({
    buckets: rest.length ? { ...others, [key]: rest } : others,
  })
}

/** Records that one could not go, with why. It stays, where it was, to be seen. */
export const undelivered = (question: Queued, reason: string): void => {
  const key = place(question.conversation, question.documentId)
  const { buckets } = useDossierQueue.getState()
  const held = buckets[key]
  if (!held) return
  useDossierQueue.setState({
    buckets: { ...buckets, [key]: markUndelivered(held, question.id, reason) },
  })
}