// SOURCING: none: the record of a ModelState's settles that Rerun's viewer is
// fed from (timeline.tsx). Rerun has no browser SDK; the frames are written as
// a recording by its Rust SDK behind `theorem.trace.recording`. What is kept
// here besides the frames is each settle as it came about — every part's
// readings, and the model's exact state after it — so a scrubbed cycle can be
// shown as it was read and run again from. A part's compute may read changing
// data outside the model, so the readings a cycle saw exist only in the
// recording: showing that cycle again cannot recompute them.

import { ARTIFACT_RUNTIME_SCHEMA, canonicalJson, digestOf, integerText } from '@theorem/runtime'
import type { EngineRef, ObservationRef, RunRef, TimeDomain } from '@theorem/runtime'
import { valueText } from './engine'
import type { ModelState, Settled } from './engine'

/** A primitive value a trace records: a number or text. */
export type TraceValue = number | string

/**
 * What a trace's `cycle` counts: one settle of the teaching model (the start,
 * a step, an edit or a restore). It is not a hardware clock cycle.
 */
export const TRACE_DOMAIN: TimeDomain = 'settlement'

/** The engine a spatial model's run is produced by, as a run reference names it. */
export const SPATIAL_ENGINE: EngineRef = {
  kind: 'theorem.spatial-settle',
  version: '1',
  adapter: { schema: 'theorem.spatial-trace', version: '1' },
  observation: { schema: 'theorem.spatial-frame', version: '1' },
  capabilities: ['step', 'inspect', 'replay'],
}

/** What one settle of the model produced. */
export interface TraceFrame {
  /** The settle's place in the run, from 0: a `settlement`, not a clock cycle. */
  cycle: number
  /** What caused it, in words: `start`, `step`, `regb.value = 3`. */
  cause: string
  /** Port values by part path, then port name; a part's state is under `<path>/state`. */
  values: Record<string, Record<string, TraceValue>>
}

/** What caused a settle. */
export type TraceCause =
  | { kind: 'start' }
  | { kind: 'restored' }
  | { kind: 'step' }
  | { kind: 'set'; path: string; key: string; value: unknown }

interface Kept {
  cause: TraceCause
  frame: TraceFrame
  states: Map<string, Record<string, unknown>>
  pins: Map<string, unknown>
  /**
   * The settle as it came about: what every part read and produced then, the
   * order they fired in, and the parts still changing. Looked-back cycles are
   * shown from here, because the readings cannot be had again by computing.
   */
  settled: Settled
  /** What each part had settled to, which a loop with no clock in it holds. */
  held: Map<string, Record<string, unknown>>
}

/**
 * A run of the model as a run reference names it. It leaves out its source:
 * the model runs inside the presentation, so the host names the revision
 * running.
 */
export type SpatialRun = Omit<RunRef, 'source'>

/** A kept settle and its run's name and lineage, taken together (CycleTrace.capture). */
export interface TraceCapture {
  readonly runId: string
  readonly parent: Promise<NonNullable<SpatialRun['parent']>> | undefined
  readonly kept: Readonly<Kept>
}

/** A capture resolved: the run, the exact moment, its frame and whether it came to rest. All from one capture. */
export async function groundCapture(capture: TraceCapture): Promise<{
  run: SpatialRun
  observation: ObservationRef
  frame: TraceFrame
  unsettled: Array<string>
}> {
  const parent = await capture.parent
  return {
    run: runOf(capture.runId, parent),
    observation: await observationOf(capture.runId, capture.kept),
    frame: capture.kept.frame,
    unsettled: [...capture.kept.settled.unsettled],
  }
}

function runOf(id: string, parent: NonNullable<SpatialRun['parent']> | undefined): SpatialRun {
  return {
    schema: ARTIFACT_RUNTIME_SCHEMA,
    id,
    engine: SPATIAL_ENGINE,
    ...(parent && { parent }),
    domains: [TRACE_DOMAIN],
    // A part's compute or tick may read time, randomness or outside data, so
    // the model is not claimed reproducible from its inputs; what is claimed
    // is what was recorded.
    reproducibility: 'recorded',
  }
}

