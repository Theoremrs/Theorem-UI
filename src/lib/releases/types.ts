// SOURCING: hand-rolled over the module contract (src/lib/modules/contract.ts)
// and the App dependency resolver (src/lib/blocks/app-dependencies.ts). A
// release is the record of one exact version of an App or module's code:
// what the host checks before it runs it and keeps so it can go back to it.
import type { RequestedCapabilities } from '@/lib/modules/contract'

/** The host API a release is built against, and the host's own version of it. */
export const HOST_API = 'theorem.module/1'
export const HOST_VERSION = 1

/** An inclusive range of data-schema versions. */
export interface DataRange {
  min: number
  max: number
}

/** Which data-schema versions a release can read and which it may write. */
export interface DataCompatibility {
  reads: DataRange
  writes: DataRange
}

/** Where a release's code came from (OWN-01). */
export type Provenance =
  | { kind: 'shipped'; channel: string; revision: string }
  | { kind: 'user-authored' }
  | { kind: 'fork'; upstreamId: string; upstreamRevision: string }

/** One resolved dependency: an exact version or URL, and the digest of the bytes it gave. */
export interface ResolvedDependency {
  specifier: string
  kind: 'vendor' | 'url' | 'library'
  /** The exact version, URL or vendored path it resolved to. */
  resolved: string
  /** Absent for a vendored or shipped library, whose identity is its path. */
  contentDigest?: string
}

export interface ReleaseHost {
  api: string
  /** The oldest host that can run it. */
  minVersion: number
}

/** The files a release is made of, by path, as text. */
export type ReleaseFiles = Record<string, string>

export interface Release {
  /** The digest of the release's own record (everything below but `at` and `files`). */
  releaseId: string
  /** The App's or module's stable id; it does not change with a revision. */
  identity: string
  /** The digest of every source file. */
  sourceDigest: string
  /** The digest of the manifest's text. */
  manifestDigest: string
  /** The digest a grant is bound to (the manifest and entry page together). */
  grantDigest: string
  entryPoints: string[]
  dependencies: ResolvedDependency[]
  host: ReleaseHost
  data: DataCompatibility
  provenance: Provenance
  /** What it asks to reach, kept so a later release can be compared with it. */
  requested: RequestedCapabilities
  /** The version the module declares for itself. */
  version: number
  /** The files themselves, kept so the release can be restored. */
  files: ReleaseFiles
  at: number
}

/** A problem with a candidate, in a form a person can act on. */
export interface Diagnostic {
  stage: ActivationStage
  severity: 'error' | 'warning'
  message: string
  /** The file it is in, when it is in one. */
  file?: string
  line?: number
  /** What to do about it. */
  hint?: string
}

export const ACTIVATION_STAGES = [
  'resolve',
  'validate',
  'compile',
  'preview',
  'prepare',
  'activate',
  'dispose',
] as const
export type ActivationStage = (typeof ACTIVATION_STAGES)[number]
