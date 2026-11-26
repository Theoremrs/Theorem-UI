// SOURCING: none upstream models a project activity read model; the rules are the unified agent spec's EV-01..04 and ST-01..03 (docs/plans/theo-workbench/SPEC-UNIFIED-AGENT-EXPERIENCE-1.0.md §7). Pure logic: each owner (harness runs, terminal host, conversation port) keeps its authority and feeds events here.

/** Where a piece of work lives, by its owner. A raw terminal is not an agent (ID-01). */
export type ActivitySource = 'thread' | 'delegation' | 'terminal' | 'sideChat'

/** What the owner says the work is doing; `unknown` when it has not said. */
export type Execution =
  | 'queued'
  | 'starting'
  | 'running'
  | 'waiting'
  | 'paused'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'interrupted'
  | 'unknown'

/** How current this page's view of the work is, apart from what the work is doing (ST-02). */
export type Observation =
  | 'connecting'
  | 'current'
  | 'stale'
  | 'recovering'
  | 'unavailable'

/** Why work waits, when the owner says (ST-03). It words the row; it never ranks it. */
export type WaitingFor = 'approval' | 'input' | 'dependency' | 'capacity' | 'other'

/** One owner-backed resource the activity view shows. */
export interface ActivityEntry {
  /** `source:resource`: the key events and views bind by. Never a label. */
  key: string
  source: ActivitySource
  resource: string
  label: string
  execution: Execution
  observation: Observation
  /** When the owner's state was last read, in ms. */
  observedAt: number
  /** The owner's generation (a terminal binding epoch, a run attempt) the state is from. */
  epoch: number
  /** The last event sequence applied within `epoch`. */
  seq: number
  /** The project a thread opens under; absent for work that belongs to this page's workspace. */
  projectId?: string
  /** Every project a thread is filed in, so a project's scope can include it. */
  projects?: string[]
  /** The run that acted here last, as the owner recorded it. */
  runId?: string
  parentRunId?: string
  waiting?: { for: WaitingFor; ref?: string }
  /** The state is a program's own report (a terminal title, a coding CLI's status), not the owner's. */
  reported?: boolean
  /** An exit or result at this level only: a program's exit is not its agent's outcome. */
  detail?: string
}

/** What an owner sends. A snapshot is canonical; a change is one step after `seq - 1`. */
export interface ActivityEvent {
  kind: 'snapshot' | 'change'
  source: ActivitySource
  resource: string
  epoch: number
  seq: number
  at: number
  /** The fields the owner states; omitted ones keep their last value. */
  state: Partial<
    Pick<
      ActivityEntry,
      | 'label'
      | 'execution'
      | 'runId'
      | 'parentRunId'
      | 'waiting'
      | 'reported'
      | 'detail'
    >
  >
}

/** What applying one event did, so a caller can ask the owner for a snapshot. */
export type Applied =
  | 'applied'
  | 'duplicate'
  | 'stale_epoch'
  | 'gap'
  | 'needs_snapshot'

export interface ActivityProjection {
  apply: (event: ActivityEvent) => Applied
  /** The owner's stream for these resources was lost: keep the last state, mark it stale (ST-02). */
  lost: (source: ActivitySource, resource?: string) => void
  /** The owner is being read again; current comes only with its next snapshot. */
  recovering: (source: ActivitySource, resource?: string) => void
  /** The owner says this resource is gone from its scope. */
  remove: (source: ActivitySource, resource: string) => void
  entries: () => ActivityEntry[]
  get: (key: string) => ActivityEntry | undefined
  subscribe: (listener: () => void) => () => void
}

export const keyOf = (source: ActivitySource, resource: string) =>
  `${source}:${resource}`

/**
 * The project's activity, merged per owner. Order is per resource (EV-01): events are never
 * sorted by wall clock across resources, and `entries()` lists resources in the order they
 * were first seen. An event repeats or overtakes nothing (EV-02): a seq already applied is a
 * duplicate, an older epoch is late, a newer epoch starts over rather than merging, and a
 * change past a gap waits for the owner's snapshot instead of being guessed across.
 */
export function createActivityProjection(): ActivityProjection {
  const entries = new Map<string, ActivityEntry & { gap: boolean }>()
  const listeners = new Set<() => void>()
  const changed = () => {
    for (const listener of [...listeners]) listener()
  }
  const matching = (source: ActivitySource, resource?: string) =>
    [...entries.values()].filter(
      (e) => e.source === source && (resource === undefined || e.resource === resource),
    )

  return {
    apply(event) {
      const key = keyOf(event.source, event.resource)
      const known = entries.get(key)
      if (known && event.epoch < known.epoch) return 'stale_epoch'
      const sameEpoch = known !== undefined && event.epoch === known.epoch
      // A snapshot is canonical: after a loss it may repeat the last seq and still settle it.
      const settles =
        event.kind === 'snapshot' &&
        sameEpoch &&
        event.seq === known.seq &&
        (known.gap || known.observation !== 'current')
      if (sameEpoch && event.seq <= known.seq && !settles) return 'duplicate'
      if (event.kind === 'change') {
        if (!known) return 'needs_snapshot'
        if (!sameEpoch) {
          // A new epoch is a new stream: nothing from the old one carries over.
          known.gap = true
          known.observation = 'recovering'
          changed()
          return 'needs_snapshot'
        }
        if (known.gap) return 'needs_snapshot'
        if (event.seq !== known.seq + 1) {
          known.gap = true
          known.observation = 'recovering'
          changed()
          return 'gap'
        }
      }
      const base: ActivityEntry =
        known && event.kind === 'change'
          ? known
          : {
              key,
              source: event.source,
              resource: event.resource,
              label: known?.label ?? event.resource,
              execution: 'unknown',
              observation: 'current',
              observedAt: event.at,
              epoch: event.epoch,
              seq: event.seq,
            }
      const next = {
        ...base,
        ...event.state,
        key,
        epoch: event.epoch,
        seq: event.seq,
        observedAt: event.at,
        observation: 'current' as const,
        gap: false,
      }
      if (event.kind === 'snapshot' && !('waiting' in event.state)) delete next.waiting
      entries.set(key, next)
      changed()
      return 'applied'
    },
    lost(source, resource) {
      let any = false
      for (const e of matching(source, resource))
        if (e.observation !== 'stale') {
          e.observation = 'stale'
          any = true
        }
      if (any) changed()
    },
    recovering(source, resource) {
      let any = false
      for (const e of matching(source, resource)) {
        e.observation = 'recovering'
        e.gap = true
        any = true
      }
      if (any) changed()
    },
    remove(source, resource) {
      if (entries.delete(keyOf(source, resource))) changed()
    },
    entries: () => [...entries.values()].map(({ gap: _gap, ...e }) => e),
    get(key) {
      const found = entries.get(key)
      if (!found) return undefined
      const { gap: _gap, ...e } = found
      return e
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
  }
}

/**
 * Which resource each view shows, by generation (EV-04). A result started for a view's
 * earlier selection carries that generation and is refused for the view, though its owner's
 * cache may still keep it under the resource it was for.
 */
export function createViewBindings() {
  const bound = new Map<string, { key: string; generation: number }>()
  return {
    bind(view: string, key: string): number {
      const generation = (bound.get(view)?.generation ?? 0) + 1
      bound.set(view, { key, generation })
      return generation
    },
    /** Whether a result for `key` at `generation` may still change `view`. */
    current(view: string, key: string, generation: number): boolean {
      const now = bound.get(view)
      return now !== undefined && now.key === key && now.generation === generation
    },
    unbind(view: string) {
      bound.delete(view)
    },
  }
}
