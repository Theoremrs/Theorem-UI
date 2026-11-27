// SOURCING: hand-rolled over ./merge (three-way merge) and zustand persist.
// OWN-01: shipped defaults, user-owned source or forks, settings, shared page
// definitions and per-device view state are persisted apart, each under its
// own owner, so changing one cannot overwrite another. Application data is
// not here at all: nothing in this file can delete it.
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { mergeFiles, resolveMerge } from './merge'
import type { ConflictChoice, FileMerge } from './merge'
import type { ReleaseFiles } from './types'

/** The shipped default a module started from: its files and the revision they belong to. */
export interface ShippedLayer {
  revision: string
  files: ReleaseFiles
}

/** User-owned source. A fork also keeps the exact upstream files it started from. */
export interface SourceLayer {
  files: ReleaseFiles
  base?: { upstreamId: string; revision: string; files: ReleaseFiles }
}

/** A product update waiting over a fork; both versions are kept until it is settled. */
export interface PendingUpdate {
  revision: string
  files: ReleaseFiles
  merges: FileMerge[]
  conflicts: number
}

export interface SourceHistoryEntry {
  files: ReleaseFiles
  at: number
  reason: 'fork' | 'merge' | 'replaced-by-update' | 'reset-to-default' | 'edit'
  base?: SourceLayer['base']
}

export interface OwnedModule {
  identity: string
  /** Counts changes to this record; a reset or update names the revision it was planned over. */
  revision: number
  shipped?: ShippedLayer
  source?: SourceLayer
  sourceHistory: SourceHistoryEntry[]
  /** Personal and workspace settings. Keys this host does not know are kept. */
  settings: Record<string, unknown>
  /** Paths of shared page definitions that wire this module; the pages stay in the vault. */
  pages: string[]
  pending?: PendingUpdate
}

export const emptyOwned = (identity: string): OwnedModule => ({
  identity,
  revision: 0,
  sourceHistory: [],
  settings: {},
  pages: [],
})

/** The files that run: the user's source when there is some, else the shipped default. */
export const effectiveFiles = (owned: OwnedModule): ReleaseFiles | undefined =>
  owned.source?.files ?? owned.shipped?.files

const bump = (
  owned: OwnedModule,
  change: Partial<OwnedModule>,
): OwnedModule => ({
  ...owned,
  ...change,
  revision: owned.revision + 1,
})

const sameFiles = (a: ReleaseFiles, b: ReleaseFiles) => {
  const keys = Object.keys(a)
  return (
    keys.length === Object.keys(b).length &&
    keys.every((key) => a[key] === b[key])
  )
}

/** Makes the user's own copy of a shipped module, remembering the revision it came from. */
export function fork(
  owned: OwnedModule,
  files: ReleaseFiles,
  at: number,
): OwnedModule {
  const shipped = owned.shipped
  const base = shipped && {
    upstreamId: owned.identity,
    revision: shipped.revision,
    files: shipped.files,
  }
  return bump(owned, {
    source: { files, ...(base ? { base } : {}) },
    sourceHistory: [
      ...owned.sourceHistory,
      { files, at, reason: 'fork', ...(base ? { base } : {}) },
    ],
  })
}

/** A product update arriving: what happens to the user's source (OWN-01). */
export type UpdateOffer =
  | { kind: 'adopt'; owned: OwnedModule }
  | { kind: 'fast-forward'; owned: OwnedModule }
  | { kind: 'merge'; owned: OwnedModule; pending: PendingUpdate }
  | { kind: 'unchanged'; owned: OwnedModule }

/**
 * A new shipped revision arrives. With no user source the default is simply
 * replaced. A fork nobody edited moves up with it. An edited fork is merged
 * three ways against the revision it started from: the user's source is left
 * exactly as it is, and the result waits as a pending update with every
 * conflict holding both versions.
 */
export function offerProductUpdate(
  owned: OwnedModule,
  update: ShippedLayer,
  at: number,
): UpdateOffer {
  if (owned.shipped?.revision === update.revision)
    return { kind: 'unchanged', owned }
  const source = owned.source
  if (!source)
    return {
      kind: 'adopt',
      owned: bump(owned, { shipped: update, pending: undefined }),
    }
  const base = source.base
  if (!base || base.upstreamId !== owned.identity) {
    // A fork of something else, or of nothing known: there is no base to merge over.
    const merges = mergeFiles({}, source.files, update.files)
    const pending = pendingOf(update, merges)
    return {
      kind: 'merge',
      pending,
      owned: bump(owned, { shipped: update, pending }),
    }
  }
  if (sameFiles(source.files, base.files))
    return {
      kind: 'fast-forward',
      owned: bump(owned, {
        shipped: update,
        source: {
          files: update.files,
          base: { ...base, revision: update.revision, files: update.files },
        },
        sourceHistory: [
          ...owned.sourceHistory,
          { files: update.files, at, reason: 'merge', base },
        ],
        pending: undefined,
      }),
    }
  const pending = pendingOf(
    update,
    mergeFiles(base.files, source.files, update.files),
  )
  return {
    kind: 'merge',
    pending,
    owned: bump(owned, { shipped: update, pending }),
  }
}

function pendingOf(update: ShippedLayer, merges: FileMerge[]): PendingUpdate {
  return {
    revision: update.revision,
    files: update.files,
    merges,
    conflicts: merges.filter((m) => m.result && m.result.conflicts > 0).length,
  }
}

