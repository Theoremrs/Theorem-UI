// SOURCING: bun:test over durable.ts with a real CycleTrace, and a bridge that
// keeps the store's rules: observations in order from index 0 per run, and a
// fork only after its parent recorded the moment it forks at.
import { describe, expect, it } from 'bun:test'
import { DurableTrace } from './durable'
import type { ArtifactsBridge, DurableObservation } from './durable'
import { buildNetwork, ModelState } from './engine'
import { register, rippleAdder } from './parts'
import { digestBytes } from '@theorem/runtime'
import { CycleTrace } from './trace'
import type { SpatialRun } from './trace'

function counter(steps: number) {
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
  for (let count = 0; count < steps; count++) {
    settled = model.step(settled)
    trace.record({ kind: 'step' }, settled)
  }
  return trace
}

const SOURCE = {
  kind: 'document',
  documentId: 'app',
  position: '4',
  contentDigest: 'c4',
} as const

function store(options: { fail?: boolean } = {}) {
  const runs = new Map<
    string,
    { run: SpatialRun; observations: Array<DurableObservation> }
  >()
  const calls: Array<string> = []
  const bridge: ArtifactsBridge = {
    async record(run, _domain, observations) {
      if (options.fail) throw new Error('store unavailable')
      calls.push(
        `${run.id} ${observations[0]!.index}-${observations.at(-1)!.index}`,
      )
      const held = runs.get(run.id) ?? { run, observations: [] }
      if (held.observations.length === 0 && run.parent) {
        const parent = runs.get(run.parent.runId)
        const at = parent?.observations[Number(run.parent.at.index)]
        if (at?.stateDigest !== run.parent.at.stateDigest)
          throw new Error('artifact_fork_invalid')
      }
      if (Number(observations[0]!.index) !== held.observations.length)
        throw new Error('artifact_chunk_out_of_order')
      held.observations.push(...observations)
      runs.set(run.id, held)
      return { through: observations.at(-1)!.index, source: SOURCE }
    },
  }
  return { runs, calls, bridge }
}

describe('a model run kept durably', () => {
  it('writes the run from index 0 through the moment asked about, and only what is new after', async () => {
    const trace = counter(4)
    const fake = store()
    const durable = new DurableTrace(trace, () => fake.bridge)
    expect(await durable.through((await trace.observation(2))!)).toEqual(SOURCE)
    expect(await durable.through((await trace.observation(1))!)).toEqual(SOURCE)
    expect(await durable.through((await trace.observation(4))!)).toEqual(SOURCE)
    expect(fake.calls).toEqual(['counter:0 0-2', 'counter:0 3-4'])
    expect(fake.runs.get('counter:0')!.observations[2]!.stateDigest).toBe(
      (await trace.observation(2))!.stateDigest,
    )
    // Every moment is written with the state its digest is of, so it can be read back.
    for (const written of fake.runs.get('counter:0')!.observations)
      expect<string>(
        await digestBytes(new TextEncoder().encode(written.state)),
      ).toBe(written.stateDigest)
    const state = JSON.parse(
      fake.runs.get('counter:0')!.observations[3]!.state,
    ) as { values: Record<string, unknown> }
    expect(state.values['pc/state']).toEqual({ value: 3 })
  })

  it('writes a re-run after its parent, through the moment it forked from', async () => {
    const trace = counter(4)
    const fake = store()
    const durable = new DurableTrace(trace, () => fake.bridge)
    trace.rerun(1, 'inc', 'b', 3)
    expect(trace.recordingId).toBe('counter:1')
    expect(await durable.through((await trace.observation(3))!)).toEqual(SOURCE)
    expect(fake.calls).toEqual(['counter:0 0-1', 'counter:1 0-3'])
    expect((await trace.runRef()).parent?.runId).toBe('counter:0')
  })

  it('claims nothing durable when the store refuses, or with no store at all', async () => {
    const trace = counter(2)
    const refusing = new DurableTrace(trace, () => store({ fail: true }).bridge)
    expect(
      await refusing.through((await trace.observation(1))!),
    ).toBeUndefined()
    const absent = new DurableTrace(trace, () => undefined)
    expect(absent.available).toBe(false)
    expect(await absent.through((await trace.observation(1))!)).toBeUndefined()
  })

  it('does not write a run whose early cycles were dropped before they were written', async () => {
    const trace = counter(5001)
    const fake = store()
    const durable = new DurableTrace(trace, () => fake.bridge)
    expect(trace.first).toBeGreaterThan(0)
    expect(
      await durable.through((await trace.observation(trace.cycle))!),
    ).toBeUndefined()
    expect(fake.calls).toEqual([])
  })
})
