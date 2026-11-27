// SOURCING: zustand + zustand/middleware persist, as src/lib/modules/grants.ts
// keeps what the host owns outside the vault. Release records are the host's
// bookkeeping about code, kept per browser: the files of a release are held
// so it can be restored, the vault stays the place a person edits them.
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { RecordAccess } from './activation'
import { emptyRecord } from './state'
import type { ModuleRecord } from './state'

interface ReleaseStore {
  modules: Record<string, ModuleRecord>
  update: (
    identity: string,
    change: (record: ModuleRecord) => ModuleRecord,
  ) => void
  drop: (identity: string) => void
}

export const useReleases = create<ReleaseStore>()(
  persist(
    (set) => ({
      modules: {},
      update: (identity, change) =>
        set((state) => ({
          modules: {
            ...state.modules,
            [identity]: change(
              state.modules[identity] ?? emptyRecord(identity),
            ),
          },
        })),
      drop: (identity) =>
        set((state) => {
          const { [identity]: _, ...rest } = state.modules
          return { modules: rest }
        }),
    }),
    {
      name: 'theorem-ui:releases',
      version: 1,
      partialize: ({ modules }) => ({ modules }),
    },
  ),
)

/** The zustand store as the activation sequence reads and writes records. */
export const releaseRecords: RecordAccess = {
  get: (identity) => useReleases.getState().modules[identity],
  update: (identity, change) => useReleases.getState().update(identity, change),
}

export const recordOf = (identity: string) =>
  useReleases.getState().modules[identity]
