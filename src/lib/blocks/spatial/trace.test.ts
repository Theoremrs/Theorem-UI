import { describe, expect, it } from 'bun:test'
import { buildNetwork, ModelState } from './engine'
import { register, rippleAdder } from './parts'
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

describe('a trace as a durable run reads it', () => {
  it('names each settle as a settlement, not a clock cycle, with an exact state digest', async () => {
    const { trace } = counter()
    const at = await trace.observation(3)
    expect(at).toMatchObject({ runId: 'counter:0', index: '3', domain: 'settlement', time: '3' })
    expect(at?.stateDigest).toMatch(/^sha256:[0-9a-f]{64}$/)
    // The same moment has the same digest; another moment does not.
    expect((await trace.observation(3))?.stateDigest).toBe(at!.stateDigest)
    expect((await trace.observation(2))?.stateDigest).not.toBe(at!.stateDigest)
    expect(await trace.observation(99)).toBeUndefined()
    expect((await trace.runRef()).domains).toEqual(['settlement'])
  })

  it('a run edited in the past names the run and moment it forked from', async () => {
    const { trace } = counter()
    const original = await trace.observation(1)
    trace.rerun(1, 'inc', 'b', 3)
    const run = await trace.runRef()
    expect(run.id).toBe('counter:1')
    expect(run.parent).toEqual({ runId: 'counter:0', at: original!, change: 'inc.b = 3' })
  })

  it('keeps values past 2^53 exact', () => {
    const into: Record<string, number | string> = {}
    flatten('wide', 2n ** 64n - 1n, into)
    flatten('small', 12n, into)
    expect(into).toEqual({ wide: '18446744073709551615', small: 12 })
  })
})
