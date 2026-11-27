// SOURCING: hand-rolled state machine over ./state (the record of releases),
// ./release (host and data compatibility), src/lib/modules/grants.ts (grant
// authority, digest-bound) and ./instance-scope (disposal). Spec EXEC-04:
// resolve, compile, preview with read-only capabilities, prepare, activate
// with a revision check, dispose. Every I/O step is a port, so the sequence
// itself runs the same in a test as in the app.
import type { RequestedCapabilities } from '@/lib/modules/contract'
import type { Authority, Grant, RevisionPolicy } from '@/lib/modules/grants'
import { authorityFor } from '@/lib/modules/grants'
import { activeInstances } from './instance-scope'
import type { InstanceScope } from './instance-scope'
import { dataAccess, dataAccessDiagnostics, hostDiagnostics } from './release'
import type { DataAccess } from './release'
import {
  addHistory,
  commitActive,
  emptyRecord,
  failCandidate,
  hold,
  activeRelease,
} from './state'
import type { ModuleRecord } from './state'
import type { ActivationStage, Diagnostic, Release } from './types'

/** What a candidate is made from before it is resolved. */
export interface CandidateInput {
  identity: string
  /** The files as they are now, by path. */
  files: Record<string, string>
  /** Where it came from, for the resolver's diagnostics. */
  label?: string
}

/** What the preview may reach: read-only and fixture capabilities, never mutation or background. */
export interface PreviewCapabilities {
  readonly capabilities: RequestedCapabilities
  /** Every write the preview tried; the guard denies each, so none is performed. */
  readonly attemptedWrites: ReadonlyArray<string>
  /** A preview calls this where a real run would write; it always throws. */
  denyWrite: (what: string) => never
}

export class PreviewDenied extends Error {
  constructor(what: string) {
    super(`The preview may not ${what}: validation runs with read-only access`)
    this.name = 'PreviewDenied'
  }
}

/** The capabilities a preview gets: reads and describe/query only; no write, state, net or invoke. */
export function previewCapabilities(
  requested: RequestedCapabilities,
): PreviewCapabilities {
  const attempted: string[] = []
  return {
    capabilities: {
      read: [...requested.read],
      write: [],
      state: [],
      net: [],
      ...(requested.instances
        ? {
            instances: requested.instances.flatMap((one) => {
              const methods = one.methods.filter((m) => m !== 'invoke')
              return methods.length
                ? [{ instanceId: one.instanceId, methods, actions: [] }]
                : []
            }),
          }
        : {}),
    },
    get attemptedWrites() {
      return attempted
    },
    denyWrite(what) {
      attempted.push(what)
      throw new PreviewDenied(what)
    },
  }
}

/** A refusal from a port, carrying diagnostics a person can act on. */
export class StageFailure extends Error {
  constructor(readonly diagnostics: Diagnostic[]) {
    super(diagnostics.map((d) => d.message).join('; '))
    this.name = 'StageFailure'
  }
}

export interface ActivationPorts {
  /** Reads the files and resolves manifest, source and dependency digests into a release. */
  resolve: (input: CandidateInput) => Promise<Release>
  /** Manifest and API compatibility beyond what the host check covers. */
  validate?: (release: Release) => Promise<Diagnostic[]>
  /** Compiles and runs structural checks. */
  compile: (release: Release) => Promise<Diagnostic[]>
  /** Evaluates initialization in an isolated preview that has only `preview`'s capabilities. */
  preview: (
    release: Release,
    preview: PreviewCapabilities,
  ) => Promise<Diagnostic[]>
  /** Prepares the view-state migration from the active release's shape to the candidate's. */
  prepareView?: (
    from: Release | undefined,
    to: Release,
  ) => Promise<Diagnostic[]>
  /** The grant and policy held for this module, read from the host-owned store. */
  authority: (identity: string) => {
    grant: Grant | undefined
    policy: RevisionPolicy | undefined
  }
  /** Starts the candidate's running instance; the old one is disposed once this one is active. */
  instantiate?: (release: Release) => InstanceScope
  now?: () => number
}

