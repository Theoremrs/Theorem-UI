// SOURCING: none: the dataflow an agent's spatial model runs on. Parts with
// ports, wires between them, a part's inside as a network of its own, and a
// settle that orders the parts into stages so a change can be watched
// travelling. No library models parts that can be opened into networks whose
// boundary is the part's own ports; signal-flow libraries (e.g. Rete's
// engine) evaluate flat graphs with no stages and no nesting.
//
// Nothing here draws or knows what a part represents: values are any JSON,
// and every part, built-in or written by the agent, is the same PartSpec.

export type Vec3 = [number, number, number]
export type Values = Record<string, unknown>

export type PortDirection = 'in' | 'out'

export interface PortSpec {
  dir: PortDirection
  /** Where the port sits on the part, in the part's own units. Placed on the part's faces when omitted. */
  at?: Vec3
  label?: string
}

export type ControlSpec =
  | { kind: 'number'; min?: number; max?: number; step?: number; label?: string }
  | { kind: 'range'; min: number; max: number; step?: number; label?: string }
  /** `off` and `on` name what each setting does (`Add`, `AND`), so the control says it. */
  | { kind: 'toggle'; label?: string; off?: string; on?: string }
  | { kind: 'bits'; bits: number; label?: string }
  /** `labels` are what the person reads for each option, in the same order. */
  | { kind: 'select'; options: Array<string>; labels?: Array<string>; label?: string }

/** A handle in the scene that sets a value by dragging it along an axis. */
export interface HandleSpec {
  /** The state key or unwired input it sets. */
  key: string
  axis: 'x' | 'y' | 'z'
  /** Where the handle is at `min`, in the part's units. */
  at: Vec3
  /** How far it travels from `min` to `max`, in the part's units. */
  length: number
  min: number
  max: number
  step?: number
  label?: string
}

export interface CheckSpec {
  name?: string
  inputs?: Values
  state?: Values
  /** The outputs expected, by port. Only the ports named are compared. */
  expect: Values
}

/** What a part's own drawing code is handed after every change. */
export interface ShowContext {
  values: Values
  state: Values
  /** 0 when idle, rising to 1 as the part fires. */
  activity: number
}

/**
 * A part: what it is, how it is built, what it computes, how it can be
 * handled, what it contains, and how its behavior is checked. The form is
 * whatever the drawing layer accepts (index.ts types it for three.js).
 */
export interface PartSpec<TForm = unknown, TObject = unknown> {
  id: string
  label?: string
  /** What the part represents and the assumptions it makes. */
  about?: string
  at?: Vec3
  /** Euler angles in radians. */
  rotate?: Vec3
  scale?: number
  form?: TForm
  color?: string
  /** Cells sampled over the form; 0 for none. Scaled from the form's area when omitted. */
  cells?: number
  ports?: Record<string, PortDirection | PortSpec>
  /** Values of input ports no wire reaches; the person can change them. */
  defaults?: Values
  state?: Values
  /** Controls beside the part, for state keys or unwired inputs. */
  controls?: Record<string, ControlSpec>
  handles?: Array<HandleSpec>
  /** Outputs from inputs and state. A part with an inside computes through it instead. */
  compute?: (inputs: Values, state: Values) => Values
  /** A clocked part: its next state, on each step. Its outputs then come from state alone. */
  tick?: (inputs: Values, state: Values) => Values
  /** The part's structure when it is opened: a network whose boundary is this part's ports. */
  inside?: (inner: Builder<TForm, TObject>) => void
  checks?: Array<CheckSpec>
  /** How a value is written beside a port. */
  format?: (value: unknown, port: string) => string
  /**
   * The part's own drawing reacting to its values (index.ts types the object).
   * It may give a mesh new geometry, as a form regenerated from its recipe
   * does; the view refits the part's edges, cells and ports to it.
   */
  show?: (object: TObject, context: ShowContext) => void
  /** Whether the person can pull it out of the assembly. Default true. */
  movable?: boolean
}

export interface WireSpec {
  from: string
  to: string
  label?: string
}

