// SOURCING: none. The states are the spec's REF-02 list; the mapping reads the status a Theorem route answers with and the standard fetch failure for offline.

/**
 * Distinct inside the client. `unavailable` is the owner saying the resource
 * cannot be shown without saying why; `deleted` and `inaccessible` are the
 * owner saying more, which only a caller allowed to know the resource exists
 * may see (see `publicState`).
 */
export const RESOURCE_STATES = [
  'ready',
  'unavailable',
  'deleted',
  'inaccessible',
  'unsupported',
  'offline',
] as const
export type ResourceState = (typeof RESOURCE_STATES)[number]
export type NotReady = Exclude<ResourceState, 'ready'>

/** What remains navigable of authorized historical material. */
export type Tombstone = {
  /** The resource's last known kind label, never its title. */
  kindLabel?: string
  /** When the owner recorded the deletion, in ms. */
  atMs?: number
  /** Evidence that survives it: the sources that still point at it. */
  evidence?: string[]
}

/** The status of a failed owner call, wherever the client keeps it. */
function statusOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const e = error as { status?: unknown; statusCode?: unknown }
  const value = e.statusCode ?? e.status
  return typeof value === 'number' ? value : undefined
}

/** Whether a failure is the network, not an answer. */
export function isOfflineError(error: unknown): boolean {
  if (typeof navigator !== 'undefined' && navigator.onLine === false)
    return true
  if (error instanceof TypeError) return true
  const name = (error as { name?: unknown } | null)?.name
  return name === 'NetworkError' || name === 'TimeoutError'
}

/**
 * The state an owner failure means. 401/403 are inaccessible, 410 is deleted,
 * 404 is unavailable (an owner that answers not-found for both missing and
 * forbidden is not asked to say which), 501 and 405 are unsupported, and a
 * network failure is offline. Anything else is unavailable, never ready.
 */
export function stateOfError(error: unknown): NotReady {
  if (isOfflineError(error)) return 'offline'
  switch (statusOf(error)) {
    case 401:
    case 403:
      return 'inaccessible'
    case 410:
      return 'deleted'
    case 404:
      return 'unavailable'
    case 405:
    case 501:
      return 'unsupported'
    default:
      return 'unavailable'
  }
}

/**
 * The state a public response or a surface the caller cannot vouch for may
 * show. Inaccessible never says more than unavailable; deleted keeps its
 * name only when the caller holds a tombstone it is authorized to read.
 */
export function publicState(
  state: ResourceState,
  options: { tombstone?: Tombstone } = {},
): ResourceState {
  if (state === 'inaccessible') return 'unavailable'
  if (state === 'deleted' && !options.tombstone) return 'unavailable'
  return state
}

export const STATE_LABEL: Record<ResourceState, string> = {
  ready: 'Available',
  unavailable: 'Unavailable',
  deleted: 'Deleted',
  inaccessible: 'Unavailable',
  unsupported: 'Not supported here',
  offline: 'Offline',
}

export const STATE_DETAIL: Record<ResourceState, string> = {
  ready: '',
  unavailable: 'This is not available to you now.',
  deleted: 'This was deleted. What still points at it is kept.',
  inaccessible: 'This is not available to you now.',
  unsupported: 'This kind of resource cannot be shown here yet.',
  offline: 'You are offline. This will load when you are back.',
}
