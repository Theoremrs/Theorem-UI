// SOURCING: none: the record of a ModelState's settles that Rerun's viewer is
// fed from (timeline.tsx). Rerun has no browser SDK; the frames are written as
// a recording by its Rust SDK behind `theorem.trace.recording`. What is kept
// here besides the frames is the model's exact state after each one, so a
// scrubbed cycle can be shown as it was and run again from.

import type { ModelState, Settled } from './engine'

/** A primitive value a trace records: a number or text. */
export type TraceValue = number | string

/** What one settle of the model produced. */
export interface TraceFrame {
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
}

/** The most cycles kept; a model left running drops its oldest. */
export const MAX_CYCLES = 5000
const MAX_TEXT = 4000

export const causeText = (cause: TraceCause): string =>
  cause.kind === 'set'
    ? `${cause.path}.${cause.key} = ${JSON.stringify(cause.value) ?? String(cause.value)}`
    : cause.kind

const clone = <T>(value: T): T => {
  try {
    return structuredClone(value)
  } catch {
    return value
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
    into[name] = Number(value)
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
    into[name] = (JSON.stringify(value) ?? String(value)).slice(0, MAX_TEXT)
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

/**
 * The model's settles, cycle by cycle. A cycle can be shown again as it was,
 * and run again from with one value changed: the cycles after it are replayed
 * from their causes under a new recording id, and the old run stays in the
 * viewer to compare.
 */
export class CycleTrace {
  private kept: Array<Kept> = []
  private run = 0
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
    return true
  }

  /**
   * Runs the model again from `cycle` with one value changed: the change is
   * the next cycle, then each later cycle's cause is replayed (a later change
   * to the same value is dropped, as this one replaces it). Returns the
   * model's last settle.
   */
  rerun(cycle: number, path: string, key: string, value: unknown): Settled {
    if (!this.show(cycle)) throw new Error(`Cycle ${cycle} is not kept`)
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