/** Where the records live; `update` is atomic, as a zustand set is. */
export interface RecordAccess {
  get: (identity: string) => ModuleRecord | undefined
  update: (
    identity: string,
    change: (record: ModuleRecord) => ModuleRecord,
  ) => void
}

export type ActivationOutcome =
  | {
      status: 'activated'
      release: Release
      access: DataAccess
      authority: Authority
      warnings: Diagnostic[]
      /** Cleanups that threw while the replaced instance was disposed. */
      disposeFailures: unknown[]
      trace: ActivationStage[]
    }
  | {
      status: 'unchanged'
      release: Release
      trace: ActivationStage[]
    }
  | {
      status: 'awaiting-grant'
      release: Release
      authority: Extract<Authority, { kind: 'needs-grant' }>
      warnings: Diagnostic[]
      trace: ActivationStage[]
    }
  | {
      status: 'failed'
      stage: ActivationStage
      diagnostics: Diagnostic[]
      /** The release that is still running; the failure did not touch it. */
      retained: Release | undefined
      /** True when the failure is that the module changed meanwhile and trying again may succeed. */
      retryable: boolean
      trace: ActivationStage[]
    }

const failure = (
  stage: ActivationStage,
  message: string,
  hint?: string,
): Diagnostic => ({
  stage,
  severity: 'error',
  message,
  ...(hint ? { hint } : {}),
})

/** A thrown value as diagnostics for a stage. */
function diagnosticsOf(stage: ActivationStage, error: unknown): Diagnostic[] {
  if (error instanceof StageFailure) return error.diagnostics
  // Any refusal that carries its own diagnostics (a dependency that did not resolve).
  const carried = (error as { diagnostics?: unknown } | null)?.diagnostics
  if (Array.isArray(carried) && carried.length) return carried as Diagnostic[]
  return [
    failure(
      stage,
      error instanceof Error ? error.message : String(error),
      'Fix it and save again; the release you had keeps running.',
    ),
  ]
}

/**
 * Runs the activation sequence for one candidate. A candidate that fails at any
 * stage leaves the active release, its recovery targets and the drafts as they
 * were; the only thing recorded is the candidate's diagnostics. Nothing in the
 * sequence before `activate` writes application data: the preview is given
 * read-only capabilities and its attempted writes are denied.
 */
