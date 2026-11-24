import type { TheoremContextReference } from '@theoremharness/sdk'

type Json = Record<string, unknown>
type CitationPart = { type: string; name?: string; id?: string; data?: unknown }

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
  /** The stored citation part this passage came from. Theorem's
   * retained-passage opener takes (messageId, partId), so a card grouped
   * under one sourceId still names which observation each passage was. */
  partId: string | undefined
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
 * still be opened; no label here may read as a permission or revocation
 * verdict before a native open route exists. */
export interface CitationCapture {
  handle: string
  version: string
  extractionVersion: string
  textBasis: string
  textBytes: number
  /** Mirrors the Rust `SourceCoverage` serde output exactly: the enum's
   * container-level `rename_all` renames only variant NAMES, and the owner
   * sets no `rename_all_fields`, so the cap travels snake_case inside an
   * otherwise camelCase `SourceRef`. Verified in independent review by
   * compiling a replica of the attributes against the locked serde_derive.
   * `unknown` is this UI's honest fourth state, never a wire value: it
   * appears when the Rust owner adds a coverage variant before this mirror
   * learns it — the capture identity is still real, its completeness is
   * not. */
  coverage:
    | { status: 'complete' }
    | { status: 'acquisition_capped'; limit_bytes: number }
    | { status: 'unknown' }
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
  if (coverage.status === 'acquisition_capped' && natural(coverage.limit_bytes))
    return {
      handle,
      version,
      extractionVersion,
      textBasis,
      textBytes: ref.textBytes,
      coverage: {
        status: 'acquisition_capped',
        limit_bytes: coverage.limit_bytes,
      },
    }
  // A coverage status this build does not know says nothing about the
  // identity beside it: keep the capture, admit the gap, and never guess
  // completeness from silence.
  if (typeof coverage.status === 'string')
    return {
      handle,
      version,
      extractionVersion,
      textBasis,
      textBytes: ref.textBytes,
      coverage: { status: 'unknown' },
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

/** Where a source's evidence came from, for the reader's label. Two states
 * the wire itself proves: a search hit is discovery; a citation carrying a
 * well-formed capture is retained evidence with exact byte offsets into its
 * version. Everything else — a page read, or any citation whose capture
 * reference is absent, malformed or from before the capture wire existed —
 * is simply "no capture reference", which says nothing about whether the
 * page was kept. A handle is a reference, not authority: until a native
 * open route is wired, only the server's bounded `source_read` can answer
 * whether a capture can still be opened, and a stale or revoked one is
 * answered there, never from historical metadata. */
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
    // The SDK carries the stored part ID on the assistant-ui part's own
    // `id` across both assembly paths (stream and history hydration). Its
    // citation order also survives appends/reload, so keep using that order
    // when no source identity exists.
    const fallbackKey = `part:${citationIndex++}`
    const partId = str(part.id)
    const data = object(part.data)
    const provenance = supplied(object(data.provenance))
    const sourceId = str(data.sourceId)
    const sourceKind = str(data.sourceKind)
    const url = citationUrl(provenance.url)
    const label = str(data.label)
    const excerpt = str(provenance.excerpt)
    // Parse the declared capture once, at the wire boundary: an
    // unverifiable reference names no capture, and junk from the wire is
    // neither rendered nor forwarded into a context reference.
    const declared =
      provenance.source === undefined
        ? undefined
        : citationCapture(provenance.source)
    let source = sourceId ? byId.get(sourceId) : undefined
    if (!source && url) {
      const ambiguous = (explicitIdsByUrl.get(url)?.size ?? 0) > 1
      const matches = sources.filter(
        (candidate) =>
          candidate.url === url &&
          // Two distinct captures never share a card, even anonymously:
          // different handles mean different evidence.
          !(declared && candidate.capture?.handle !== declared.handle) &&
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
    // last excerpt is the only evidence this source contributed. The first
    // well-formed capture a source ever declares is its identity: later
    // conflicting references never flip the card's version.
    source.capture ??= declared
    // A span qualifies only the excerpt it travelled with, measured against
    // the capture declared by the same citation. The wire always pairs them;
    // a span arriving without its own source names no text, and is not
    // retroactively adopted from a sibling's capture.
    const span = citationSpan(provenance.span, declared)
    const metadata = { ...provenance }
    delete metadata.excerpt
    delete metadata.span
    // The capture belongs on the source, once; passages repeat it only by
    // reference, so a many-passage envelope stays small.
    delete metadata.source
    source.provenance = { ...source.provenance, ...metadata }
    if (source.capture) source.provenance.source = source.capture
    if (source.sourceId) byId.set(source.sourceId, source)
    if (excerpt) {
      // Same quote, and no contradicting offsets: one passage. A later
      // observation that proves a span enriches the earlier one instead of
      // duplicating the row.
      const previous = source.passages.find(
        (passage) =>
          passage.excerpt === excerpt &&
          (passage.span === undefined ||
            span === undefined ||
            (passage.span.startByte === span.startByte &&
              passage.span.endByte === span.endByte)),
      )
      if (previous) {
        previous.provenance = { ...previous.provenance, ...metadata }
        previous.span ??= span
        previous.partId ??= partId
      } else
        source.passages.push({ partId, excerpt, span, provenance: metadata })
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
 * supported excerpt field so it survives send, recovery and transcript
 * reload. `runId` names the run that produced the citations, when the
 * caller knows it (the message's `metadata.custom.theoremRunId`); it is
 * carried so the reopened context keeps its run provenance too.
 */
export function citationContextReference(
  source: CitationSource,
  threadId: string,
  messageId: string,
  runId?: string,
): TheoremContextReference {
  const identity = {
    key: source.key,
    sourceId: source.sourceId,
    sourceKind: source.sourceKind,
    url: source.url,
    ...(runId ? { runId } : {}),
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
        // The offsets and part identities survive compaction even when the
        // quotes do not: they are a few hundred bytes and name exactly which
        // retained text, in which stored citation part, the referenced
        // message holds.
        ...(source.passages.some((passage) => passage.span)
          ? {
              spans: source.passages.flatMap((passage) =>
                passage.span ? [passage.span] : [],
              ),
            }
          : {}),
        ...(source.passages.some((passage) => passage.partId)
          ? {
              partIds: source.passages.flatMap((passage) =>
                passage.partId ? [passage.partId] : [],
              ),
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
