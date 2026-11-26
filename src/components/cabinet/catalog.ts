// SOURCING: lib/theorem/organization's project outputs (Theorem's cabinet
// catalog fields), the SDK's threads.get for a revision's stored parts, the
// upload content route through lib/theorem/uploads, and components/artifacts/
// artifact-model's readArtifact for the theorem-artifact-v1 part contract.
//
// From Theorem's outputs to cabinet cards, and from a card to the bounded
// source its preview reads. Reading a source never opens or switches a
// session (§9.3): the thread is read, not shown.
import { readArtifact } from '@/components/artifacts/artifact-model'
import type { TheoremArtifact } from '@/components/artifacts/artifact-model'
import { theorem } from '@/lib/theorem/client'
import type { OutputCategory, ProjectOutput } from '@/lib/theorem/organization'
import { readUpload, uploadContentPath } from '@/lib/theorem/uploads'
import { factualDescription } from './contract'
import type { CatalogEntry, CatalogKind } from './contract'

/** The longest text excerpt a recipe reads (terminal/src/preview TEXT_LIMIT). */
export const TEXT_LIMIT = 16 * 1024
/** Larger images are refused before decoding (§9.2 bounded work). */
export const IMAGE_BYTES_LIMIT = 24 * 1024 * 1024

const KIND_OF: Record<OutputCategory, CatalogKind> = {
  document: 'document',
  image: 'image',
  app: 'app',
  code: 'code',
  diagram: 'diagram',
  chart: 'chart',
  review: 'other',
  other: 'other',
}

/** The revision an output stands for, as a string the open command pins. */
export function revisionText(output: ProjectOutput): string {
  const r = output.revision
  if (typeof r === 'string') return r
  if (typeof r === 'number') return String(r)
  if (r && typeof r === 'object') {
    const o = r as Record<string, unknown>
    for (const k of ['artifactRevision', 'revision', 'position', 'id'])
      if (typeof o[k] === 'string' || typeof o[k] === 'number')
        return String(o[k])
  }
  return output.digest ?? `${output.updatedAtMs}`
}

/** One card per output identity; the newest revision Theorem listed wins. */
export function toEntry(
  projectId: string,
  output: ProjectOutput,
): CatalogEntry {
  const kind = KIND_OF[output.category ?? 'other']
  const mediaType = output.mediaType ?? ''
  const revision = revisionText(output)
  return {
    key: output.outputId,
    projectId,
    source: output.uploadId
      ? { type: 'upload', uploadId: output.uploadId, revision }
      : output.reviewId
        ? { type: 'review', reviewId: output.reviewId, revision }
        : {
            type: 'artifact',
            artifactId: output.artifactId ?? output.outputId,
            revision,
          },
    threadId: output.threadId,
    kind,
    mediaType,
    title: output.title,
    description: output.description ?? {
      text: factualDescription(kind, mediaType),
      provenance: 'metadata',
    },
    revisionCount: output.revisionCount,
    updatedAtMs: output.updatedAtMs,
  }
}

const KIND_LABEL: Record<CatalogKind, string> = {
  document: 'Document',
  image: 'Image',
  app: 'App',
  code: 'Code',
  diagram: 'Diagram',
  chart: 'Chart',
  other: 'File',
}

function bytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

/** The card's fact line: kind, format, size, revisions. Nothing inferred. */
export function metaLine(output: ProjectOutput, entry: CatalogEntry): string {
  const parts = [KIND_LABEL[entry.kind]]
  const sub = entry.mediaType.split(/[/+;]/)[1]
  if (sub && entry.kind !== 'app') parts.push(sub.toUpperCase())
  if (output.byteLen) parts.push(bytes(output.byteLen))
  if (entry.revisionCount > 1) parts.push(`${entry.revisionCount} revisions`)
  return parts.join(' · ')
}

/** What a preview reads: the recipe source, and decoded pixels for an image. */
export type PreviewSource = {
  source: {
    kind: string
    mediaType: string
    language?: string
    text?: string
    pixelArt?: boolean
  }
  image?: Blob
}