export async function activateCandidate(
  input: CandidateInput,
  ports: ActivationPorts,
  records: RecordAccess,
): Promise<ActivationOutcome> {
  const now = ports.now ?? Date.now
  const trace: ActivationStage[] = []
  const before = records.get(input.identity) ?? emptyRecord(input.identity)
  const retained = activeRelease(before)

  const stop = (
    stage: ActivationStage,
    diagnostics: Diagnostic[],
    release?: Release,
    retryable = false,
  ): ActivationOutcome => {
    records.update(input.identity, (record) =>
      failCandidate(record, {
        releaseId: release?.releaseId,
        stage,
        diagnostics,
        at: now(),
      }),
    )
    return { status: 'failed', stage, diagnostics, retained, retryable, trace }
  }

  // 1. Resolve source and dependency digests; validate the manifest and host API.
  let release: Release
  try {
    release = await ports.resolve(input)
    trace.push('resolve')
  } catch (error) {
    return stop('resolve', diagnosticsOf('resolve', error))
  }
  if (release.identity !== input.identity)
    return stop(
      'resolve',
      [
        failure(
          'resolve',
          `The files say they are ${release.identity}, not ${input.identity}.`,
          'A module keeps its id across releases; changing it makes a different module.',
        ),
      ],
      release,
    )
  if (retained?.releaseId === release.releaseId)
    return { status: 'unchanged', release, trace }
  try {
    const problems = [
      ...hostDiagnostics(release),
      ...((await ports.validate?.(release)) ?? []),
    ]
    if (problems.some((d) => d.severity === 'error'))
      return stop('validate', problems, release)
    trace.push('validate')
  } catch (error) {
    return stop('validate', diagnosticsOf('validate', error), release)
  }

  // 2. Compile and run structural checks.
  try {
    const problems = await ports.compile(release)
    if (problems.some((d) => d.severity === 'error'))
      return stop('compile', problems, release)
    trace.push('compile')
  } catch (error) {
    return stop('compile', diagnosticsOf('compile', error), release)
  }

  // 3. Evaluate initialization in a preview with no mutation or background grants.
  const preview = previewCapabilities(release.requested)
  const warnings: Diagnostic[] = []
  try {
    const problems = await ports.preview(release, preview)
    if (problems.some((d) => d.severity === 'error'))
      return stop('preview', problems, release)
    warnings.push(...problems)
    trace.push('preview')
  } catch (error) {
    return stop('preview', diagnosticsOf('preview', error), release)
  }

  // 4. Prepare view state, check data compatibility, find any permission change.
  const current = records.get(input.identity) ?? before
  let access: DataAccess
  try {
    const problems = (await ports.prepareView?.(retained, release)) ?? []
    if (problems.some((d) => d.severity === 'error'))
      return stop('prepare', problems, release)
    warnings.push(...problems)
    access = dataAccess(release, current.dataVersion)
    const data = dataAccessDiagnostics(access, current.dataVersion)
    if (access === 'export-only') return stop('prepare', data, release)
    warnings.push(...data)
    trace.push('prepare')
  } catch (error) {
    return stop('prepare', diagnosticsOf('prepare', error), release)
  }
  const { grant, policy } = ports.authority(input.identity)
  const authority = authorityFor({
    grant,
    policy,
    digest: release.grantDigest,
    requested: release.requested,
    previousRequested: retained?.requested,
  })
  if (authority.kind === 'needs-grant') {
    records.update(input.identity, (record) =>
      failCandidate(record, {
        releaseId: release.releaseId,
        stage: 'prepare',
        diagnostics: [
          {
            stage: 'prepare',
            severity: 'warning',
            message:
              authority.reason === 'expanded'
                ? 'This release asks for access the one you have does not.'
                : 'This release needs your permission before it runs.',
            hint: 'Review what it asks for. The release you have keeps running meanwhile.',
          },
        ],
        at: now(),
        awaiting: 'grant',
      }),
    )
    return { status: 'awaiting-grant', release, authority, warnings, trace }
  }

  // 5. Activate under a revision check; the old release stays as the recovery target.
  const scope = ports.instantiate?.(release)
  const planned = (records.get(input.identity) ?? emptyRecord(input.identity))
    .revision
  let result: ReturnType<typeof commitActive> | undefined
  records.update(input.identity, (record) => {
    const held = hold(record, release)
    result = commitActive(held, release.releaseId, planned, now())
    return result.ok ? result.record : record
  })
  if (!result || !result.ok) {
    scope?.dispose()
    const stale = result?.ok === false && result.reason === 'stale-revision'
    return stop(
      'activate',
      [
        failure(
          'activate',
          stale
            ? 'The module changed while this release was being checked.'
            : 'The module was removed while this release was being checked.',
          stale ? 'Try again; nothing was replaced.' : undefined,
        ),
      ],
      release,
      stale,
    )
  }
  trace.push('activate')

  // 6. Dispose what the replaced instance owned; its late messages are refused from here.
  const disposeFailures = scope
    ? activeInstances.replace(input.identity, scope).failures
    : activeInstances.remove(input.identity).failures
  trace.push('dispose')
  if (disposeFailures.length)
    warnings.push({
      stage: 'dispose',
      severity: 'warning',
      message: `${disposeFailures.length} cleanup step(s) of the replaced instance failed.`,
    })
  return {
    status: 'activated',
    release,
    access,
    authority,
    warnings,
    disposeFailures,
    trace,
  }
}

/** Notes in the data history that a candidate's data check ran; kept for the history list. */
export const noteDataCheck = (
  record: ModuleRecord,
  summary: string,
  at: number,
) => addHistory(record, { axis: 'data', summary }, at)
