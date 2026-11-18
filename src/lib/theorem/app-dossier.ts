// SOURCING: none: what an App's dossier sends with a question (an App
// reference, app-references.ts, with the App's own account of where the person
// is) and which messages of the page's conversation are its questions and
// their replies. The conversation is assistant-ui's thread; this reads it.
import type { TheoremContextReference } from '@theoremharness/sdk'
import type {
  DossierContext,
  DossierMessage,
  DossierState,
} from '../blocks/sandbox/protocol'
import { appContextReference } from './app-references'
import type { AppSnapshot } from './apps'
import { CONTEXT_REFERENCES_METADATA } from './message-history'

/** Where on a question's metadata the App it was asked from is written. */
export const DOSSIER_METADATA = 'theoremDossier'

/** The most a reference may hold, in bytes; the backend refuses a larger one. */
export const MAX_REFERENCE_BYTES = 8192

const bytes = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value)).length

/** The part the App says is selected, as `context.selected` names it. */
function selectedOf(context: DossierContext) {
  const selected = context.selected
  if (!selected || typeof selected !== 'object' || Array.isArray(selected))
    return undefined
  const { id, label } = selected as Record<string, unknown>
  return typeof id === 'string' && id
    ? {
        entityId: id.slice(0, 200),
        entityLabel: typeof label === 'string' ? label.slice(0, 200) : undefined,
      }
    : undefined
}

/**
 * The reference a question asked from an App goes with: the App's revision
 * on screen, the part it says is selected, and its own account of where the
 * person is. What does not fit the backend's limit is left out largest
 * first, and the excerpt says which keys were.
 */
export function dossierReference(
  snapshot: AppSnapshot,
  context: DossierContext,
): TheoremContextReference {
  const entity = selectedOf(context)
  const selection = entity && { text: '', ...entity }
  const reference = appContextReference(
    snapshot,
    selection && { selection, source: snapshot.html, revision: snapshot.revision },
  )
  const dossier: Record<string, unknown> = { ...context }
  const omitted: Array<string> = []
  const fitted = () => ({
    ...reference,
    excerpt: JSON.stringify({
      selection,
      dossier: omitted.length ? { ...dossier, omitted } : dossier,
    }),
  })
  let shaped = fitted()
  while (bytes(shaped) > MAX_REFERENCE_BYTES) {
    const largest = Object.keys(dossier)
      .filter((key) => key !== 'selected')
      .sort((a, b) => bytes(dossier[b]) - bytes(dossier[a]))[0]
    if (largest === undefined) {
      // Still marked as the dossier's, so the question is found again on reload.
      shaped = { ...reference, excerpt: JSON.stringify({ selection, dossier: { omitted } }) }
      break
    }
    delete dossier[largest]
    omitted.push(largest)
    shaped = fitted()
  }
  return shaped
}

/** The parts of a thread message this reads. */
export interface ConversationMessage {
  id: string
  role: string
  content: ReadonlyArray<{ type: string; text?: string }>
  metadata?: { custom?: Record<string, unknown> }
  status?: { type: string }
}

const textOf = (message: ConversationMessage) =>
  message.content
    .flatMap((part) => (part.type === 'text' && part.text ? [part.text] : []))
    .join('\n\n')

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

/**
 * Whether a stored reference is one a dossier of this App sent: a reference
 * to the App whose excerpt carries the dossier's account. A repair, or the
 * conversation's own "ask about this App", refers to the App without one.
 */
function fromDossier(reference: unknown, documentId: string) {
  const resource = record(record(record(reference)?.location)?.resource)
  if (resource?.objectType !== 'theorem.app' || resource.objectId !== documentId) return false
  const excerpt = record(reference)?.excerpt
  try {
    return typeof excerpt === 'string' && 'dossier' in (record(JSON.parse(excerpt)) ?? {})
  } catch {
    return false
  }
}

/**
 * Whether a question was asked from this App's dossier: marked so when it was
 * sent in this session, or, once the conversation is loaded again, sent with
 * a dossier's reference to the App.
 */
const askedFrom = (message: ConversationMessage, documentId: string) => {
  if (message.role !== 'user') return false
  const custom = message.metadata?.custom
  if (record(custom?.[DOSSIER_METADATA])?.documentId === documentId) return true
  const sent = custom?.[CONTEXT_REFERENCES_METADATA]
  return Array.isArray(sent) && sent.some((reference) => fromDossier(reference, documentId))
}

const statusOf = (message: ConversationMessage): DossierMessage['status'] => {
  const type = message.status?.type
  return type === 'running' || type === 'requires-action'
    ? 'running'
    : type === 'incomplete'
      ? 'incomplete'
      : 'complete'
}

/**
 * The questions asked from one App and the replies that answer each, in the
 * order the conversation has them. Everything else in the conversation is
 * the conversation's own.
 */
export function dossierState(
  messages: ReadonlyArray<ConversationMessage>,
  documentId: string,
  available = true,
): DossierState {
  const shown: Array<DossierMessage> = []
  let answering = false
  for (const message of messages) {
    if (message.role === 'user') {
      answering = askedFrom(message, documentId)
      if (answering)
        shown.push({ id: message.id, role: 'user', text: textOf(message), status: 'complete' })
    } else if (answering && message.role === 'assistant') {
      shown.push({ id: message.id, role: 'assistant', text: textOf(message), status: statusOf(message) })
    }
  }
  return {
    available,
    running: shown.some((message) => message.status === 'running'),
    messages: shown,
  }
}

/** Where `name` is written as a string in an App's own files: the first, by file order. */
export function sourceOf(
  files: Record<string, string>,
  name: string,
): { file: string; line: number } | undefined {
  const quoted = [`'${name}'`, `"${name}"`, `\`${name}\``]
  for (const [file, text] of Object.entries(files)) {
    if (!/\.(?:tsx?|jsx?)$/.test(file)) continue
    const at = Math.min(
      ...quoted.map((form) => text.indexOf(form)).filter((index) => index >= 0),
    )
    if (Number.isFinite(at))
      return { file, line: text.slice(0, at).split('\n').length }
  }
  return undefined
}