const TEXTUAL =
  /^(text\/|application\/(json|xml|javascript|x-ndjson|csv|yaml|toml|x-yaml)|image\/svg)/

/** Reads the represented revision, bounded, without touching the foreground thread. */
export async function readSource(entry: CatalogEntry): Promise<PreviewSource> {
  if (entry.source.type === 'upload') {
    const blob = await readUpload(uploadContentPath(entry.source.uploadId))
    const mediaType = entry.mediaType || blob.type
    if (mediaType.startsWith('image/') && !mediaType.startsWith('image/svg')) {
      if (blob.size > IMAGE_BYTES_LIMIT)
        throw new Error('too_large: image is over the preview read limit')
      return { source: { kind: 'image', mediaType }, image: blob }
    }
    if (TEXTUAL.test(mediaType) || /markdown/.test(mediaType)) {
      const text = await blob.slice(0, TEXT_LIMIT).text()
      return { source: { kind: entry.kind, mediaType, text } }
    }
    return { source: { kind: entry.kind, mediaType } }
  }
  // A review has no source a recipe reads: its type illustration stands in.
  if (entry.source.type === 'review')
    return { source: { kind: 'review', mediaType: entry.mediaType } }
  const artifact = await readArtifactRevision(
    entry.threadId,
    entry.source.artifactId,
    entry.source.revision,
  )
  if (!artifact)
    throw new Error('unavailable: the revision is not in its session')
  return {
    source: {
      kind: artifact.kind,
      mediaType: entry.mediaType,
      language: artifact.language,
      text: artifact.content.slice(0, TEXT_LIMIT),
    },
  }
}

/** One artifact revision from a thread's stored parts, read in place. */
export async function readArtifactRevision(
  threadId: string,
  artifactId: string,
  revision: string,
): Promise<TheoremArtifact | undefined> {
  const { messages } = await theorem().chat.threads.get({ threadId })
  for (const message of messages)
    for (const part of (message as { parts?: unknown[] }).parts ?? []) {
      const artifact = readArtifact(part)
      // Exactly the represented revision: never a newer one in its place.
      if (artifact?.artifactId === artifactId && artifact.revision === revision)
        return artifact
    }
  return undefined
}

/** Every revision of an artifact its session holds, in patch order, read in place. */
export async function readArtifactVersions(
  threadId: string,
  artifactId: string,
): Promise<TheoremArtifact[]> {
  const { messages } = await theorem().chat.threads.get({ threadId })
  const versions: TheoremArtifact[] = []
  for (const message of messages)
    for (const part of (message as { parts?: unknown[] }).parts ?? []) {
      const artifact = readArtifact(part)
      if (
        artifact?.artifactId === artifactId &&
        !versions.some((v) => v.revision === artifact.revision)
      )
        versions.push(artifact)
    }
  return versions.sort((a, b) => a.patchSequence - b.patchSequence)
}

/** The newest revision of an artifact its session holds, read in place. */
export async function readLatestArtifact(
  threadId: string,
  artifactId: string,
): Promise<TheoremArtifact | undefined> {
  const { messages } = await theorem().chat.threads.get({ threadId })
  let latest: TheoremArtifact | undefined
  for (const message of messages)
    for (const part of (message as { parts?: unknown[] }).parts ?? []) {
      const artifact = readArtifact(part)
      if (artifact?.artifactId === artifactId) latest = artifact
    }
  return latest
}

/**
 * A card describes its artifact in prose, so Markdown markers (headings,
 * list bullets, quotes, emphasis, table rules and pipes, fences) are dropped
 * and the words kept.
 */
export function plainText(text: string): string {
  return text
    .split('\n')
    .map((line) =>
      line
        .replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/, '')
        .replace(
          /^\s*(```.*|\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?)\s*$/,
          '',
        )
        .replace(/^\s*\|\s*|\s*\|\s*$/g, '')
        .replace(/\s*\|\s*/g, ' · ')
        .replace(/(\*\*|__|`)(.+?)\1/g, '$2')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .trim(),
    )
    .filter(Boolean)
    .join(' ')
}