/** The most cycles kept; a model left running drops its oldest. */
export const MAX_CYCLES = 5000
const MAX_TEXT = 4000

export const causeText = (cause: TraceCause): string =>
  cause.kind === 'set'
    ? `${cause.path}.${cause.key} = ${typeof cause.value === 'bigint' ? cause.value.toString() : (valueText(cause.value) ?? String(cause.value))}`
    : cause.kind

const clone = <T>(value: T): T => {
  try {
    return structuredClone(value)
  } catch {
    return value
  }
}

/** A settle as a kept cycle holds it: every reading copied, so nothing done to
 * the model afterwards, or to the settle itself, can change what was recorded. */
function recorded(settled: Settled): Settled {
  return {
    readings: new Map([
      ...settled.readings,
    ].map(([path, reading]) => [
      path,
      { inputs: clone(reading.inputs), outputs: clone(reading.outputs), stage: reading.stage },
    ])),
    stages: settled.stages.map((stage) => [...stage]),
    // Older callers hand a settle without the list: treat it as at rest.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    unsettled: [...(settled.unsettled ?? [])],
  }
}

/** A port's value as the trace's primitives, one entry per index or key of a flat array or object. */
export function flatten(name: string, value: unknown, into: Record<string, TraceValue>): void {
  if (value === null || value === undefined) return
  if (typeof value === 'number') {
    if (Number.isFinite(value)) into[name] = value
    return
  }
  if (typeof value === 'boolean') {
    into[name] = value ? 1 : 0
    return
  }
  if (typeof value === 'bigint') {
    // Exact: a value past 2^53 is kept as its decimal text rather than rounded.
    const small = Number(value)
    into[name] = Number.isSafeInteger(small) ? small : value.toString()
    return
  }
  if (typeof value === 'string') {
    into[name] = value.slice(0, MAX_TEXT)
    return
  }
  const primitive = (item: unknown) =>
    item === null || ['number', 'boolean', 'bigint', 'string'].includes(typeof item)
  if (Array.isArray(value) && value.every(primitive)) {
    value.forEach((item, index) => flatten(`${name}.${index}`, item, into))
    return
  }
  if (typeof value === 'object' && !Array.isArray(value) && Object.values(value).every(primitive)) {
    for (const [key, item] of Object.entries(value)) flatten(`${name}.${key}`, item, into)
    return
  }
  try {
    into[name] = (valueText(value) ?? String(value)).slice(0, MAX_TEXT)
  } catch {
    into[name] = String(value).slice(0, MAX_TEXT)
  }
}

/** Every part's inputs, outputs and state after a settle. */
export function frameValues(model: ModelState, settled: Settled): TraceFrame['values'] {
  const values: TraceFrame['values'] = {}
  for (const [path, reading] of settled.readings) {
    const ports: Record<string, TraceValue> = {}
    for (const [name, value] of Object.entries(reading.inputs)) flatten(name, value, ports)
    for (const [name, value] of Object.entries(reading.outputs)) flatten(name, value, ports)
    values[path] = ports
    const state: Record<string, TraceValue> = {}
    for (const [name, value] of Object.entries(model.states.get(path) ?? {})) flatten(name, value, state)
    if (Object.keys(state).length) values[`${path}/state`] = state
  }
  return values
}

/** The exact reference of a kept settle of `runId`. */
/**
 * What a kept settle's digest is of: its values, every part's state and every
 * input set, as canonical JSON. Written with a durable run, so the moment can
 * be read back exactly once the App is closed.
 */
export const capturedState = (capture: TraceCapture): string =>
  canonicalJson({ values: capture.kept.frame.values, states: capture.kept.states, pins: capture.kept.pins })

async function observationOf(runId: string, kept: Kept): Promise<ObservationRef> {
  return {
    schema: ARTIFACT_RUNTIME_SCHEMA,
    runId,
    index: integerText(kept.frame.cycle),
    domain: TRACE_DOMAIN,
    time: integerText(kept.frame.cycle),
    stateDigest: await digestOf({ values: kept.frame.values, states: kept.states, pins: kept.pins }),
  }
}

