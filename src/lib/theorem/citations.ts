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
  /** Exact UTF-8 range of this excerpt within the retained version, when
   * the capture kept one: `startByte` inclusive, `endByte` exclusive. */
  span: CitationSpan | undefined
  provenance: Json
}

/** A retained capture's byte range within its extracted-text version. */
export interface CitationSpan {
  startByte: number
  endByte: number
}

/** The nested `SourceRef` PR #1138 publishes under a retained capture.
 * Mirrors the SDK's `TheoremRetainedSourceRef` field for field. A handle is
 * a reference, not authority: it names what was captured, never what can
 * still be opened. */
export interface CitationCapture {
  handle: string
  version: string
  extractionVersion: string
  textBasis: string
  textBytes: number
  coverage:
    | { status: 'complete' }
    | { status: 'acquisition_capped'; limitBytes: number }
}

export interface CitationSource {
  key: string
  label: string
  url: string | undefined
  sourceId: string | undefined
  sourceKind: string | undefined
  /** The capture behind this source, once proven well-formed: the exact
   * version its passages' spans are measured against. */
  capture: CitationCapture | undefined
  provenance: Json
  passages: CitationPassage[]
}

const natural = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

/** Parse a retained capture once, at the wire boundary. Anything that does
 * not match the `SourceRef` contract names no capture: an unverifiable
 * reference must not become a claimed version, and a stale or revoked handle
 * is answered by the store when opened, never by trusting its shape here. */
export function citationCapture(value: unknown): CitationCapture | undefined {
  const ref = object(value)
  const handle = str(ref.handle)
  const version = str(ref.version)
  const extractionVersion = str(ref.extractionVersion)
  const textBasis = str(ref.textBasis)
  if (!handle || !version || !extractionVersion || !textBasis) return undefined
  if (!natural(ref.textBytes)) return undefined
  const coverage = object(ref.coverage)
  if (coverage.status === 'complete')
    return {
      handle,
      version,
      extractionVersion,
      textBasis,
      textBytes: ref.textBytes,
      coverage: { status: 'complete' },
    }
  if (coverage.status === 'acquisition_capped' && natural(coverage.limitBytes))
    return {
      handle,
      version,
      extractionVersion,
      textBasis,
      textBytes: ref.textBytes,
      coverage: {
        status: 'acquisition_capped',
        limitBytes: coverage.limitBytes,
      },
    }
  return undefined
}

/** A span only means text inside a proven capture version. Without one, or
 * past its retained bytes, it names no evidence and is dropped; the excerpt
 * itself stays. */
function citationSpan(
  value: unknown,
  capture: CitationCapture | undefined,
): CitationSpan | undefined {
  if (!capture) return undefined
  const span = object(value)
  const startByte = span.startByte
  const endByte = span.endByte
  if (!natural(startByte) || !natural(endByte)) return undefined
  if (startByte >= endByte || endByte > capture.textBytes) return undefined
  return { startByte, endByte }
}

/** Where a source's evidence came from, for the reader's label. Three
 * states the wire itself proves: a search hit is discovery; a page read with
 * a well-formed capture is retained evidence with reopenable offsets; a
 * page read without one was inspected but not kept. */
export function citationEvidenceKind(
  source: Pick<CitationSource, 'sourceKind' | 'capture'>,
): 'discovery' | 'preview' | 'retained' {
  if (source.capture) return 'retained'
  return source.sourceKind === 'web_search' ? 'discovery' : 'preview'
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
  // Inspect every explicit claim before assigning URL-only evidence. A later
  // second ID invalidates an earlier weak URL association in this message.
  const explicitIdsByUrl = new Map<string, Set<string>>()
  for (const part of content) {
    if (part.type !== 'data' || part.name !== 'theorem-citation') continue
    const data = object(part.data)
    const sourceId = str(data.sourceId)
    const url = citationUrl(object(data.provenance).url)
    if (!sourceId || !url) continue
    const ids = explicitIdsByUrl.get(url) ?? new Set<string>()
    ids.add(sourceId)
    explicitIdsByUrl.set(url, ids)
  }
  const sources: CitationSource[] = []
  const byId = new Map<string, CitationSource>()
  const reservedKeys = new Set<string>()
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
      const ambiguous = (explicitIdsByUrl.get(url)?.size ?? 0) > 1
      const matches = sources.filter(
        (candidate) =>
          candidate.url === url &&
          // Ambiguous URLs group anonymous repeats, but never cross an ID boundary.
          (ambiguous
            ? !sourceId && !candidate.sourceId
            : !sourceId || !candidate.sourceId),
      )
      // Keep repeated URL-only passages in their own unattributed group.
      // A URL alone cannot choose between several explicit source IDs.
      const anonymousMatches = matches.filter(
        (candidate) => !candidate.sourceId,
      )
      if (anonymousMatches.length === 1) source = anonymousMatches[0]
      else if (matches.length === 1) source = matches[0]
    }
    if (!source) {
      const preferredKey = sourceId
        ? `id:${sourceId}`
        : url
          ? `url:${url}`
          : fallbackKey
      source = {
        // Enrichment keeps an earlier key even if its source changes URL.
        key: reservedKeys.has(preferredKey) ? fallbackKey : preferredKey,
        label: label ?? (url && new URL(url).hostname) ?? 'Source',
        url,
        sourceId,
        sourceKind,
        capture: undefined,
        provenance: {},
        passages: [],
      }
      sources.push(source)
      reservedKeys.add(source.key)
    }
    source.sourceId ??= sourceId
    source.sourceKind = sourceKind ?? source.sourceKind
    source.url = url ?? source.url
    source.label =
      label ??
      (source.label === 'Source' && url ? new URL(url).hostname : source.label)
    // The complete passage belongs below; source metadata must not imply the
    // last excerpt is the only evidence this source contributed. The capture
    // and its span are parsed once here, at the wire boundary: an
    // unverifiable reference names no capture and no offsets, and the
    // generic provenance keeps only the validated forms, so junk from the
    // wire is neither rendered nor forwarded into a context reference.
    const declared =
      provenance.source === undefined
        ? undefined
        : citationCapture(provenance.source)
    const capture = declared ?? source.capture
    source.capture = capture
    // A span qualifies the excerpt it travelled with, measured against that
    // citation's own capture when it named one.
    const span = citationSpan(
      provenance.span,
      provenance.source === undefined ? source.capture : declared,
    )
    const metadata = { ...provenance }
    delete metadata.excerpt
    delete metadata.span
    if ('source' in metadata) {
      if (declared) metadata.source = declared
      else delete metadata.source
    }
    source.provenance = { ...source.provenance, ...metadata }
    if (source.sourceId) byId.set(source.sourceId, source)
    if (excerpt) {
      const previous = source.passages.find(
        (passage) =>
          passage.excerpt === excerpt &&
          JSON.stringify(passage.span) === JSON.stringify(span),
      )
      if (previous) {
        previous.provenance = { ...previous.provenance, ...metadata }
        previous.span ??= span
      } else source.passages.push({ excerpt, span, provenance: metadata })
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
  // cut a quote or manufacture a locator: the full evidence is in that
  // message. The compacted envelope still names the retained capture, so a
  // later turn can reopen the exact version instead of refetching the URL.
  const compact = {
    ...reference,
    label: [...source.label].slice(0, 256).join(''),
    excerpt: JSON.stringify({
      schema: CITATION_CONTEXT_SCHEMA,
      citation: {
        ...identity,
        ...(source.capture
          ? {
              capture: {
                handle: source.capture.handle,
                version: source.capture.version,
              },
            }
          : {}),
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