/** How a network is described: the model, and every part's inside. */
export interface Builder<TForm = unknown, TObject = unknown> {
  part: (spec: PartSpec<TForm, TObject>) => { id: string }
  /**
   * `from` and `to` are `part.port`. Inside a part, `.port` is the part's own
   * port: a source when it is an input, a destination when it is an output.
   */
  wire: (from: string, to: string, options?: { label?: string }) => void
}

export interface Port {
  name: string
  dir: PortDirection
  at?: Vec3
  label?: string
}

export interface Part {
  /** `alu`, or `alu/fa0` for a part inside another. */
  path: string
  spec: PartSpec
  ports: Array<Port>
  inside?: Network
}

export interface Endpoint {
  /** The part's path, or the network's owner's path for `.port`. */
  part: string
  port: string
  boundary: boolean
}

export interface Wire {
  id: string
  from: Endpoint
  to: Endpoint
  label?: string
}

export interface Network {
  /** The part this is the inside of; '' for the model. */
  owner: string
  parts: Array<Part>
  wires: Array<Wire>
}

const portsOf = (spec: PartSpec): Array<Port> =>
  Object.entries(spec.ports ?? {}).map(([name, port]) =>
    typeof port === 'string'
      ? { name, dir: port }
      : { name, dir: port.dir, at: port.at, label: port.label },
  )

class SpecError extends Error {
  override name = 'SpatialModelError'
}

/** Builds a network from a description, checking every reference in it. */
export function buildNetwork(
  describe: (builder: Builder) => void,
  owner = '',
  ownerPorts: Array<Port> = [],
): Network {
  const parts: Array<Part> = []
  const pending: Array<WireSpec> = []
  const where = owner ? ` inside ${owner}` : ''
  describe({
    part(spec) {
      // An App written in plain JavaScript is not held to the types, so a missing spec is named, not thrown on.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (!spec || typeof spec.id !== 'string' || !/^[\w-]+$/.test(spec.id))
        throw new SpecError(
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
          `A part${where} needs an id of letters, digits, - or _ (got ${JSON.stringify(spec?.id)})`,
        )
      if (parts.some((part) => part.spec.id === spec.id))
        throw new SpecError(`Two parts${where} have the id "${spec.id}"`)
      const path = owner ? `${owner}/${spec.id}` : spec.id
      const ports = portsOf(spec)
      parts.push({
        path,
        spec,
        ports,
        inside: spec.inside
          ? buildNetwork(spec.inside, path, ports)
          : undefined,
      })
      return { id: spec.id }
    },
    wire(from, to, options) {
      pending.push({ from, to, label: options?.label })
    },
  })
  const endpoint = (ref: string, role: 'from' | 'to'): Endpoint => {
    const dot = ref.lastIndexOf('.')
    if (dot < 0)
      throw new SpecError(`A wire${where} names "${ref}"; write part.port`)
    const id = ref.slice(0, dot)
    const port = ref.slice(dot + 1)
    if (id === '') {
      const own = ownerPorts.find((candidate) => candidate.name === port)
      if (!owner || !own)
        throw new SpecError(
          `A wire${where} names ".${port}", which is not a port of ${owner || 'the model'}`,
        )
      const wanted = role === 'from' ? 'in' : 'out'
      if (own.dir !== wanted)
        throw new SpecError(
          `Inside ${owner}, ".${port}" is an ${own.dir}put, so it can only be a wire's ${own.dir === 'in' ? 'source' : 'destination'}`,
        )
      return { part: owner, port, boundary: true }
    }
    const part = parts.find((candidate) => candidate.spec.id === id)
    if (!part) throw new SpecError(`A wire${where} names a part "${id}" there is none of`)
    const found = part.ports.find((candidate) => candidate.name === port)
    if (!found)
      throw new SpecError(
        `A wire${where} names "${ref}", but ${id} has no port "${port}" (it has ${part.ports.map((p) => p.name).join(', ') || 'none'})`,
      )
    const wanted = role === 'from' ? 'out' : 'in'
    if (found.dir !== wanted)
      throw new SpecError(
        `A wire${where} ${role === 'from' ? 'starts' : 'ends'} at "${ref}", an ${found.dir}put; wires run from outputs to inputs`,
      )
    return { part: part.path, port, boundary: false }
  }
  const wires = pending.map((wire, index) => ({
    id: `${owner}#${index}`,
    from: endpoint(wire.from, 'from'),
    to: endpoint(wire.to, 'to'),
    label: wire.label,
  }))
  for (const wire of wires) {
    const into = wires.filter(
      (other) =>
        other.to.part === wire.to.part && other.to.port === wire.to.port,
    )
    if (into.length > 1)
      throw new SpecError(
        `Two wires${where} reach ${wire.to.boundary ? '' : wire.to.part.split('/').pop()}.${wire.to.port}; an input takes one`,
      )
  }
  return { owner, parts, wires }
}

