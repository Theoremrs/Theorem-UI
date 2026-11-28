// SOURCING: zod 4 (the bundle is parsed against its schema before any of it
// is used) over ./release digests and ./ownership layers. OWN-04: an export
// holds source, manifest, resolved dependencies, settings, page composition,
// provenance and references to data a person chose to include. It never holds
// grants or secrets; an import checks identity, digests and compatibility and
// never attaches a database that is not this user's own.
import { z } from 'zod'
import { digestOf } from './digest'
import { sourceDigestOf, dataAccess, hostDiagnostics } from './release'
import type { DataAccess } from './release'
import type { OwnedModule } from './ownership'
import type { ModuleRecord } from './state'
import type { Diagnostic, Release } from './types'
import { HOST_API } from './types'

export const BUNDLE_SCHEMA = 'theorem.app-bundle/1'

const range = z.object({ min: z.number().int(), max: z.number().int() })
const provenance = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('shipped'),
    channel: z.string(),
    revision: z.string(),
  }),
  z.object({ kind: z.literal('user-authored') }),
  z.object({
    kind: z.literal('fork'),
    upstreamId: z.string(),
    upstreamRevision: z.string(),
  }),
])

/** A reference to data the exporter chose to include; the data itself is not in the bundle. */
const dataReference = z.object({
  name: z.string(),
  /** The provider that holds it: `rustyred-opfs`, `theorem-records`, an adapter id. */
  provider: z.string(),
  /** Who owned it when exported. An import never binds data owned by someone else. */
  owner: z.string(),
  schemaVersion: z.number().int(),
  ref: z.string(),
})
export type DataReference = z.infer<typeof dataReference>

export const appBundle = z.object({
  schema: z.literal(BUNDLE_SCHEMA),
  identity: z.string().min(1),
  exportedAt: z.number(),
  release: z.object({
    sourceDigest: z.string(),
    manifestDigest: z.string(),
    entryPoints: z.array(z.string()),
    dependencies: z.array(
      z.object({
        specifier: z.string(),
        kind: z.enum(['vendor', 'url', 'library']),
        resolved: z.string(),
        contentDigest: z.string().optional(),
      }),
    ),
    host: z.object({ api: z.string(), minVersion: z.number() }),
    data: z.object({ reads: range, writes: range }),
    provenance,
    version: z.number().int(),
  }),
  manifestPath: z.string(),
  files: z.record(z.string(), z.string()),
  settings: z.record(z.string(), z.unknown()),
  pages: z.array(z.object({ path: z.string(), text: z.string() })),
  data: z.array(dataReference),
})
export type AppBundle = z.infer<typeof appBundle>

const SECRET_KEY =
  /secret|token|password|passwd|credential|api[-_]?key|authorization|grant|bearer/i

/** Settings with secret-looking keys, at any depth, left out; the paths left out are named. */
export function withoutSecrets(settings: Record<string, unknown>): {
  kept: Record<string, unknown>
  omitted: string[]
} {
  const omitted: string[] = []
  const walk = (value: unknown, path: string): unknown => {
    if (Array.isArray(value))
      return value.map((v, i) => walk(v, `${path}[${i}]`))
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value).flatMap(([key, inner]) => {
          const here = path ? `${path}.${key}` : key
          if (SECRET_KEY.test(key)) {
            omitted.push(here)
            return []
          }
          return [[key, walk(inner, here)]]
        }),
      )
    return value
  }
  return { kept: walk(settings, '') as Record<string, unknown>, omitted }
}

export interface ExportInput {
  release: Release
  manifestPath: string
  owned?: OwnedModule
  /** Page files that wire the module, as composition: path and text. */
  pages?: Array<{ path: string; text: string }>
  /** Every reference that could be exported; only those named in `selected` go in. */
  availableData?: DataReference[]
  /** Names of the data references the person chose. Default: none. */
  selected?: string[]
  at?: number
}

export interface ExportResult {
  bundle: AppBundle
  /** What was left out and why, for the person to read before sharing. */
  omitted: string[]
}

/** Builds a bundle. Grants are not an input, so they cannot be in it. */
export function exportBundle(input: ExportInput): ExportResult {
  const { release, owned } = input
  const secrets = withoutSecrets(owned?.settings ?? {})
  const chosen = new Set(input.selected ?? [])
  const data = (input.availableData ?? []).filter((d) => chosen.has(d.name))
  const left = (input.availableData ?? []).filter((d) => !chosen.has(d.name))
  return {
    bundle: {
      schema: BUNDLE_SCHEMA,
      identity: release.identity,
      exportedAt: input.at ?? Date.now(),
      release: {
        sourceDigest: release.sourceDigest,
        manifestDigest: release.manifestDigest,
        entryPoints: release.entryPoints,
        dependencies: release.dependencies,
        host: release.host,
        data: release.data,
        provenance: release.provenance,
        version: release.version,
      },
      manifestPath: input.manifestPath,
      files: release.files,
      settings: secrets.kept,
      pages: input.pages ?? [],
      data,
    },
    omitted: [
      ...secrets.omitted.map((p) => `setting ${p} (looks like a secret)`),
      ...left.map((d) => `data ${d.name} (not selected)`),
      'permission grants (never exported)',
    ],
  }
}

