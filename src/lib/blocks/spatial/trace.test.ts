import { describe, expect, it } from 'bun:test'
import { buildNetwork, ModelState } from './engine'
import { gate, register, rippleAdder } from './parts'
import { capturedState, CycleTrace, flatten } from './trace'

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

/**
 * A model whose part reads changing data outside itself, as a part's compute
 * may (a clock, a random draw, a value fetched since the last cycle). What each
 * cycle saw then exists only in the recording: settling the model again reads
 * what is outside now, and says nothing about the past.
 */
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
  return { model, trace, outside }
}

describe('what a cycle recorded', () => {
  it('is read back for a kept cycle after the data its parts read has changed', () => {
    const { model, trace, outside } = impure()
    trace.record({ kind: 'start' }, model.settle()) // cycle 0: read 10
    outside.value = 20
    trace.record({ kind: 'step' }, model.settle()) // cycle 1: read 20

    expect(trace.settled(0)?.readings.get('read')?.outputs).toEqual({ out: 10 })
    expect(trace.settled(0)?.readings.get('echo')?.inputs).toEqual({ in: 10 })
    expect(trace.settled(1)?.readings.get('read')?.outputs).toEqual({ out: 20 })
    expect(trace.settled(2)).toBeUndefined()
    expect(trace.settled(-1)).toBeUndefined()

    // Computing it again cannot recover cycle 0: putting the model back as it
    // was then does not put back what was outside it.
    expect(model.settle().readings.get('read')?.outputs).toEqual({ out: 20 })
    expect(trace.show(0)).toBe(true)
    expect(model.settle().readings.get('read')?.outputs).toEqual({ out: 20 })
    expect(trace.settled(0)?.readings.get('read')?.outputs).toEqual({ out: 10 })
  })

  it('cannot be changed by whoever reads it, nor by the model after it', () => {
    const { model, trace, outside } = impure()
    trace.record({ kind: 'start' }, model.settle())

    const shown = trace.settled(0)!
    shown.readings.get('read')!.outputs.out = 999
    shown.readings.delete('echo')
    shown.stages.length = 0
    expect(trace.settled(0)?.readings.get('read')?.outputs).toEqual({ out: 10 })
    expect(trace.settled(0)?.readings.has('echo')).toBe(true)

    // Nor does a later settle of the model reach into what was recorded.
    outside.value = 20
    model.settle()
    expect(trace.settled(0)?.readings.get('read')?.outputs).toEqual({ out: 10 })
  })

  it('carries the stages of the settle and whether it came to rest', () => {
    const { model, trace } = impure()
    trace.record({ kind: 'start' }, model.settle())
    expect(trace.settled(0)?.stages).toEqual([['read'], ['echo']])
    expect(trace.settled(0)?.unsettled).toEqual([])
    expect(trace.unsettled(0)).toEqual([])
  })

  it('is kept for browsing alone: what is digested and stored durably is unchanged', () => {
    const { model, trace } = impure()
    trace.record({ kind: 'start' }, model.settle())
    const capture = trace.capture(0)!
    // The durable state of a moment is its frame's values, every part's state
    // and every input set. The recorded readings are not added to it.
    expect(Object.keys(JSON.parse(capturedState(capture))).sort()).toEqual(['pins', 'states', 'values'])
    expect(capture.kept.frame.values.read).toEqual({ out: 10 })
  })
})

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

  it('still holds an old run\u2019s reference after a re-run replaces it mid-check', async () => {
    // view.ts's reveal() waits on holds() before moving anywhere. The capture
    // is taken synchronously, the digest awaited, so this is the state a
    // change made during that wait leaves behind.
    const { trace } = counter()
    const at = (await trace.observation(3))!
    const holding = trace.holds(at)
    // Every cycle past the fork point is replaced: the new run\u2019s cycle 3 is
    // three steps of 3 (pc = 6), not the old run\u2019s three steps of 1 (pc = 3).
    trace.rerun(0, 'inc', 'b', 3)
    // The captured settle never changed, so the check that started before the
    // re-run still says true \u2014 true of the old run, not of where the trace is now.
    expect(await holding).toBe(true)
    // The trace is on a new run, and a scrub at the reference\u2019s index would land
    // on a different state while reporting success. So reveal() rechecks
    // recordingId against observation.runId after the await and before moving;
    // holds() alone cannot be the last word.
    expect(trace.recordingId).not.toBe(at.runId)
    expect(trace.frame(3)?.values['pc/state']).toEqual({ value: 6 })
    // And a check started after the re-run sees the replacement for what it is.
    expect(await trace.holds(at)).toBe(false)
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
