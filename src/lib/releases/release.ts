// SOURCING: hand-rolled over ./digest and the module grant digest
// (src/lib/modules/grants.ts moduleDigest). Release identity is the stable
// App/module id; the record names exact content, so two builds of the same
// files are one release.
import type { RequestedCapabilities } from '@/lib/modules/contract'
import { moduleDigest } from '@/lib/modules/grants'
import { digestOf, sha256, stableJson } from './digest'
import { HOST_API, HOST_VERSION } from './types'
import type {
  DataCompatibility,
  DataRange,
  Diagnostic,
  Provenance,
  Release,
  ReleaseFiles,
  ResolvedDependency,
} from './types'

export interface ReleaseInput {
  identity: string
  files: ReleaseFiles
  /** The manifest's path in `files`. */
  manifestPath: string
  entryPoints: string[]
  dependencies: ResolvedDependency[]
  requested: RequestedCapabilities
  version?: number
  minHostVersion?: number
  data?: DataCompatibility
  provenance?: Provenance
  at?: number
}

const ONE: DataRange = { min: 1, max: 1 }
export const DEFAULT_DATA: DataCompatibility = { reads: ONE, writes: ONE }

/** The digest of every file, order and path included. */
export const sourceDigestOf = (files: ReleaseFiles) => digestOf(files)

/** Builds the record of one release from its exact files. */
export async function buildRelease(input: ReleaseInput): Promise<Release> {
  const manifest = input.files[input.manifestPath] ?? ''
  const entry = input.entryPoints[0]
  const page = entry === undefined ? '' : (input.files[entry] ?? '')
  const body = {
    identity: input.identity,
    sourceDigest: await sourceDigestOf(input.files),
    manifestDigest: await sha256(manifest),
    grantDigest: await moduleDigest(manifest, page),
    entryPoints: input.entryPoints,
    dependencies: input.dependencies,
    host: { api: HOST_API, minVersion: input.minHostVersion ?? 1 },
    data: input.data ?? DEFAULT_DATA,
    provenance: input.provenance ?? { kind: 'user-authored' },
    requested: input.requested,
    version: input.version ?? 1,
  } as const
  return {
    releaseId: await sha256(stableJson(body)),
    ...body,
    entryPoints: [...body.entryPoints],
    dependencies: [...body.dependencies],
    host: { ...body.host },
    files: { ...input.files },
    at: input.at ?? Date.now(),
  }
}

/** Whether this host can run the release. */
export function hostDiagnostics(
  release: Release,
  hostVersion = HOST_VERSION,
): Diagnostic[] {
  if (release.host.api !== HOST_API)
    return [
      {
        stage: 'validate',
        severity: 'error',
        message: `It is built for ${release.host.api}; this host runs ${HOST_API}.`,
        hint: 'Use a release built for this host, or update the host.',
      },
    ]
  if (release.host.minVersion > hostVersion)
    return [
      {
        stage: 'validate',
        severity: 'error',
        message: `It needs host version ${release.host.minVersion}; this host is version ${hostVersion}.`,
        hint: 'Update Theorem, or keep the release you have.',
      },
    ]
  return []
}

const within = (range: DataRange, version: number) =>
  version >= range.min && version <= range.max

/**
 * What a release may do with a database at `dataVersion` (OWN-03). Having been
 * a working release gives no write access to a newer database: outside its
 * write range it can only read, or, outside that too, only export.
 */
export type DataAccess = 'read-write' | 'read-only' | 'export-only'

export function dataAccess(
  release: Pick<Release, 'data'>,
  dataVersion: number | undefined,
): DataAccess {
  if (dataVersion === undefined) return 'read-write'
  if (within(release.data.writes, dataVersion)) return 'read-write'
  if (within(release.data.reads, dataVersion)) return 'read-only'
  return 'export-only'
}

/** A sentence about what the data's version means for a release. */
export function dataAccessDiagnostics(
  access: DataAccess,
  dataVersion: number | undefined,
  stage: Diagnostic['stage'] = 'prepare',
): Diagnostic[] {
  if (access === 'read-write') return []
  return [
    {
      stage,
      severity: access === 'export-only' ? 'error' : 'warning',
      message:
        access === 'read-only'
          ? `The data is at schema version ${dataVersion}, newer than this release can write. It can read it but not change it.`
          : `The data is at schema version ${dataVersion}, outside what this release can read or write. It can only export it.`,
      hint: 'Your data is kept as it is. Switching code does not roll the data back.',
    },
  ]
}
