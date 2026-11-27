// SOURCING: Theorem SDK assistant-ui part identity and Theorem's chat
// retained-passage route contract (theorem_chat_search/retained_passage.rs).
// The opener is the server's authority check, not a URL rule: every call
// rechecks thread ownership, the message run's attached task and the cited
// version. This module deliberately does NOT build an object-store URL —
// the only route is the typed chat API under the app's same-origin proxy.
import { theorem } from './client'
import { citationUrl } from './citations'

/** Why an open did not return a passage. Each is a distinct outcome; none
 * is an empty passage, and none is inferred from citation metadata alone. */
export type RetainedPassageFailure =
  /** The named ids are not durable: a live run's message id is synthetic
   * (`run:<runId>`) and names no stored message; no request was made. */
  | { kind: 'notDurable' }
  /** Unknown thread/message/part, not owned, deleted, or the run has no
   * task admitting the handle. A foreign or revoked handle gets this same
   * answer from the server. */
  | { kind: 'missing' }
  /** The stored passage is gone, its version differs from the cited one,
   * or the cited range does not match its excerpt. */
  | { kind: 'unavailable' }
  /** The backing store could not answer. */
  | { kind: 'store' }
  /** A 200 body that is not the declared passage, or a refusal with no
   * readable problem: a contract violation, surfaced as such. */
  | { kind: 'malformed' }
  /** Any other refusal, with the status preserved. */
  | { kind: 'http'; status: number }

export interface RetainedPassage {
  source: {
    handle: string
    version: string
    extractionVersion: string
    textBasis: string
    textBytes: number
    coverage:
      | { status: 'complete' }
      | { status: 'acquisition_capped'; limit_bytes: number }
  }
  span: { startByte: number; endByte: number }
  excerpt: string
}

export type RetainedPassageResult =
  | { ok: true; passage: RetainedPassage }
  | { ok: false; failure: RetainedPassageFailure }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined
const natural = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

/** Validate at this boundary once, against the declared route contract. */
function parsePassage(value: unknown): RetainedPassage | undefined {
  if (!isRecord(value)) return undefined
  const source = value.source
  const span = value.span
  const excerpt = str(value.excerpt)
  if (!isRecord(source) || !isRecord(span) || !excerpt) return undefined
  if (
    !str(source.handle) ||
    !str(source.version) ||
    !str(source.extractionVersion) ||
    !str(source.textBasis) ||
    !natural(source.textBytes)
  )
    return undefined
  const coverage = source.coverage
  const known =
    isRecord(coverage) &&
    (coverage.status === 'complete' ||
      (coverage.status === 'acquisition_capped' &&
        natural(coverage.limit_bytes)))
  if (!known) return undefined
  if (
    !natural(span.startByte) ||
    !natural(span.endByte) ||
    span.startByte >= span.endByte ||
    span.endByte > source.textBytes ||
    new TextEncoder().encode(excerpt).byteLength !==
      span.endByte - span.startByte
  )
    return undefined
  return value as unknown as RetainedPassage
}

/**
 * Open the exact retained passage one durable citation part names.
 *
 * Every argument must be an authoritative durable id: the saved assistant
 * message's id and the stored citation part's own id (never the card's
 * grouping sourceId, never a run's synthetic `run:<id>`). An id that is
 * absent or synthetic is refused here without a request — the caller waits
 * for durable history instead. The first click is the only network this
 * performs: constructing, rendering or reloading never calls it.
 */
export async function openRetainedPassage(names: {
  threadId: string | undefined
  messageId: string | undefined
  partId: string | undefined
}): Promise<RetainedPassageResult> {
  const { threadId, messageId, partId } = names
  if (!threadId || !messageId || !partId || messageId.startsWith('run:'))
    return { ok: false, failure: { kind: 'notDurable' } }
  const path = `/api/chat/v1/threads/${encodeURIComponent(threadId)}/messages/${encodeURIComponent(messageId)}/citations/${encodeURIComponent(partId)}`
  let response: Response
  try {
    // The SDK's documented passthrough, via the app's own proxy that attaches
    // the server-held token. No token reaches client code.
    response = await theorem().fetch(path, { method: 'GET' })
  } catch {
    return { ok: false, failure: { kind: 'store' } }
  }
  let body: unknown
  try {
    body = await response.json()
  } catch {
    body = undefined
  }
  if (response.ok) {
    const passage = parsePassage(body)
    return passage
      ? { ok: true, passage }
      : { ok: false, failure: { kind: 'malformed' } }
  }
  const problem = isRecord(body) ? body : {}
  const code = str(problem.code)
  if (response.status === 404)
    return { ok: false, failure: { kind: 'missing' } }
  if (response.status === 410)
    return { ok: false, failure: { kind: 'unavailable' } }
  if (response.status === 503) return { ok: false, failure: { kind: 'store' } }
  // A refusal carrying a known code still maps by status; an unreadable body
  // is a contract violation, never a guessed empty passage.
  return code
    ? { ok: false, failure: { kind: 'http', status: response.status } }
    : { ok: false, failure: { kind: 'malformed' } }
}

/** What a reader is told, per outcome. Honest and specific: a revoked or
 * stale handle is the server's answer, not this app's inference. */
export function retainedPassageFailureMessage(
  failure: RetainedPassageFailure,
): string {
  switch (failure.kind) {
    case 'notDurable':
      return 'This reply is still arriving. The passage can be opened once it is saved.'
    case 'missing':
      return 'This passage is not available to open: it is not retained where you can read it.'
    case 'unavailable':
      return 'This passage is no longer available: the retained capture or its exact range is gone.'
    case 'store':
      return 'The stored passage could not be opened right now. Try again shortly.'
    case 'malformed':
      return 'The answer did not match the cited passage, so it was not shown.'
    case 'http':
      return `Opening this passage was refused (status ${failure.status}).`
  }
}

/** Only an http(s) page URL may be offered to the browser, as ever. */
export const passagePageUrl = citationUrl