/**
 * The model's settles, cycle by cycle. A cycle can be shown again as it was,
 * and run again from with one value changed: the cycles after it are replayed
 * from their causes under a new recording id, and the old run stays in the
 * viewer to compare.
 */
/** The most replaced runs whose settles stay held, as the parents a fork is written after. */
const MAX_RETAINED_RUNS = 16

export class CycleTrace {
  private kept: Array<Kept> = []
  private run = 0
  private parent: Promise<NonNullable<SpatialRun['parent']>> | undefined
  /** Replaced runs, up to where a re-run forked from them, so a fork's parent can still be written. */
  private readonly retained = new Map<
    string,
    { first: number; kept: Array<Kept>; parent: Promise<NonNullable<SpatialRun['parent']>> | undefined }
  >()
  private readonly listeners = new Set<() => void>()

  constructor(
    private readonly model: ModelState,
    private readonly name: string,
  ) {}

  /** The recording the frames belong to; a new one after each re-run. */
  get recordingId(): string {
    return `${this.name}:${this.run}`
  }

  /** The latest cycle, or -1 before the first. */
  get cycle(): number {
    return this.kept.at(-1)?.frame.cycle ?? -1
  }

  /** The earliest cycle still kept. */
  get first(): number {
    return this.kept[0]?.frame.cycle ?? 0
  }

  /** Frames from `from` on (default: every one kept). */
  frames(from = this.first): Array<TraceFrame> {
    return this.kept.slice(Math.max(0, from - this.first)).map((kept) => kept.frame)
  }

  frame(cycle: number): TraceFrame | undefined {
    return this.kept[cycle - this.first]?.frame
  }

  /**
   * The parts that had not come to rest in `cycle`'s settle, or undefined
   * when the cycle is not kept. A non-empty list means the cycle's values are
   * not a settled state.
   */
  unsettled(cycle: number): Array<string> | undefined {
    return this.kept[cycle - this.first]?.settled.unsettled
  }

  /** The current run as a run reference names it. */
  async runRef(): Promise<SpatialRun> {
    const id = this.recordingId
    return runOf(id, await this.parent)
  }

  /**
   * The exact reference of a kept cycle: this run, the cycle's place, and the
   * digest of what the model held then (every value read, every state, every
   * input set). Undefined when the cycle is not kept, never the latest instead.
   */
  async observation(cycle: number): Promise<ObservationRef | undefined> {
    const kept = this.kept[cycle - this.first]
    return kept && observationOf(this.recordingId, kept)
  }

  /**
   * The settle `cycle` came to, as it was then: what every part read and
   * produced, the stages they fired in, and which parts were still changing.
   * Undefined when the cycle is not kept, never the latest instead.
   *
   * These are the only readings a looked-back cycle can be shown with. A part's
   * compute may read changing data outside the model, so settling the model
   * again says what its parts read now, not what they saw at that cycle; only
   * creating a new run (a set, a step, a re-run) computes. The readings are
   * handed as a copy, so what was recorded cannot be changed through them.
   */
  settled(cycle: number): Settled | undefined {
    const kept = this.kept[cycle - this.first]?.settled
    return kept && recorded(kept)
  }

  /**
   * Everything a question about `cycle` relies on, taken at once and before
   * any waiting: the run's name and lineage as they are now, and the kept
   * settle itself (its frame, states, pins and whether it came to rest). A
   * kept settle is never changed after it is recorded, and a re-run gives the
   * run a new name, so a later re-run or eviction cannot alter a capture.
   * Undefined when the cycle is not kept.
   */
  capture(cycle: number): TraceCapture | undefined {
    const kept = this.kept[cycle - this.first]
    if (!kept) return undefined
    return { runId: this.recordingId, parent: this.parent, kept }
  }

  /**
   * Captures of `runId`'s cycles `from` through `to`: the current run, or a
   * replaced run a re-run forked from, up to where it forked. Undefined when
   * any of those cycles is no longer held.
   */
  captures(runId: string, from: number, to: number): Array<TraceCapture> | undefined {
    const held =
      runId === this.recordingId
        ? { first: this.first, kept: this.kept, parent: this.parent }
        : this.retained.get(runId)
    if (!held || from < held.first || to < from || to - held.first >= held.kept.length) return undefined
    return held.kept
      .slice(from - held.first, to - held.first + 1)
      .map((kept) => ({ runId, parent: held.parent, kept }))
  }

