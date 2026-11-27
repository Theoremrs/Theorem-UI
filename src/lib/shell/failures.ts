// SOURCING: zustand with its persist middleware (the record outlives the
// reload a broken shell forces, so recovery can show what failed, EXEC-05).
// No library models it.
import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'

export type FailureArea = 'shell' | 'handler' | 'panel' | 'extension' | 'host'

export interface RecordedFailure {
  id: string
  at: string
  area: FailureArea
  /** The contribution (or module) whose code failed, when one did. */
  contributionId?: string
  message: string
  stack?: string
}

const KEEP = 50
export const FAILURES_SCHEMA = 'theorem.failures/1'

interface FailureStore {
  failures: ReadonlyArray<RecordedFailure>
  record: (failure: Omit<RecordedFailure, 'id' | 'at'>) => RecordedFailure
  clear: () => void
}

let counter = 0

export const useFailures = create<FailureStore>()(
  persist(
    (set) => ({
      failures: [],
      record: (failure) => {
        const entry: RecordedFailure = {
          ...failure,
          id: `${Date.now().toString(36)}-${(counter++).toString(36)}`,
          at: new Date().toISOString(),
        }
        set((state) => ({ failures: [...state.failures, entry].slice(-KEEP) }))
        return entry
      },
      clear: () => set({ failures: [] }),
    }),
    {
      name: FAILURES_SCHEMA,
      version: 1,
      storage: createJSONStorage(() => localStorage),
      partialize: ({ failures }) => ({ failures }),
    },
  ),
)

/** Records that a piece of replaceable code failed, and returns the record. */
export function recordFailure(
  area: FailureArea,
  error: unknown,
  contributionId?: string,
): RecordedFailure {
  const real = error instanceof Error ? error : new Error(String(error))
  return useFailures.getState().record({
    area,
    ...(contributionId && { contributionId }),
    message: real.message,
    ...(real.stack && { stack: real.stack.split('\n').slice(0, 8).join('\n') }),
  })
}
