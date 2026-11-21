import type { TheoremContextReference } from '@theoremharness/sdk'

type Json = Record<string, unknown>
type CitationPart = { type: string; name?: string; data?: unknown }

const object = (value: unknown): Json =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Json)
    : {}

const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined

/** External evidence links name an absolute web URL; never infer a destination. */
export function citationUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) ? url.href : undefined
  } catch {
    return undefined
  }
}

export interface CitationPassage {
  excerpt: string
  provenance: Json
}

export interface CitationSource {
  key: string
  label: string
  url: string | undefined
  sourceId: string | undefined
  sourceKind: string | undefined
  provenance: Json
  passages: CitationPassage[]
}

/** Ignore absent streaming fields instead of erasing previously supplied metadata. */
const supplied = (value: Json): Json =>
  Object.fromEntries(
    Object.entries(value).filter(
      ([, field]) => field !== undefined && field !== null && field !== '',
    ),
  )

/**
 * Rebuild from the durable message on every update. A source owns one card,
 * while later citations enrich its metadata and contribute distinct passages.
 * Explicit source IDs remain distinct even when they happen to share a URL.
 * Labels are display text, not identity: citations without an ID or URL stay
 * separate even when their labels match.
 */
export function collectCitationSources(
  content: readonly CitationPart[],
): CitationSource[] {
  const sources: CitationSource[] = []
  const byId = new Map<string, CitationSource>()
  let citationIndex = 0
  for (const part of content) {
    if (part.type !== 'data' || part.name !== 'theorem-citation') continue
    // The SDK omits stored part IDs from assistant-ui citation data. Its
    // citation order survives appends/reload, unlike surrounding text or
    // activity positions, so use that order when no source identity exists.
    const fallbackKey = `part:${citationIndex++}`
    const data = object(part.data)
    const provenance = supplied(object(data.provenance))
    const sourceId = str(data.sourceId)
    const sourceKind = str(data.sourceKind)
    const url = citationUrl(provenance.url)
    const label = str(data.label)
    const excerpt = str(provenance.excerpt)
    let source = sourceId ? byId.get(sourceId) : undefined
    if (!source && url) {
      source = sources.find(
        (candidate) =>
          // A URL-bearing fallback can gain its durable ID later in the stream.
          (!sourceId || !candidate.sourceId) && candidate.url === url,
      )
    }
    if (!source) {
      source = {
        key: sourceId ? `id:${sourceId}` : url ? `url:${url}` : fallbackKey,
        label: label ?? (url && new URL(url).hostname) ?? 'Source',
        url,
        sourceId,
        sourceKind,
        provenance: {},
        passages: [],
      }
      sources.push(source)
    }
    source.sourceId ??= sourceId
    source.sourceKind = sourceKind ?? source.sourceKind
    source.url = url ?? source.url
    source.label =
      label ??
      (source.label === 'Source' && url ? new URL(url).hostname : source.label)
    // The complete passage belongs below; source metadata must not imply the
    // last excerpt is the only evidence this source contributed.
    const metadata = { ...provenance }
    delete metadata.excerpt
    source.provenance = { ...source.provenance, ...metadata }
    if (source.sourceId) byId.set(source.sourceId, source)
    if (excerpt) {
      const previous = source.passages.find(
        (passage) => passage.excerpt === excerpt,
      )
      if (previous)
        previous.provenance = { ...previous.provenance, ...metadata }
      else source.passages.push({ excerpt, provenance: metadata })
    }
  }
  return sources
}

const CITATION_CONTEXT_SCHEMA = 'theorem.citation-context.v1'

/** The same whole-reference UTF-8 limit used by app-dossier and document
 * passages, including the JSON escaping of an excerpt stored inside the envelope. */
export const MAX_CITATION_REFERENCE_BYTES = 8192
const referenceBytes = (reference: TheoremContextReference) =>
  new TextEncoder().encode(JSON.stringify(reference)).byteLength

/**
 * The SDK supports a message location with a text excerpt, not a citation
 * resource. Keep that real location and carry the selected evidence in the
 * supported excerpt field so it survives send, recovery and transcript reload.
 */
export function citationContextReference(
  source: CitationSource,
  threadId: string,
  messageId: string,
): TheoremContextReference {
  const identity = {
    key: source.key,
    sourceId: source.sourceId,
    sourceKind: source.sourceKind,
    url: source.url,
  }
  const reference: TheoremContextReference = {
    label: source.label,
    location: { resource: { kind: 'message', threadId, messageId } },
    excerpt: JSON.stringify({
      schema: CITATION_CONTEXT_SCHEMA,
      citation: {
        ...identity,
        label: source.label,
        provenance: source.provenance,
        passages: source.passages,
      },
    }),
  }
  if (referenceBytes(reference) <= MAX_CITATION_REFERENCE_BYTES)
    return reference

  // Keep exact source identity and the real message location. Do not silently
  // cut a quote or manufacture a locator: the full evidence is in that message.
  const compact = {
    ...reference,
    label: [...source.label].slice(0, 256).join(''),
    excerpt: JSON.stringify({
      schema: CITATION_CONTEXT_SCHEMA,
      citation: {
        ...identity,
        omittedEvidence: {
          passages: source.passages.length,
          provenance: true,
          reason:
            'Evidence exceeds the context size limit. Read the exact passages in the referenced message.',
        },
      },
    }),
  }
  if (referenceBytes(compact) <= MAX_CITATION_REFERENCE_BYTES) return compact
  // Pathological identifiers or URLs cannot fit even without passages. The
  // caller surfaces this locally instead of sending a request known to fail.
  throw new Error(
    'This source reference is too large to add. Copy a supporting passage instead.',
  )
}

/** Source identity in an SDK-compatible excerpt, used only for composer dedupe. */
export function citationReferenceKey(
  reference: TheoremContextReference,
): string | undefined {
  const resource = reference.location.resource
  if (resource.kind !== 'message' || !reference.excerpt) return undefined
  try {
    const context = object(JSON.parse(reference.excerpt))
    if (context.schema !== CITATION_CONTEXT_SCHEMA) return undefined
    const key = str(object(context.citation).key)
    return key
      ? `citation:${JSON.stringify([resource.threadId, resource.messageId, key])}`
      : undefined
  } catch {
    return undefined
  }
}
