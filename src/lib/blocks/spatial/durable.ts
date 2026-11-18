// SOURCING: none: keeping a spatial model's run beyond the open App, through
// `window.theorem.artifacts.record`, which the page hands to the backend's
// durable artifact store (theorem-apps). The store takes a run's observations
// in order from index 0, and a fork only after its parent recorded the moment
// it forks at; this writes them that way, from captures taken when each settle
// was kept, so a re-run or eviction cannot change what is written.
import { readSourceRef } from '@theorem/runtime'
import type { ArtifactSourceRef, ObservationRef } from '@theorem/runtime'
import { capturedState, groundCapture, TRACE_DOMAIN } from './trace'
import type { SpatialRun, TraceCapture } from './trace'

/** One observation as the store records it. */
export interface DurableObservation {
  index: string
  time: string
  stateDigest: string
  /** The canonical JSON text `stateDigest` is the SHA-256 of. */
  state: string
}

/** `window.theorem.artifacts`, as the App frame gives it (the part this uses). */
export interface ArtifactsBridge {
  record: (
    run: SpatialRun,
    domain: string,
    observations: Array<DurableObservation>,
  ) => Promise<{ through: string | null; source: unknown }>
}

const bridge = (): ArtifactsBridge | undefined =>
  (globalThis as { theorem?: { artifacts?: ArtifactsBridge } }).theorem
    ?.artifacts

/** What a trace hands this: the run's captures, and the runs it forked from. */
export interface DurableSource {
  /** Captures of `runId`'s cycles from `from` through `to`, or undefined when one is no longer held. */
  captures: (
    runId: string,
    from: number,
    to: number,
  ) => Array<TraceCapture> | undefined
}

/** The most observations sent in one call. */
const BATCH = 512

/**
 * Writes a model's runs durably on demand. `through(observation)` writes the
 * run up to that moment (and first, for a re-run, its parent up to where it
 * forked), with the state of every moment written, and answers the revision
 * the stored run names once that moment is held durably. Writes are queued
 * one after another; a run whose write fails, or whose early cycles were
 * dropped before they were written, is never claimed durable.
 */
export class DurableTrace {
  /** The next cycle to write, by run. */
  private readonly next = new Map<string, number>()
  private readonly failed = new Set<string>()
  private queue: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly source: DurableSource,
    private readonly artifacts: () => ArtifactsBridge | undefined = bridge,
  ) {}

  /** Whether a store is reachable from this App at all. */
  get available(): boolean {
    return this.artifacts() !== undefined
  }

  /** The revision each stored run names, as the store answered it. */
  private readonly sources = new Map<string, ArtifactSourceRef>()

  /**
   * Writes the run through `observation`. Answers the revision the stored run
   * names once that exact moment is held, so a question about it names the
   * same run; undefined when it is not held.
   */
  async through(
    observation: ObservationRef,
  ): Promise<ArtifactSourceRef | undefined> {
    const done = this.queue.then(() =>
      this.write(observation.runId, Number(observation.index)),
    )
    this.queue = done.catch(() => false)
    return (await done.catch(() => false))
      ? this.sources.get(observation.runId)
      : undefined
  }

  private async write(runId: string, cycle: number): Promise<boolean> {
    const artifacts = this.artifacts()
    if (!artifacts || this.failed.has(runId)) return false
    const from = this.next.get(runId) ?? 0
    if (cycle < from) return true
    const captures = this.source.captures(runId, from, cycle)
    if (!captures?.length) {
      this.failed.add(runId)
      return false
    }
    const grounded = await Promise.all(
      captures.map(async (capture) => ({
        ...(await groundCapture(capture)),
        state: capturedState(capture),
      })),
    )
    const run = grounded[0]!.run
    // A fork is stored only once its parent recorded the moment it forks at.
    if (
      from === 0 &&
      run.parent &&
      !(await this.write(run.parent.runId, Number(run.parent.at.index)))
    ) {
      this.failed.add(runId)
      return false
    }
    try {
      for (let start = 0; start < grounded.length; start += BATCH) {
        const batch = grounded
          .slice(start, start + BATCH)
          .map(({ observation, state }) => ({
            index: observation.index,
            time: observation.time,
            stateDigest: observation.stateDigest,
            state,
          }))
        const stored = await artifacts.record(run, TRACE_DOMAIN, batch)
        const source = readSourceRef(stored.source)
        if (!source)
          throw new Error('The store did not say which revision the run names.')
        this.sources.set(runId, source)
        this.next.set(runId, Number(batch.at(-1)!.index) + 1)
      }
      return true
    } catch {
      this.failed.add(runId)
      return false
    }
  }
}