export type OwnedResult =
  | { ok: true; owned: OwnedModule }
  | {
      ok: false
      reason:
        | 'stale-revision'
        | 'conflicts-unresolved'
        | 'nothing-pending'
        | 'no-source'
      message: string
    }

/**
 * Applies a pending update's merge. Every conflicting file needs a choice,
 * by path and then by conflict in it; the previous source goes to history.
 */
export function applyMerge(
  owned: OwnedModule,
  expectedRevision: number,
  choices: Record<string, ConflictChoice[]>,
  at: number = Date.now(),
): OwnedResult {
  if (owned.revision !== expectedRevision)
    return {
      ok: false,
      reason: 'stale-revision',
      message: 'This module changed since the update was shown.',
    }
  const { pending, source } = owned
  if (!pending || !source)
    return {
      ok: false,
      reason: 'nothing-pending',
      message: 'No update is waiting.',
    }
  const files: ReleaseFiles = {}
  for (const merge of pending.merges) {
    let text = merge.text
    if (merge.result?.conflicts) {
      const picked = choices[merge.path]
      if (!picked || picked.length < merge.result.conflicts)
        return {
          ok: false,
          reason: 'conflicts-unresolved',
          message: `${merge.path} has a conflict that needs a choice.`,
        }
      text = resolveMerge(merge.result, picked)
    }
    if (text !== undefined) files[merge.path] = text
  }
  const base = {
    upstreamId: source.base?.upstreamId ?? owned.identity,
    revision: pending.revision,
    files: pending.files,
  }
  return {
    ok: true,
    owned: bump(owned, {
      source: { files, base },
      sourceHistory: [
        ...owned.sourceHistory,
        { files, at, reason: 'merge', base },
      ],
      pending: undefined,
    }),
  }
}

/** Takes the update's files whole, keeping the user's source in history. */
export function replaceWithUpdate(
  owned: OwnedModule,
  expectedRevision: number,
  at: number,
): OwnedResult {
  if (owned.revision !== expectedRevision)
    return {
      ok: false,
      reason: 'stale-revision',
      message: 'This module changed since the update was shown.',
    }
  const { pending, source } = owned
  if (!pending || !source)
    return {
      ok: false,
      reason: 'nothing-pending',
      message: 'No update is waiting.',
    }
  const base = {
    upstreamId: source.base?.upstreamId ?? owned.identity,
    revision: pending.revision,
    files: pending.files,
  }
  return {
    ok: true,
    owned: bump(owned, {
      source: { files: pending.files, base },
      sourceHistory: [
        ...owned.sourceHistory,
        {
          files: source.files,
          at,
          reason: 'replaced-by-update',
          base: source.base,
        },
      ],
      pending: undefined,
    }),
  }
}

/** Keeps the user's source and drops nothing: the update is set aside until the next one. */
export const dismissUpdate = (owned: OwnedModule): OwnedModule =>
  owned.pending ? bump(owned, { pending: undefined }) : owned

/**
 * Puts the shipped default back. The user's source goes to history and can be
 * restored; settings, pages and application data are not touched. It names
 * the revision it was planned over, so a change made meanwhile is not erased.
 */
export function resetToDefault(
  owned: OwnedModule,
  expectedRevision: number,
  at: number,
): OwnedResult {
  if (owned.revision !== expectedRevision)
    return {
      ok: false,
      reason: 'stale-revision',
      message: 'This module changed since the reset was offered.',
    }
  if (!owned.source)
    return {
      ok: false,
      reason: 'no-source',
      message: 'It already runs the shipped default.',
    }
  return {
    ok: true,
    owned: bump(owned, {
      source: undefined,
      sourceHistory: [
        ...owned.sourceHistory,
        {
          files: owned.source.files,
          at,
          reason: 'reset-to-default',
          base: owned.source.base,
        },
      ],
      pending: undefined,
    }),
  }
}

/** Saves settings; keys already there that the edit does not mention are kept. */
export const saveSettings = (
  owned: OwnedModule,
  edit: Record<string, unknown>,
): OwnedModule => bump(owned, { settings: { ...owned.settings, ...edit } })

export const useOwnership = create<{
  modules: Record<string, OwnedModule>
  update: (
    identity: string,
    change: (owned: OwnedModule) => OwnedModule,
  ) => void
}>()(
  persist(
    (set) => ({
      modules: {},
      update: (identity, change) =>
        set((s) => ({
          modules: {
            ...s.modules,
            [identity]: change(s.modules[identity] ?? emptyOwned(identity)),
          },
        })),
    }),
    {
      name: 'theorem-ui:ownership',
      version: 1,
      partialize: ({ modules }) => ({ modules }),
    },
  ),
)

/**
 * Per-device view state: panel geometry, scroll, open sections. Held under its
 * own key and never exported, shared or merged: it belongs to this device.
 */
export const useDeviceViewState = create<{
  state: Record<string, Record<string, unknown>>
  set: (identity: string, value: Record<string, unknown>) => void
}>()(
  persist(
    (set) => ({
      state: {},
      set: (identity, value) =>
        set((s) => ({ state: { ...s.state, [identity]: value } })),
    }),
    {
      name: 'theorem-ui:device-view-state',
      version: 1,
      partialize: ({ state }) => ({ state }),
    },
  ),
)
