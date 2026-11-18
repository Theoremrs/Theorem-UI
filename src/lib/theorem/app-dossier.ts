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
import { ARTIFACT_RUNTIME_SCHEMA, readObservationRef } from '../blocks/artifact-runtime'
import type {
  ArtifactSourceRef,
  ObservationRef,
  RunRef,
  RuntimeBinding,
} from '../blocks/artifact-runtime'
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

/** An App revision as a source reference names it. */
export const appSourceRef = (snapshot: AppSnapshot): ArtifactSourceRef => ({
  kind: 'document',
  documentId: snapshot.documentId,
  position: String(snapshot.revision.position),
  contentDigest: snapshot.revision.contentDigest,
})

/**
 * What is on screen when a question is asked: the revision whose page is
 * running (which is the last that built, when a newer one failed or is still
 * building), the run the App says it shows and the moment shown. The run's
 * execution source is the running revision, since the App computes it there.
 */
export function dossierBinding(
  displayed: AppSnapshot,
  context: DossierContext,
  latest?: { snapshot: AppSnapshot; status: 'building' | 'failed' },
): RuntimeBinding {
  const source = appSourceRef(displayed)
  const run = record(context.run)
  const observation = readObservationRef(context.observation)
  return {
    schema: ARTIFACT_RUNTIME_SCHEMA,
    presentation: { source },
    ...(run && typeof run.id === 'string' ? { run: { ...(run as unknown as Omit<RunRef, 'source'>), source } } : {}),
    ...(observation ? { observation } : {}),
    ...(latest ? { latest: { source: appSourceRef(latest.snapshot), status: latest.status } } : {}),
  }
}

/**
 * Keys of the App's account that are never left out to fit: what is
 * selected and the exact moment and run the question is about. Facts are
 * shortened, not dropped, and say how many were left out; the exact moment
 * is enough to read the rest again.
 */
const KEPT = new Set(['selected', 'observation', 'run', 'facts', 'settled', 'unsettled', 'unavailable'])

/**
 * The reference a question asked from an App goes with: the App's revision
 * on screen, the part it says is selected, and its own account of where the
 * person is. What does not fit the backend's limit is left out largest
 * first, and the excerpt says which keys were. With a binding, the excerpt
 * carries it whole, outside what may be left out.
 */
export function dossierReference(
  snapshot: AppSnapshot,
  context: DossierContext,
  binding?: RuntimeBinding,
): TheoremContextReference {
  const entity = selectedOf(context)
  const selection = entity && { text: '', ...entity }
  const reference = appContextReference(
    snapshot,
    selection && { selection, source: snapshot.html, revision: snapshot.revision },
  )
  const dossier: Record<string, unknown> = { ...context }
  const omitted: Array<string> = []
  let factsOmitted = 0
  const fitted = () => ({
    ...reference,
    excerpt: JSON.stringify({
      selection,
      ...(binding ? { binding } : {}),
      dossier: {
        ...dossier,
        ...(omitted.length ? { omitted } : {}),
        ...(factsOmitted ? { factsOmitted } : {}),
      },
    }),
  })
  let shaped = fitted()
  while (bytes(shaped) > MAX_REFERENCE_BYTES) {
    const largest = Object.keys(dossier)
      .filter((key) => !KEPT.has(key))
      .sort((a, b) => bytes(dossier[b]) - bytes(dossier[a]))[0]
    const facts = Array.isArray(dossier.facts) ? dossier.facts : []
    if (largest !== undefined) {
      delete dossier[largest]
      omitted.push(largest)
    } else if (facts.length) {
      const keep = Math.floor(facts.length / 2)
      factsOmitted += facts.length - keep
      dossier.facts = facts.slice(0, keep)
    } else {
      // Still marked as the dossier's, so the question is found again on
      // reload; the moment it was about is kept with it.
      const kept = Object.fromEntries(['observation', 'run'].filter((key) => key in dossier).map((key) => [key, dossier[key]]))
      shaped = { ...reference, excerpt: JSON.stringify({ selection, dossier: { ...kept, omitted } }) }
      if (bytes(shaped) > MAX_REFERENCE_BYTES)
        shaped = { ...reference, excerpt: JSON.stringify({ selection, dossier: { observation: dossier.observation, omitted } }) }
      break
    }
    shaped = fitted()
  }
  return shaped
}

/**
 * What the frame is running, for a question to name: the revision built and
 * shown, and, while a newer revision is not the one shown, whether it is
 * still building or failed.
 */
export interface Displayed {
  snapshot?: AppSnapshot
  status?: 'building' | 'failed'
}

/**
 * The revision a question names and the binding it carries: the revision
 * running in the frame (the latest only when its page is the one shown, so a
 * state-only save still names the newest), and the newer revision when it is
 * not the one shown.
 */
export function questionBinding(
  displayed: Displayed,
  latest: AppSnapshot | null,
  context: Record<string, unknown>,
) {
  const shown = displayed.snapshot
  if (!shown) throw new Error('The App has not built a revision to ask about yet.')
  const running = latest && latest.html === shown.html ? latest : shown
  const newer =
    latest && latest.html !== running.html
      ? { snapshot: latest, status: displayed.status ?? ('building' as const) }
      : undefined
  return { running, binding: dossierBinding(running, context, newer) }
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
/** The moment a question from this App was asked about, from its metadata or its stored reference. */
function observationOf(message: ConversationMessage, documentId: string): ObservationRef | undefined {
  const custom = message.metadata?.custom
  const marked = record(custom?.[DOSSIER_METADATA])
  if (marked?.documentId === documentId) {
    const observation = readObservationRef(marked.observation)
    if (observation) return observation
  }
  const sent = custom?.[CONTEXT_REFERENCES_METADATA]
  if (!Array.isArray(sent)) return undefined
  for (const reference of sent) {
    if (!fromDossier(reference, documentId)) continue
    try {
      const excerpt = record(JSON.parse(String(record(reference)?.excerpt)))
      const observation =
        readObservationRef(record(excerpt?.binding)?.observation) ??
        readObservationRef(record(excerpt?.dossier)?.observation)
      if (observation) return observation
    } catch {
      // A reference that is not JSON names no moment.
    }
  }
  return undefined
}

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
  let observation: ObservationRef | undefined
  for (const message of messages) {
    if (message.role === 'user') {
      answering = askedFrom(message, documentId)
      observation = answering ? observationOf(message, documentId) : undefined
      if (answering)
        shown.push({ id: message.id, role: 'user', text: textOf(message), status: 'complete', ...(observation && { observation }) })
    } else if (answering && message.role === 'assistant') {
      shown.push({
        id: message.id,
        role: 'assistant',
        text: textOf(message),
        status: statusOf(message),
        ...(observation && { observation }),
      })
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
