// SOURCING: ./state over ./store. The recovery entry points the shell calls
// (EXEC-05): last working release, switch back to a release, and the list of
// host-owned recovery actions. They read the release records only, never the
// module's own code, so a broken module cannot make them unreachable.
import { activeInstances } from './instance-scope'
import { dataAccess, dataAccessDiagnostics } from './release'
import type { DataAccess } from './release'
import { releaseRecords, useReleases } from './store'
import { addHistory, commitActive, lastWorking, releaseOf } from './state'
import type { ModuleRecord } from './state'
import type { Diagnostic, Release } from './types'

/** Writes a release's files back where the module lives (the vault). */
export interface ReleaseWriter {
  restore: (identity: string, release: Release) => Promise<void>
}

let writer: ReleaseWriter | undefined

/** Set once the vault is open; cleared on unmount. Rollback needs it to put files back. */
export function setReleaseWriter(next: ReleaseWriter | undefined) {
  writer = next
}

/** The release recovery should go to for this module, or none. */
export function lastWorkingRelease(identity: string): Release | undefined {
  const record = releaseRecords.get(identity)
  return record && lastWorking(record, { excluding: record.activeId })
}

export type RollbackOutcome =
  | {
      ok: true
      release: Release
      /** What the older release may do with the data as it is now. */
      access: DataAccess
      warnings: Diagnostic[]
    }
  | {
      ok: false
      reason: 'unknown-release' | 'no-writer' | 'failed' | 'stale-revision'
      message: string
    }

/**
 * Switches the module's code and presentation back to an earlier release. It
 * never changes the data: no schema rollback runs, and a release whose
 * data range excludes the database gets read-only access or export only
 * (OWN-03). It cannot undo what the newer release already did elsewhere.
 */
export async function rollbackTo(
  identity: string,
  releaseId: string,
): Promise<RollbackOutcome> {
  const record = releaseRecords.get(identity)
  const release = record && releaseOf(record, releaseId)
  if (!record || !release)
    return {
      ok: false,
      reason: 'unknown-release',
      message: 'That release is no longer held.',
    }
  if (!writer)
    return {
      ok: false,
      reason: 'no-writer',
      message: 'The vault is not open, so the files cannot be put back.',
    }
  const access = dataAccess(release, record.dataVersion)
  try {
    await writer.restore(identity, release)
  } catch (error) {
    return {
      ok: false,
      reason: 'failed',
      message: error instanceof Error ? error.message : String(error),
    }
  }
  const state = { committed: false }
  releaseRecords.update(identity, (current: ModuleRecord) => {
    const result = commitActive(
      current,
      releaseId,
      current.revision,
      Date.now(),
      `Switched code back to release ${releaseId.slice(0, 8)}`,
    )
    if (!result.ok) return current
    state.committed = true
    return addHistory(
      result.record,
      {
        axis: 'data',
        summary:
          access === 'read-write'
            ? 'Data unchanged by the switch.'
            : `Data left as it is (schema ${current.dataVersion}); this release is ${access === 'read-only' ? 'read-only' : 'export-only'} on it.`,
      },
      Date.now(),
    )
  })
  if (!state.committed)
    return {
      ok: false,
      reason: 'stale-revision',
      message: 'The module changed while switching; nothing was replaced.',
    }
  activeInstances.remove(identity)
  return {
    ok: true,
    release,
    access,
    warnings: dataAccessDiagnostics(access, record.dataVersion, 'activate'),
  }
}

/** An action the host's recovery entry offers; the shell lists these. */
export interface RecoveryAction {
  id: string
  label: string
  description: string
  /** The module it acts on, when it acts on one. */
  identity?: string
  run: () => Promise<{ ok: boolean; message: string }>
}

/** One "go back to the last working release" per module that has one. */
export function recoveryActions(): RecoveryAction[] {
  // Read through the store each time: the shell asks when recovery opens.
  const modules = Object.values(useReleases.getState().modules).filter(
    (record) => !record.uninstalled,
  )
  return modules.flatMap((record) => {
    const target = lastWorking(record, { excluding: record.activeId })
    if (!target) return []
    return [
      {
        id: `releases.rollback.${record.identity}`,
        label: `Go back to the last working release of ${record.identity}`,
        description: `Switches the code back to release ${target.releaseId.slice(0, 8)}. Your data is not changed.`,
        identity: record.identity,
        run: async () => {
          const outcome = await rollbackTo(record.identity, target.releaseId)
          return outcome.ok
            ? { ok: true, message: 'Switched back.' }
            : { ok: false, message: outcome.message }
        },
      },
    ]
  })
}
