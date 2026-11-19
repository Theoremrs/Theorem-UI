// Where a scrub lands, and which settle it shows. The decision is read here
// without a renderer; view.ts's scrub() is the only caller, and can display
// nothing but what this returns.
import { describe, expect, it } from 'bun:test'
import { buildNetwork, ModelState } from './engine'
import type { Settled } from './engine'
import { CycleTrace } from './trace'
import { scrubTarget } from './view'

/** A model whose part reads changing data outside itself, as a compute may. */
function impure() {
  const outside = { value: 10 }
  const model = new ModelState(
    buildNetwork((m) => {
      m.part({ id: 'read', ports: { out: 'out' }, compute: () => ({ out: outside.value }) })
      m.part({ id: 'echo', ports: { in: 'in', out: 'out' }, compute: ({ in: heard }) => ({ out: heard }) })
      m.wire('read.out', 'echo.in')
    }),
  )
  const trace = new CycleTrace(model, 'impure')
  // Cycle 0 recorded the reading 10; cycle 1, made after the outside changed,
  // recorded 20.
  trace.record({ kind: 'start' }, model.settle())
  outside.value = 20
  trace.record({ kind: 'step' }, model.settle())
  return { model, trace, outside }
}

const out = (settled: Settled, path: string): unknown => settled.readings.get(path)?.outputs.out

describe('looking back through a recording', () => {
  it('shows the readings the cycle recorded, not ones the parts compute again', () => {
    const { model, trace } = impure()
    // The premise: a settle computed today says 20 about cycle 0, so computing
    // again is not the same thing as reading the recording.
    expect(out(model.settle(), 'read')).toBe(20)

    const back = scrubTarget(trace, model, 0, null)
    expect(back?.viewing).toBe(0)
    expect(out(back!.settled, 'read')).toBe(10)
    expect(out(back!.settled, 'echo')).toBe(10)
    // Nothing was computed on the way there: the model is left holding cycle 0's
    // outputs, not the ones a settle would have written back over them.
    expect(model.held.get('read')).toEqual({ out: 10 })
    expect(model.states.get('read')).toEqual({})
  })

  it('shows the live model when it reaches the latest cycle', () => {
    const { model, trace, outside } = impure()
    scrubTarget(trace, model, 0, null)
    outside.value = 30 // and the data outside the model changes again
    const live = scrubTarget(trace, model, null, 0)
    // The latest is not history: it is settled from the model as it now stands,
    // so it reads 30 where the recording of cycle 1 holds 20.
    expect(live?.viewing).toBeNull()
    expect(out(live!.settled, 'read')).toBe(30)
    expect(out(trace.settled(1)!, 'read')).toBe(20)
    expect(model.held.get('read')).toEqual({ out: 30 })
    // A cycle past the end of the recording is the latest, not a kept one.
    expect(scrubTarget(trace, model, 9, 0)?.viewing).toBeNull()
    expect(outside.value).toBe(30)
  })

  it('says nothing when the scrub would not move anywhere', () => {
    const { model, trace } = impure()
    expect(scrubTarget(trace, model, 1, null)).toBeUndefined()
    expect(scrubTarget(trace, model, 0, 0)).toBeUndefined()
    expect(scrubTarget(trace, model, null, null)).toBeUndefined()
    expect(trace.settled(0)?.readings.get('read')?.outputs).toEqual({ out: 10 })
  })

  it('clamps to the earliest cycle kept, and reads that cycle', () => {
    const { model, trace, outside } = impure()
    outside.value = 30
    trace.record({ kind: 'step' }, model.settle()) // cycle 2
    // Look back past where the recording starts: the earliest kept cycle shows.
    const back = scrubTarget(trace, model, -5, null)
    expect(back?.viewing).toBe(0)
    expect(out(back!.settled, 'read')).toBe(10)
    expect(out(model.settle(), 'read')).toBe(30)
  })
})
