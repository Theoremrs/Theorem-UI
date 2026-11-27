// SOURCING: none: the controls an App names for the agent. A control is
// registered with the functions its visible element already calls, so the
// agent's `app.control` and a person's pointer go through one owner of the
// control's behaviour (docs/plans/chromeless-artifacts.md, "One owner").
// `@theorem/ui`'s controls register themselves when given a `control` name;
// an App that draws its own registers here directly.
import type { ControlAct, ControlKind, ControlState } from './protocol'

/** A control as an App registers it: what it is, and the functions that read and change it. */
export interface ControlSpec {
  /** Unique within the App; what the agent names it by. */
  name: string
  label: string
  kind: ControlKind
  /** Its value now; an action has none. */
  read?: () => unknown
  /** What the visible control calls with a new value. */
  set?: (value: unknown) => void
  /** What pressing the visible control calls. */
  invoke?: () => void
  min?: number
  max?: number
  step?: number
  options?: Array<string>
  disabled?: () => boolean
}

const registered = new Map<string, ControlSpec>()

/** Names `spec` for the agent until the returned function is called. */
export function registerControl(spec: ControlSpec): () => void {
  registered.set(spec.name, spec)
  return () => {
    if (registered.get(spec.name) === spec) registered.delete(spec.name)
  }
}

const stateOf = (spec: ControlSpec): ControlState => {
  const state: ControlState = { name: spec.name, label: spec.label, kind: spec.kind }
  if (spec.read) state.value = spec.read()
  for (const key of ['min', 'max', 'step', 'options'] as const)
    if (spec[key] !== undefined) Object.assign(state, { [key]: spec[key] })
  if (spec.disabled?.()) state.disabled = true
  return state
}

/** Every registered control, with its value now. */
export const listControls = (): Array<ControlState> => [...registered.values()].map(stateOf)

// Two frames: React commits the change, then the App draws it.
const drawn = () =>
  new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))

/** A number held to the control's range and step, the values its slider can reach. */
function reachable(spec: ControlSpec, value: unknown): number {
  const number = typeof value === 'string' ? Number(value) : value
  if (typeof number !== 'number' || !Number.isFinite(number))
    throw new Error(`${spec.name} takes a number, not ${JSON.stringify(value)}`)
  let held = Math.min(spec.max ?? Infinity, Math.max(spec.min ?? -Infinity, number))
  if (spec.step) {
    const base = spec.min ?? 0
    const decimals = (String(spec.step).split('.')[1] ?? '').length
    held = Number((base + Math.round((held - base) / spec.step) * spec.step).toFixed(decimals))
  }
  return held
}

function accepted(spec: ControlSpec, value: unknown): unknown {
  switch (spec.kind) {
    case 'number':
      return reachable(spec, value)
    case 'boolean':
      if (typeof value !== 'boolean') throw new Error(`${spec.name} takes true or false`)
      return value
    case 'choice':
      if (!spec.options?.includes(String(value)))
        throw new Error(`${spec.name} takes one of ${JSON.stringify(spec.options ?? [])}`)
      return String(value)
    default:
      return String(value)
  }
}

/** Sets or presses a control through its own functions, then reads it back once drawn. */
export async function actOnControl({ name, action, value }: ControlAct): Promise<ControlState> {
  const spec = registered.get(name)
  if (!spec)
    throw new Error(`No control named ${JSON.stringify(name)}; this App names ${JSON.stringify([...registered.keys()])}`)
  if (spec.disabled?.()) throw new Error(`${name} is disabled`)
  if (action === 'invoke') {
    if (!spec.invoke) throw new Error(`${name} is not pressed; set it`)
    spec.invoke()
  } else {
    if (!spec.set) throw new Error(`${name} is not set; invoke it`)
    spec.set(accepted(spec, value))
  }
  await drawn()
  return stateOf(registered.get(name) ?? spec)
}