/** Every part in a network and every network inside it. */
export function* allParts(network: Network): Generator<Part> {
  for (const part of network.parts) {
    yield part
    if (part.inside) yield* allParts(part.inside)
  }
}

/** What one part saw and produced in a settle, and when. */
export interface PartReading {
  inputs: Values
  outputs: Values
  /** Its stage within its own network, from 0. */
  stage: number
}

export interface Settled {
  /** By part path, every part at every depth. */
  readings: Map<string, PartReading>
  /** The model's parts in the order they fire, stage by stage. */
  stages: Array<Array<string>>
  /**
   * The parts of a loop that were still changing when the settle gave up
   * after its passes. Empty when every network came to rest; otherwise the
   * values read are not a settled state and must not be presented as one.
   */
  unsettled: Array<string>
}

const CYCLE_PASSES = 32

const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/**
 * The live model: the network, the state of every part, and what the person
 * set on unwired inputs. A settle evaluates every network to rest.
 */
export class ModelState {
  readonly states = new Map<string, Values>()
  /** Values the person set on unwired inputs, by `path.port`. */
  readonly pins = new Map<string, unknown>()
  private readonly byPath = new Map<string, Part>()

  constructor(readonly network: Network) {
    for (const part of allParts(network)) {
      this.byPath.set(part.path, part)
      this.states.set(part.path, structuredClone(part.spec.state ?? {}))
    }
  }

  part(path: string): Part | undefined {
    return this.byPath.get(path)
  }

  /** The wire into an input, if any, in the network the part is in. */
  wireInto(path: string, port: string): Wire | undefined {
    return this.networkOf(path)?.wires.find(
      (wire) => wire.to.part === path && wire.to.port === port && !wire.to.boundary,
    )
  }

  networkOf(path: string): Network | undefined {
    const owner = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
    return owner ? this.byPath.get(owner)?.inside : this.network
  }

  /** Whether a key of a part is an input no wire reaches. */
  isPin(path: string, key: string): boolean {
    const part = this.byPath.get(path)
    const port = part?.ports.find((candidate) => candidate.name === key)
    if (!port || port.dir !== 'in') return false
    if (this.wireInto(path, key)) return false
    // An input of a part inside another may be fed by the owner's port.
    const owner = this.networkOf(path)
    return !owner?.wires.some(
      (wire) => wire.to.part === path && wire.to.port === key,
    )
  }

  /** Sets a state key, or the value of an unwired input. */
  set(path: string, key: string, value: unknown): void {
    if (!this.byPath.has(path)) throw new SpecError(`No part "${path}"`)
    if (this.isPin(path, key)) this.pins.set(`${path}.${key}`, value)
    else this.states.set(path, { ...this.states.get(path), [key]: value })
  }

  value(path: string, key: string, settled?: Settled): unknown {
    if (this.isPin(path, key)) return this.pinValue(path, key)
    const reading = settled?.readings.get(path)
    if (reading && key in reading.inputs) return reading.inputs[key]
    return this.states.get(path)?.[key]
  }

  private pinValue(path: string, port: string): unknown {
    const key = `${path}.${port}`
    if (this.pins.has(key)) return this.pins.get(key)
    return this.byPath.get(path)?.spec.defaults?.[port]
  }

  settle(): Settled {
    const readings = new Map<string, PartReading>()
    const unsettled: Array<string> = []
    const stages = this.settleNetwork(this.network, {}, readings, unsettled)
    return { readings, stages, unsettled }
  }

