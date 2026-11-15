// SOURCING: none — the cabinet's semantic contracts (SPEC-THEOREM-ARTIFACT-
// CABINET-1.0 §5, §9, §10, §11) over the existing artifact registry and
// appearance owner; no library models them.
//
// What a cabinet card is, what its preview depends on, which preview mode is
// in effect, and which presentations a gallery may ever show. The cabinet
// controller, the worker and the host all read these; none of them restates
// the rules.
import { RUNGS, resolve } from '@/lib/artifacts/contributions'
import type {
  ArtifactContribution,
  ArtifactSubject,
  Availability,
  Distance,
  Representation,
} from '@/lib/artifacts/contributions'
import type { AppearancePreset } from '@/lib/appearance'

export type PreviewPreference = 'pixel' | 'full_fidelity'
export type PreviewMode = PreviewPreference

/** §5.1: an explicit preference wins; otherwise the preset's default. */
export const PRESET_PREVIEW: Record<AppearancePreset, PreviewMode> = {
  expressive: 'pixel',
  calm: 'full_fidelity',
}

export function effectivePreviewMode(
  preset: AppearancePreset,
  preference: PreviewPreference | undefined,
): PreviewMode {
  return preference ?? PRESET_PREVIEW[preset]
}

export type DescriptionProvenance = 'authored' | 'metadata' | 'derived'

export type CatalogKind =
  'document' | 'image' | 'app' | 'code' | 'diagram' | 'chart' | 'other'

/** §9.1. One card: an artifact (or upload) at the revision it represents. */
export type CatalogEntry = {
  /** Deduplication key: artifact identity, never the title. */
  key: string
  projectId: string
  source:
    | { type: 'artifact'; artifactId: string; revision: string }
    | { type: 'upload'; uploadId: string; revision: string }
    /** A review opens through the review dock, its own owner. */
    | { type: 'review'; reviewId: string; revision: string }
  /** The session it came from: a reference, never a navigation. */
  threadId: string
  kind: CatalogKind
  /** The verified media type, or '' when the source names none. */
  mediaType: string
  title: string
  description: { text: string; provenance: DescriptionProvenance }
  revisionCount: number
  updatedAtMs: number
}

export function revisionOf(entry: CatalogEntry): string {
  return entry.source.revision
}

/** Recent order: accepted time descending, identity breaking ties (§3.3). */
export function byRecent(a: CatalogEntry, b: CatalogEntry): number {
  return (
    b.updatedAtMs - a.updatedAtMs ||
    (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
  )
}

/** The factual line a card shows when nothing summarizes its content (§9.1). */
export function factualDescription(
  kind: CatalogKind,
  mediaType: string,
): string {
  const what =
    mediaType === 'application/pdf'
      ? 'PDF document'
      : mediaType.startsWith('image/')
        ? `${mediaType.slice(6).toUpperCase()} image`
        : {
            document: 'Document',
            image: 'Image',
            app: 'App',
            code: 'Code',
            diagram: 'Diagram',
            chart: 'Chart',
            other: 'File',
          }[kind]
  return `${what}; preview unavailable.`
}

/** §10: what a preview's pixels depend on. A palette change does not move them. */
export type GeometryKey = {
  sourceDigest: string
  revision: string
  recipe: string
  recipeVersion: number
  rendererVersion: number
  profile: string
}

export const geometryId = (k: GeometryKey) =>
  [
    k.sourceDigest,
    k.revision,
    `${k.recipe}@${k.recipeVersion}`,
    `r${k.rendererVersion}`,
    k.profile,
  ].join('|')

/** What a visible preview depends on: geometry, mode and, for pixel art only, the palette. */
export function presentationId(
  geometry: GeometryKey,
  mode: PreviewMode,
  paletteDigest: string,
): string {
  return `${geometryId(geometry)}|${mode}${mode === 'pixel' ? `|${paletteDigest}` : ''}`
}

/**
 * §10: the identity an async result must still match before it replaces a
 * card's visible preview. It may still fill a correctly keyed cache.
 */
export type PublishGuard = {
  scope: string
  revision: string
  generation: number
  mode: PreviewMode
  paletteDigest: string
}

export function mayPublish(
  result: PublishGuard,
  current: PublishGuard,
): boolean {
  return (
    result.scope === current.scope &&
    result.revision === current.revision &&
    result.generation === current.generation &&
    result.mode === current.mode &&
    (result.mode !== 'pixel' || result.paletteDigest === current.paletteDigest)
  )
}

/**
 * §11: a gallery resolves only presentations that hold no live session. The
 * registry's own walk from `preview` to `thing` would reach a live app when
 * the preview renderer is missing; this resolution cannot, because live
 * presentations are not offered to it at all.
 */
export function inertRepresentation(
  subject: ArtifactSubject,
  distance: Extract<Distance, 'landmark' | 'preview'>,
  contributions: ReadonlyArray<ArtifactContribution>,
  available: (renderer: string) => Availability,
  /** Renderers that run source markup or scripts: never inert, whatever they declare. */
  executes: ReadonlySet<string> = EXECUTING_RENDERERS,
): Representation {
  const inert = contributions
    .map((c) => ({
      ...c,
      presentations: c.presentations.filter(
        (p) =>
          p.session === 'none' &&
          p.cost === 'cache' &&
          !executes.has(p.renderer),
      ),
    }))
    .filter((c) => c.presentations.length > 0)
  const r = resolve(subject, distance, inert, available)
  if (r.session !== 'none')
    throw new Error('unreachable: live presentation resolved inert')
  return r
}

/**
 * The app preview renders the app's own markup in a frame: inert to the
 * registry's accounting, not to §11's. The cabinet draws apps from a static
 * reading of their markup instead.
 */
export const EXECUTING_RENDERERS: ReadonlySet<string> = new Set([
  'theorem-app.preview',
])

export { RUNGS }
