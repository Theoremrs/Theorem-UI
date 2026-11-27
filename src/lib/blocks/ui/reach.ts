// SOURCING: none: how a @theorem/ui control reaches the agent. A control given
// a `control` name registers with `window.theorem.controls` (the App bridge,
// sandbox/controls.ts) the functions its visible element already calls, so
// the agent changes it the way a person does. Outside a Theorem frame there
// is no bridge and nothing is registered.
import { useEffect, useLayoutEffect, useRef } from 'react'
import type { Ref, RefCallback } from 'react'

/** What the agent reads of a control: what it is and which values it takes. */
export type ControlKind = 'number' | 'boolean' | 'choice' | 'text' | 'action'

/** A control as the bridge takes it; the same shape as `theorem.controls.register`'s. */
export interface ControlSpec {
  name: string
  label: string
  kind: ControlKind
  read?: () => unknown
  set?: (value: unknown) => void
  invoke?: () => void
  min?: number
  max?: number
  step?: number
  options?: Array<string>
  disabled?: () => boolean
}

/** The prop every @theorem/ui control takes: the name the agent knows it by. */
export interface Reach {
  /**
   * Names this control for the agent (`app.control`). The agent then reads
   * and changes it through the same functions this control calls; leave it
   * out and the control is the person's alone.
   */
  control?: string
}

interface Bridge {
  controls?: { register: (spec: ControlSpec) => () => void }
}

/**
 * Registers a control named `name` while the component is mounted. `spec` is
 * read when the agent acts, so its functions see the latest props.
 */
export function useControl(name: string | undefined, spec: Omit<ControlSpec, 'name'>): void {
  const latest = useRef(spec)
  useLayoutEffect(() => {
    latest.current = spec
  })
  const { label, kind, min, max, step } = spec
  const options = spec.options?.join('\u0000')
  useEffect(() => {
    const bridge = (globalThis as { theorem?: Bridge }).theorem
    if (!name || !bridge?.controls) return
    const now = latest.current
    return bridge.controls.register({
      name,
      label,
      kind,
      ...(min !== undefined && { min }),
      ...(max !== undefined && { max }),
      ...(step !== undefined && { step }),
      ...(options !== undefined && { options: options.split('\u0000') }),
      ...(now.read && { read: () => latest.current.read?.() }),
      ...(now.set && { set: (value: unknown) => latest.current.set?.(value) }),
      ...(now.invoke && { invoke: () => latest.current.invoke?.() }),
      disabled: () => latest.current.disabled?.() ?? false,
    })
  }, [name, label, kind, min, max, step, options])
}

/** One ref that sets every ref it is given. */
export function mergeRefs<T>(...refs: Array<Ref<T> | undefined>): RefCallback<T> {
  return (value) => {
    const cleanups = refs.map((ref) => {
      if (typeof ref === 'function') return ref(value)
      if (ref) ref.current = value
      return undefined
    })
    return () => {
      for (const [index, ref] of refs.entries()) {
        const cleanup = cleanups[index]
        if (typeof cleanup === 'function') cleanup()
        else if (typeof ref === 'function') ref(null)
        else if (ref) ref.current = null
      }
    }
  }
}