  /** Advances every clocked part one step from what the last settle saw, and settles again. */
  step(last: Settled = this.settle()): Settled {
    const next = new Map<string, Values>()
    for (const part of allParts(this.network)) {
      if (!part.spec.tick) continue
      const reading = last.readings.get(part.path)
      const state = this.states.get(part.path) ?? {}
      next.set(part.path, {
        ...state,
        ...part.spec.tick(reading?.inputs ?? {}, state),
      })
    }
    for (const [path, state] of next) this.states.set(path, state)
    return this.settle()
  }

  /** Evaluates a network to rest. Returns its parts' stages. */
  private settleNetwork(
    network: Network,
    boundary: Values,
    readings: Map<string, PartReading>,
    unsettled: Array<string> = [],
  ): Array<Array<string>> {
    const outputs = new Map<string, Values>()
    const stageOf = new Map<string, number>()
    const sourceOf = (path: string, port: string): unknown => {
      const wire = network.wires.find(
        (candidate) =>
          candidate.to.part === path &&
          candidate.to.port === port &&
          !candidate.to.boundary,
      )
      if (!wire) return this.pinValue(path, port)
      if (wire.from.boundary) return boundary[wire.from.port]
      return outputs.get(wire.from.part)?.[wire.from.port]
    }
    const inputsOf = (part: Part): Values =>
      Object.fromEntries(
        part.ports
          .filter((port) => port.dir === 'in')
          .map((port) => [port.name, sourceOf(part.path, port.name)]),
      )
    const evaluate = (part: Part): Values => {
      const inputs = inputsOf(part)
      const state = this.states.get(part.path) ?? {}
      let result: Values
      if (part.inside) {
        this.settleNetwork(part.inside, inputs, readings, unsettled)
        result = this.boundaryOutputs(part.inside, readings, inputs)
      } else if (part.spec.compute) {
        // A compute written in plain JavaScript may return nothing.
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        result = part.spec.compute(inputs, state) ?? {}
      } else {
        result = {}
      }
      readings.set(part.path, {
        inputs,
        outputs: result,
        stage: readings.get(part.path)?.stage ?? 0,
      })
      return result
    }
    // A part's stage is one past the latest stage of the parts feeding it;
    // clocked parts and parts fed only from outside fire first.
    const feeders = (part: Part) =>
      part.spec.tick
        ? []
        : network.wires
            .filter((wire) => wire.to.part === part.path && !wire.from.boundary)
            .map((wire) => wire.from.part)
    const remaining = new Set(network.parts.map((part) => part.path))
    while (remaining.size) {
      let progressed = false
      for (const part of network.parts) {
        if (!remaining.has(part.path)) continue
        const from = feeders(part)
        if (from.some((path) => remaining.has(path) && path !== part.path)) continue
        stageOf.set(
          part.path,
          from.reduce((stage, path) => Math.max(stage, (stageOf.get(path) ?? -1) + 1), 0),
        )
        remaining.delete(part.path)
        progressed = true
      }
      if (!progressed) {
        // A loop with no clocked part in it: its parts share the next stage
        // and are evaluated until their values rest.
        const next = Math.max(-1, ...stageOf.values()) + 1
        for (const path of remaining) stageOf.set(path, next)
        remaining.clear()
      }
    }
    const ordered = [...network.parts].sort(
      (a, b) => stageOf.get(a.path)! - stageOf.get(b.path)!,
    )
    let changing: Array<string> = []
    for (let pass = 0; pass < CYCLE_PASSES; pass++) {
      changing = []
      for (const part of ordered) {
        const result = evaluate(part)
        if (!equal(result, outputs.get(part.path))) changing.push(part.path)
        outputs.set(part.path, result)
      }
      if (!changing.length) break
    }
    for (const path of changing) if (!unsettled.includes(path)) unsettled.push(path)
    const stages: Array<Array<string>> = []
    for (const part of ordered) {
      const stage = stageOf.get(part.path)!
      readings.set(part.path, { ...readings.get(part.path)!, stage })
      ;(stages[stage] ??= []).push(part.path)
    }
    return stages.filter(Boolean)
  }