  /**
   * Whether `observation` names a settle this trace holds now: the same run,
   * a kept index, and the same state. A run's kept settles never change under
   * one name, so the digest check guards only against a forged or mistyped
   * reference.
   */
  async holds(observation: ObservationRef): Promise<boolean> {
    const captured = this.capture(Number(observation.index))
    if (!captured || captured.runId !== observation.runId) return false
    const at = await observationOf(captured.runId, captured.kept)
    return at.stateDigest === observation.stateDigest && at.domain === observation.domain && at.time === observation.time
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Records a settle the model just made. */
  record(cause: TraceCause, settled: Settled): TraceFrame {
    const frame: TraceFrame = {
      cycle: this.cycle + 1,
      cause: causeText(cause),
      values: frameValues(this.model, settled),
    }
    this.kept.push({
      cause,
      frame,
      states: new Map([...this.model.states].map(([path, state]) => [path, clone(state)])),
      pins: new Map([...this.model.pins].map(([key, value]) => [key, clone(value)])),
      settled: recorded(settled),
      held: new Map([...this.model.held].map(([path, outputs]) => [path, clone(outputs)])),
    })
    if (this.kept.length > MAX_CYCLES) this.kept.splice(0, this.kept.length - MAX_CYCLES)
    for (const listener of this.listeners) listener()
    return frame
  }

  /** Puts the model back as it was right after `cycle`. False when that cycle is not kept. */
  show(cycle: number): boolean {
    const kept = this.kept[cycle - this.first]
    if (!kept) return false
    this.model.states.clear()
    for (const [path, state] of kept.states) this.model.states.set(path, clone(state))
    this.model.pins.clear()
    for (const [key, value] of kept.pins) this.model.pins.set(key, clone(value))
    this.model.held.clear()
    for (const [path, outputs] of kept.held) this.model.held.set(path, clone(outputs))
    return true
  }

  /**
   * Runs the model again from `cycle` with one value changed: the change is
   * the next cycle, then each later cycle's cause is replayed (a later change
   * to the same value is dropped, as this one replaces it). Returns the
   * model's last settle.
   */
  rerun(cycle: number, path: string, key: string, value: unknown): Settled {
    const from = this.kept[cycle - this.first]
    if (!from || !this.show(cycle)) throw new Error(`Cycle ${cycle} is not kept`)
    // The new run names the run and cycle it forked from, so the original is
    // kept as its parent rather than overwritten in name.
    const runId = this.recordingId
    const change = causeText({ kind: 'set', path, key, value })
    // The replaced run stays held through the cycle forked from: a kept
    // settle is never changed, so these are the same objects the fork shares.
    this.retained.set(runId, {
      first: this.first,
      kept: this.kept.slice(0, cycle - this.first + 1),
      parent: this.parent,
    })
    for (const old of [...this.retained.keys()].slice(0, Math.max(0, this.retained.size - MAX_RETAINED_RUNS)))
      this.retained.delete(old)
    this.parent = observationOf(runId, from).then((at) => ({ runId, at, change }))
    return this.rerunFrom(cycle, path, key, value)
  }

  private rerunFrom(cycle: number, path: string, key: string, value: unknown): Settled {
    const later = this.kept
      .slice(cycle - this.first + 1)
      .map((kept) => kept.cause)
      .filter((cause) => !(cause.kind === 'set' && cause.path === path && cause.key === key))
    this.kept.length = cycle - this.first + 1
    this.run += 1
    this.model.set(path, key, value)
    let settled = this.model.settle()
    this.record({ kind: 'set', path, key, value }, settled)
    for (const cause of later) {
      if (cause.kind === 'step') settled = this.model.step(settled)
      else if (cause.kind === 'set') {
        this.model.set(cause.path, cause.key, cause.value)
        settled = this.model.settle()
      } else continue
      this.record(cause, settled)
    }
    return settled
  }
}
