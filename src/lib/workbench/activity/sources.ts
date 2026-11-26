// SOURCING: hand-roll: a per-project registry the mounted workbench fills with its own owners' listings (the terminal host's `terminal.list`, the conversation's side-chat record). No library is needed for a map of callbacks; the activity view reads it, it never takes the owners over.
import type { SideChatRow, TerminalRow } from './inventory'

/** What a mounted workspace lends the activity view. Each callback asks its owner; none caches. */
export interface ActivitySource {
  /** The host's terminal listing, or undefined when this host lists none. */
  terminals?: () => Promise<TerminalRow[] | undefined>
  sideChats?: () => SideChatRow[]
}

const sources = new Map<string, ActivitySource>()
const listeners = new Set<() => void>()
let version = 0

const changed = () => {
  version += 1
  for (const listener of listeners) listener()
}

/** Lends a project's owners to the activity view until the returned function is called. */
export function registerActivitySource(
  projectId: string,
  source: ActivitySource,
): () => void {
  sources.set(projectId, source)
  changed()
  return () => {
    if (sources.get(projectId) !== source) return
    sources.delete(projectId)
    changed()
  }
}

export const activitySource = (projectId: string) => sources.get(projectId)

/** For useSyncExternalStore: the version moves whenever a source comes or goes. */
export const activitySources = {
  subscribe(listener: () => void) {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
  version: () => version,
}