  private boundaryOutputs(
    network: Network,
    readings: Map<string, PartReading>,
    inputs: Values,
  ): Values {
    const result: Values = {}
    for (const wire of network.wires) {
      if (!wire.to.boundary) continue
      result[wire.to.port] = wire.from.boundary
        ? inputs[wire.from.port]
        : readings.get(wire.from.part)?.outputs[wire.from.port]
    }
    return result
  }

  /** Runs every part's checks. Returns what failed, in words. */
  check(): Array<string> {
    const failures: Array<string> = []
    for (const part of allParts(this.network)) {
      for (const [index, check] of (part.spec.checks ?? []).entries()) {
        const name = check.name ?? `check ${index + 1}`
        try {
          const got = this.evaluateAlone(part, check.inputs ?? {}, {
            ...part.spec.state,
            ...check.state,
          })
          for (const [port, expected] of Object.entries(check.expect))
            if (!equal(got[port], expected))
              failures.push(
                `${part.path}: ${name}: ${port} is ${JSON.stringify(got[port])}, expected ${JSON.stringify(expected)}`,
              )
        } catch (error) {
          failures.push(
            `${part.path}: ${name} threw: ${error instanceof Error ? error.message : String(error)}`,
          )
        }
      }
    }
    return failures
  }

  /** A part's outputs for these inputs and state, on its own. */
  private evaluateAlone(part: Part, inputs: Values, state: Values): Values {
    if (part.inside) {
      const alone = new ModelState(part.inside)
      for (const inner of allParts(part.inside))
        alone.states.set(inner.path, this.states.get(inner.path) ?? {})
      const readings = new Map<string, PartReading>()
      alone.settleNetwork(part.inside, inputs, readings)
      return alone.boundaryOutputs(part.inside, readings, inputs)
    }
    return part.spec.compute?.(inputs, state) ?? {}
  }

  /** What the person changed, to keep across revisions of the App. */
  snapshot(): { pins: Values; states: Record<string, Values> } {
    const states: Record<string, Values> = {}
    for (const [path, state] of this.states)
      if (!equal(state, this.byPath.get(path)?.spec.state ?? {})) states[path] = state
    return { pins: Object.fromEntries(this.pins), states }
  }

  /** Puts back what the person changed, for the parts and keys that still exist. */
  restore(snapshot: { pins?: Values; states?: Record<string, Values> }): void {
    for (const [key, value] of Object.entries(snapshot.pins ?? {})) {
      const dot = key.lastIndexOf('.')
      const path = key.slice(0, dot)
      if (this.byPath.has(path) && this.isPin(path, key.slice(dot + 1)))
        this.pins.set(key, value)
    }
    for (const [path, state] of Object.entries(snapshot.states ?? {})) {
      const part = this.byPath.get(path)
      if (!part) continue
      const declared = part.spec.state ?? {}
      const kept = Object.fromEntries(
        Object.entries(state).filter(([key]) => key in declared),
      )
      this.states.set(path, { ...declared, ...kept })
    }
  }

  /** One part in words: what it is, what it saw, what it produced, its state. */
  describe(path: string, settled: Settled): string {
    const part = this.byPath.get(path)
    if (!part) return ''
    const reading = settled.readings.get(path)
    const write = (values: Values) =>
      Object.entries(values)
        .map(([key, value]) => `${key}=${part.spec.format?.(value, key) ?? JSON.stringify(value)}`)
        .join(' ')
    return [
      `${part.spec.label ?? part.spec.id} (${path})`,
      part.spec.about,
      reading && Object.keys(reading.inputs).length ? `inputs: ${write(reading.inputs)}` : '',
      reading && Object.keys(reading.outputs).length ? `outputs: ${write(reading.outputs)}` : '',
      Object.keys(this.states.get(path) ?? {}).length
        ? `state: ${write(this.states.get(path)!)}`
        : '',
      reading ? `fires at stage ${reading.stage + 1}` : '',
      part.inside ? `contains: ${part.inside.parts.map((p) => p.spec.label ?? p.spec.id).join(', ')}` : '',
    ]
      .filter(Boolean)
      .join('\n')
  }
}
