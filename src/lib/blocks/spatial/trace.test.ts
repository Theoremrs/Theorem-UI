import { describe, expect, it } from 'bun:test'
import { buildNetwork, ModelState } from './engine'
import { gate, register, rippleAdder } from './parts'
import { CycleTrace, flatten } from './trace'

/** A 4-bit counter: a register fed by an adder that adds `b` to it each step. */
function counter() {
  const model = new ModelState(
    buildNetwork((m) => {
      m.part(register({ id: 'pc', bits: 4 }))
      m.part(rippleAdder({ id: 'inc', bits: 4 }))
      m.wire('pc.out', 'inc.a')
      m.wire('inc.sum', 'pc.in')
    }),
  )
  const trace = new CycleTrace(model, 'counter')
  model.set('inc', 'b', 1)
  let settled = model.settle()
  trace.record({ kind: 'start' }, settled)
  for (let count = 0; count < 4; count++) {
    settled = model.step(settled)
    trace.record({ kind: 'step' }, settled)
  }
  return { model, trace }
}

describe('a model trace', () => {
  it('shows a latch as it held on the cycle looked back at', () => {
    const model = new ModelState(
      buildNetwork((m) => {
        m.part(gate({ id: 'n1', kind: 'nor' }))
        m.part(gate({ id: 'n2', kind: 'nor' }))
        m.wire('n1.out', 'n2.a')
        m.wire('n2.out', 'n1.b')
      }),
    )
    const trace = new CycleTrace(model, 'latch')
    const set = (path: string, key: string, value: number) => {
      model.set(path, key, value)
      trace.record({ kind: 'set', path, key, value }, model.settle())
    }
    trace.record({ kind: 'start' }, model.settle())
    set('n1', 'a', 1)
    set('n1', 'a', 0) // cycle 2: held after set
    set('n2', 'b', 1)
    set('n2', 'b', 0) // cycle 4: held after reset
    expect(trace.frame(2)?.values.n2).toMatchObject({ out: 1 })
    expect(trace.frame(4)?.values.n2).toMatchObject({ out: 0 })
    trace.show(2)
    expect(model.settle().readings.get('n2')?.outputs).toEqual({ out: 1 })
  })

  it('records every port and state on each cycle, with its cause', () => {
    const { trace } = counter()
    expect(trace.cycle).toBe(4)
    expect(trace.frames().map((frame) => frame.cause)).toEqual(['start', 'step', 'step', 'step', 'step'])
    expect(trace.frame(3)?.values['pc/state']).toEqual({ value: 3 })
    expect(trace.frame(3)?.values.inc).toMatchObject({ a: 3, b: 1, sum: 4, cout: 0 })
    // Parts inside an opened part are recorded at their own paths.
    expect(trace.frame(0)?.values['inc/fa0']).toBeDefined()
  })

  it('shows a cycle as it was, and runs again from it with a value changed', () => {
    const { model, trace } = counter()
    const first = trace.recordingId
    expect(trace.show(1)).toBe(true)
    expect(model.states.get('pc')).toEqual({ value: 1 })

    const settled = trace.rerun(1, 'inc', 'b', 3)
    expect(trace.recordingId).not.toBe(first)
    expect(trace.frames().map((frame) => frame.cause)).toEqual([
      'start',
      'step',
      'inc.b = 3',
      'step',
      'step',
      'step',
    ])
    // From pc = 1: the change settles, then three steps of 3 each.
    expect(model.states.get('pc')).toEqual({ value: 10 })
    expect(settled.readings.get('inc')?.inputs).toMatchObject({ a: 10, b: 3 })
    // The cycles before the change are as they were.
    expect(trace.frame(1)?.values['pc/state']).toEqual({ value: 1 })
  })

  it('keeps a frame safe from later changes to the model', () => {
    const { model, trace } = counter()
    trace.show(2)
    model.states.set('pc', { value: 9 })
    expect(trace.show(2)).toBe(true)
    expect(model.states.get('pc')).toEqual({ value: 2 })
  })

  it('flattens booleans, arrays and flat objects to primitives', () => {
    const into: Record<string, number | string> = {}
    flatten('on', true, into)
    flatten('bits', [1, 0, true], into)
    flatten('flags', { z: false, c: 1 }, into)
    flatten('deep', { a: { b: 1 } }, into)
    flatten('none', undefined, into)
    flatten('nan', Number.NaN, into)
    expect(into).toEqual({
      on: 1,
      'bits.0': 1,
      'bits.1': 0,
      'bits.2': 1,
      'flags.z': 0,
      'flags.c': 1,
      deep: '{"a":{"b":1}}',
    })
  })
})