export interface ImportContext {
  /** The signed-in user's id; data owned by anyone else is never attached. */
  userId: string
  record?: ModuleRecord
  /** Identities already taken, including modules this bundle is not an update of. */
  taken?: ReadonlySet<string>
  hostVersion?: number
}

export type ImportPlan =
  | { status: 'refused'; diagnostics: Diagnostic[] }
  | {
      status: 'already-installed'
      releaseId?: string
      diagnostics: Diagnostic[]
    }
  | {
      /** Same identity, different code: a new release of it, or an explicit separate copy. */
      status: 'conflict'
      options: Array<'new-release' | 'install-as-copy'>
      copyIdentity: string
      diagnostics: Diagnostic[]
      rebind: Rebinding
    }
  | { status: 'ready'; diagnostics: Diagnostic[]; rebind: Rebinding }

/** What happens to the data the bundle points at. */
export interface Rebinding {
  /** Retained data of this identity that the imported code would bind to. */
  retained: { dataVersion: number; access: DataAccess } | undefined
  /** References accepted as the importer's own, awaiting the provider's own authorization. */
  references: DataReference[]
  /** References owned by someone else: listed, never attached. */
  foreign: DataReference[]
}

const refuse = (message: string, hint?: string): ImportPlan => ({
  status: 'refused',
  diagnostics: [
    { stage: 'resolve', severity: 'error', message, ...(hint ? { hint } : {}) },
  ],
})

/** A new id for an explicit copy: never the original's, never one already taken. */
export function copyIdentity(
  identity: string,
  taken: ReadonlySet<string>,
): string {
  let id = `${identity}-copy`
  for (let n = 2; taken.has(id); n++) id = `${identity}-copy-${n}`
  return id
}

/**
 * Validates a bundle against this host and what it already holds. The plan
 * never installs anything: a ready plan goes through the same activation
 * sequence as any release, which asks for the authority it actually needs.
 */
export async function planImport(
  raw: unknown,
  context: ImportContext,
): Promise<ImportPlan> {
  const parsed = appBundle.safeParse(raw)
  if (!parsed.success)
    return refuse(
      `This is not an app bundle: ${parsed.error.issues[0]?.path.join('.') || 'it'} ${parsed.error.issues[0]?.message ?? 'is invalid'}.`,
    )
  const bundle = parsed.data
  const digest = await sourceDigestOf(bundle.files)
  if (digest !== bundle.release.sourceDigest)
    return refuse(
      'The files do not match the digest the bundle says they have.',
      'The bundle was changed or damaged. Export it again.',
    )
  if (!bundle.files[bundle.manifestPath])
    return refuse(`The bundle has no manifest at ${bundle.manifestPath}.`)
  const probe = {
    host: bundle.release.host,
  } as Release
  if (probe.host.api !== HOST_API)
    return refuse(
      `It is built for ${probe.host.api}; this host runs ${HOST_API}.`,
    )
  const host = hostDiagnostics(probe, context.hostVersion)
  if (host.length) return { status: 'refused', diagnostics: host }

  const record = context.record
  const retainedVersion = record?.dataVersion
  const rebind: Rebinding = {
    retained:
      retainedVersion === undefined
        ? undefined
        : {
            dataVersion: retainedVersion,
            access: dataAccess({ data: bundle.release.data }, retainedVersion),
          },
    references: bundle.data.filter((d) => d.owner === context.userId),
    foreign: bundle.data.filter((d) => d.owner !== context.userId),
  }
  const diagnostics: Diagnostic[] = []
  if (rebind.foreign.length)
    diagnostics.push({
      stage: 'prepare',
      severity: 'warning',
      message: `${rebind.foreign.length} data reference(s) belong to someone else and were not attached.`,
      hint: 'Ask the owner to share the data through its provider.',
    })
  if (rebind.retained?.access === 'export-only')
    return {
      status: 'refused',
      diagnostics: [
        {
          stage: 'prepare',
          severity: 'error',
          message: `Your retained data is at schema ${rebind.retained.dataVersion}, outside what this bundle's code can read.`,
          hint: 'Your data is kept. Import a newer release of the app.',
        },
      ],
    }
  const known = record?.releases.find(
    (r) => r.sourceDigest === bundle.release.sourceDigest,
  )
  if (known)
    return {
      status: 'already-installed',
      releaseId: known.releaseId,
      diagnostics,
    }
  const taken = context.taken ?? new Set<string>()
  if (record || taken.has(bundle.identity))
    return {
      status: 'conflict',
      options: record
        ? ['new-release', 'install-as-copy']
        : ['install-as-copy'],
      copyIdentity: copyIdentity(bundle.identity, taken),
      diagnostics,
      rebind,
    }
  return { status: 'ready', diagnostics, rebind }
}

/** The digest of a bundle's own content, for a person to compare. */
export const bundleDigest = (bundle: AppBundle) =>
  digestOf({ ...bundle, exportedAt: 0 })
