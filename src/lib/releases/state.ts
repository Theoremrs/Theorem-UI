// SOURCING: hand-rolled. The pure core of what the host knows about each
// module's releases: no store, no I/O, so activation, rollback and recovery
// can be tested without either. ./store.ts holds it in zustand.
import type { ActivationStage, Diagnostic, Release } from './types'

/** Source, layout and data history are three histories and are labeled as such (OWN-03). */
export type HistoryAxis = 'source' | 'layout' | 'data'

export interface HistoryEntry {
  axis: HistoryAxis
  at: number
  /** A sentence: "Activated release 3f2a91", "Switched back to ...". */
  summary: string
  releaseId?: string
}

/** A candidate that did not become active, kept so its problems can be read. */
export interface CandidateRecord {
  releaseId?: string
  stage: ActivationStage
  diagnostics: Diagnostic[]
  at: number
  /** The candidate is waiting for a grant rather than failed. */
  awaiting?: 'grant'
}

export interface ModuleRecord {
  identity: string
  /** Oldest first. */
  releases: Release[]
  activeId?: string
  /** Release ids that ran and initialized, oldest first: the recovery targets. */
  working: string[]
  /** Counts activations. An activation must name the revision it was planned over. */
  revision: number
  candidate?: CandidateRecord
  disabled: boolean
  uninstalled: boolean
  /** The schema version of the module's retained data, when it has any. */
  dataVersion?: number
  history: HistoryEntry[]
}

export const MAX_RELEASES = 8
export const MAX_HISTORY = 100

export const emptyRecord = (identity: string): ModuleRecord => ({
  identity,
  releases: [],
  working: [],
  revision: 0,
  disabled: false,
  uninstalled: false,
  history: [],
})

export const releaseOf = (record: ModuleRecord, releaseId: string) =>
  record.releases.find((r) => r.releaseId === releaseId)

export const activeRelease = (record: ModuleRecord) =>
  record.activeId ? releaseOf(record, record.activeId) : undefined

/** The most recent release that ran and initialized, still held. */
export function lastWorking(
  record: ModuleRecord,
  options: { excluding?: string } = {},
): Release | undefined {
  for (let i = record.working.length - 1; i >= 0; i--) {
    const id = record.working[i]!
    if (id === options.excluding) continue
    const release = releaseOf(record, id)
    if (release) return release
  }
  return undefined
}

/** The working release before the active one: where a rollback goes by default. */
export const previousWorking = (record: ModuleRecord) =>
  lastWorking(record, { excluding: record.activeId })

const note = (
  record: ModuleRecord,
  entry: Omit<HistoryEntry, 'at'>,
  at: number,
): ModuleRecord => ({
  ...record,
  history: [...record.history, { ...entry, at }].slice(-MAX_HISTORY),
})

export const addHistory = note

/** Holds a release, keeping the newest few and never the active or recovery ones out. */
export function hold(record: ModuleRecord, release: Release): ModuleRecord {
  const others = record.releases.filter(
    (r) => r.releaseId !== release.releaseId,
  )
  let releases = [...others, release]
  const pinned = new Set([record.activeId, ...record.working.slice(-2)])
  while (releases.length > MAX_RELEASES) {
    const at = releases.findIndex(
      (r) => !pinned.has(r.releaseId) && r.releaseId !== release.releaseId,
    )
    if (at < 0) break
    releases = releases.filter((_, i) => i !== at)
  }
  return { ...record, releases }
}

/** A candidate stopped: the last working release stays active and nothing else changes. */
export function failCandidate(
  record: ModuleRecord,
  candidate: CandidateRecord,
): ModuleRecord {
  return { ...record, candidate }
}

export type CommitResult =
  | { ok: true; record: ModuleRecord }
  | { ok: false; reason: 'stale-revision' | 'unknown-release' | 'removed' }

/**
 * Makes a release the active one, if the record is still at the revision the
 * activation was planned over. The release it replaces stays, and stays a
 * recovery target; the candidate record is cleared.
 */
export function commitActive(
  record: ModuleRecord,
  releaseId: string,
  expectedRevision: number,
  at: number,
  summary?: string,
): CommitResult {
  if (record.uninstalled) return { ok: false, reason: 'removed' }
  if (record.revision !== expectedRevision)
    return { ok: false, reason: 'stale-revision' }
  if (!releaseOf(record, releaseId))
    return { ok: false, reason: 'unknown-release' }
  const working = [
    ...record.working.filter((id) => id !== releaseId),
    releaseId,
  ]
  const next: ModuleRecord = {
    ...record,
    activeId: releaseId,
    working,
    revision: record.revision + 1,
    candidate: undefined,
  }
  return {
    ok: true,
    record: note(
      next,
      {
        axis: 'source',
        releaseId,
        summary: summary ?? `Activated release ${releaseId.slice(0, 8)}`,
      },
      at,
    ),
  }
}

/** A release that was active turned out not to run: it stops being a recovery target. */
export function markBroken(
  record: ModuleRecord,
  releaseId: string,
  diagnostics: Diagnostic[],
  at: number,
): ModuleRecord {
  return {
    ...record,
    working: record.working.filter((id) => id !== releaseId),
    candidate: { releaseId, stage: 'activate', diagnostics, at },
  }
}
