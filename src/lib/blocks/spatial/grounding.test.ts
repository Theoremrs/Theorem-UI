// The acceptance cases of docs/plans/durable-artifacts: a question's numbers
// come from the recorded moment it names, and the four-bit adder they are
// read from agrees with integer arithmetic everywhere.
import { describe, expect, it } from 'bun:test'
import { digestOf, signalText } from '@theorem/runtime'
import type { ChromeSnapshot, Grounding, PartSnapshot } from './chrome'
import { dossierContext, groundedContext, observedFacts, referencedMoment } from './dossier'
import { buildNetwork, ModelState } from './engine'
import { register, rippleAdder } from './parts'
import { CycleTrace, groundCapture } from './trace'

function adder(a: number, b: number, cin = 0) {
  const model = new ModelState(
    buildNetwork((m) => m.part(rippleAdder({ id: 'add', bits: 4 }))),
  )
  model.set('add', 'a', a)
  model.set('add', 'b', b)
  model.set('add', 'cin', cin)
  const trace = new CycleTrace(model, 'adder')
  trace.record({ kind: 'start' }, model.settle())
  return { model, trace }
}

const fact = (
  facts: ReturnType<typeof observedFacts>,
  entity: string,
  key: string,
) =>
  facts.find(
    (candidate) => candidate.entity === entity && candidate.key === key,
  )

async function factsOf(a: number, b: number, cin = 0) {
  const { trace } = adder(a, b, cin)
  return observedFacts(
    { path: 'add' },
    trace.frame(0),
    await trace.observation(0),
  )
}

describe('facts a question about the adder carries', () => {
  it('7 + 5 with carry-in 0 is 12 with final carry 0, and the internal carries are named apart', async () => {
    const facts = await factsOf(7, 5)
    expect(fact(facts, 'add', 'sum')?.value).toEqual({
      type: 'integer',
      text: '12',
    })
    expect(fact(facts, 'add', 'cout')?.value).toEqual({
      type: 'integer',
      text: '0',
    })
    // 0111 + 0101: stages 0, 1 and 2 carry; the last stage does not.
    expect(
      [0, 1, 2, 3].map((stage) =>
        signalText(fact(facts, `add/fa${stage}`, 'cout')!.value),
      ),
    ).toEqual(['1', '1', '1', '0'])
  })

  it('7 + 9 with carry-in 0 is 0 with final carry 1', async () => {
    const facts = await factsOf(7, 9)
    expect(signalText(fact(facts, 'add', 'sum')!.value)).toBe('0')
    expect(signalText(fact(facts, 'add', 'cout')!.value)).toBe('1')
  })

  it('every one of the 512 inputs agrees with integer arithmetic', () => {
    const { model } = adder(0, 0)
    for (let cin = 0; cin <= 1; cin++)
      for (let a = 0; a < 16; a++)
        for (let b = 0; b < 16; b++) {
          model.set('add', 'a', a)
          model.set('add', 'b', b)
          model.set('add', 'cin', cin)
          const outputs = model.settle().readings.get('add')!.outputs
          expect([a, b, cin, outputs.sum, outputs.cout]).toEqual([
            a,
            b,
            cin,
            (a + b + cin) & 15,
            a + b + cin > 15 ? 1 : 0,
          ])
        }
  })

  it('facts belong to the moment they name and to no other', async () => {
    const { trace } = adder(7, 5)
    const at = await trace.observation(0)
    expect(
      observedFacts({ path: 'add' }, trace.frame(0), { ...at!, index: '1' }),
    ).toEqual([])
    expect(observedFacts({ path: 'add' }, trace.frame(0), undefined)).toEqual(
      [],
    )
    expect(
      observedFacts({ path: 'add' }, trace.frame(0), at).every(
        (item) => item.observation === at,
      ),
    ).toBe(true)
  })
})

/** What view.ts's groundAt does: capture at once, then resolve only the capture. */
function groundOf(trace: CycleTrace, cycle: number) {
  const runId = trace.recordingId
  return async (): Promise<Grounding> => {
    const captured = trace.recordingId === runId ? trace.capture(cycle) : undefined
    if (!captured) return { run: { ...(await trace.runRef()), id: runId }, observation: undefined, frame: undefined, unsettled: [] }
    return groundCapture(captured)
  }
}

const part = {
  path: 'add',
  label: 'Adder',
  ports: [],
  state: [],
  summary: [],
} as unknown as PartSnapshot

function shown(
  trace: CycleTrace,
  cycle: number,
  viewing = false,
): ChromeSnapshot {
  return {
    title: 'Adder',
    trail: [],
    trace: {
      cycle,
      latest: trace.cycle,
      viewing,
      recent: trace.frames(),
      first: trace.first,
      runId: trace.recordingId,
      ground: groundOf(trace, cycle),
    },
  } as unknown as ChromeSnapshot
}

describe('a grounded question', () => {
  it('names the cycle looked back at, with its exact moment and facts, not the latest', async () => {
    const { model, trace } = adder(7, 5)
    model.set('add', 'b', 9)
    trace.record(
      { kind: 'set', path: 'add', key: 'b', value: 9 },
      model.settle(),
    )
    trace.show(0)
    const context = await groundedContext(part, shown(trace, 0, true), {
      selected: { id: 'add' },
    })
    expect(context.observation).toEqual(await trace.observation(0))
    expect(context.observationLifetime).toBe('session')
    expect(context.settled).toBe(true)
    const facts = context.facts as Array<{
      entity: string
      key: string
      text: string
    }>
    expect(
      facts.find((item) => item.entity === 'add' && item.key === 'sum')?.text,
    ).toBe('12')
    expect(
      facts.find((item) => item.entity === 'add' && item.key === 'b')?.text,
    ).toBe('5')
  })

  it('a moment no longer kept is said to be unavailable and claims no values', async () => {
    const { trace } = adder(7, 5)
    const snapshot = shown(trace, 0)
    const context = await groundedContext(part, snapshot, {}, async () => ({
      run: await trace.runRef(),
      observation: undefined,
      frame: undefined,
      unsettled: [],
    }))
    expect(context.observation).toBeNull()
    expect(context.unavailable).toBeString()
    expect(context.facts).toEqual([])
  })
})

describe('the referenced moment', () => {
  it('is offered when the person has moved since asking, and not changed for them', async () => {
    const { model, trace } = adder(7, 5)
    const asked = await trace.observation(0)
    model.set('add', 'b', 9)
    trace.record(
      { kind: 'set', path: 'add', key: 'b', value: 9 },
      model.settle(),
    )
    const state = {
      available: true,
      running: false,
      messages: [
        {
          id: 'q',
          role: 'user' as const,
          text: 'why?',
          status: 'complete' as const,
          subject: { kind: 'moment' as const, observation: asked! },
        },
      ],
    }
    expect(referencedMoment(state, shown(trace, 1))).toEqual({
      observation: asked!,
      cycle: 0,
      status: 'held',
    })
    expect(referencedMoment(state, shown(trace, 0, true))).toBeUndefined()
    trace.rerun(0, 'add', 'b', 3)
    expect(referencedMoment(state, shown(trace, 1))).toMatchObject({
      cycle: 0,
      status: 'replaced',
    })
  })
})

describe('a question grounds one capture, whatever happens while it is hashed', () => {
  it('a re-run started while grounding cannot pair the old run with the new run’s values', async () => {
    const { model, trace } = adder(7, 5)
    model.set('add', 'b', 9)
    trace.record({ kind: 'set', path: 'add', key: 'b', value: 9 }, model.settle())
    const snapshot = shown(trace, 1)
    // The question is asked, then a re-run replaces cycle 1 before hashing finishes.
    const asking = groundedContext(part, snapshot, { selected: { id: 'add' } })
    trace.rerun(0, 'add', 'b', 3)
    const context = await asking
    const observation = context.observation as { runId: string; index: string }
    expect((context.run as { id: string }).id).toBe('adder:0')
    expect(observation.runId).toBe('adder:0')
    const facts = context.facts as Array<{ entity: string; key: string; text: string }>
    // 7 + 9 = 16, which is 0 in four bits: the values of adder:0's cycle 1, not adder:1's 7 + 3.
    expect(facts.find((item) => item.entity === 'add' && item.key === 'sum')?.text).toBe('0')
    expect(facts.find((item) => item.entity === 'add' && item.key === 'b')?.text).toBe('9')
  })

  it('a question asked after the re-run is told the moment is gone, with no values', async () => {
    const { model, trace } = adder(7, 5)
    model.set('add', 'b', 9)
    trace.record({ kind: 'set', path: 'add', key: 'b', value: 9 }, model.settle())
    const snapshot = shown(trace, 1)
    trace.rerun(0, 'add', 'b', 3)
    const context = await groundedContext(part, snapshot, {})
    expect(context.observation).toBeNull()
    expect(context.facts).toEqual([])
    expect((context.run as { id: string }).id).toBe('adder:0')
  })
})

describe('a grounded question carries one moment’s values', () => {
  it('a scene partway through a change sends the recorded values, not the ones on screen', async () => {
    const { trace } = adder(7, 5)
    const snapshot = shown(trace, 0)
    // The scene still shows the previous reading of the sum while the change moves through it.
    const context = await groundedContext(part, snapshot, {
      inputs: [{ name: 'a', label: 'A', value: 7, text: '7', editable: true }],
      outputs: [{ name: 'sum', label: 'Sum', value: 3, text: '3' }],
    })
    const outputs = context.outputs as Array<{ name: string; text: string }>
    const facts = context.facts as Array<{ entity: string; key: string; text: string }>
    expect(outputs.find((port) => port.name === 'sum')?.text).toBe('12')
    expect(facts.find((item) => item.entity === 'add' && item.key === 'sum')?.text).toBe('12')
  })

  it('carries no second value for a name: the interactables the scene stamped are not sent', async () => {
    // A register asked about at its first moment, by which time the scene has
    // moved on: recorded there `in` is 3 and the held value 0, while what is
    // shown now reads `in` 7 and value 3.
    const model = new ModelState(buildNetwork((m) => m.part(register({ id: 'add', bits: 4 }))))
    const trace = new CycleTrace(model, 'adder')
    model.set('add', 'in', 3)
    let settled = model.settle()
    trace.record({ kind: 'start' }, settled)
    settled = model.step(settled)
    trace.record({ kind: 'step' }, settled)
    model.set('add', 'in', 7)
    trace.record({ kind: 'set', path: 'add', key: 'in', value: 7 }, model.settle())
    trace.show(0)
    // PartSettings stamps the values as the scene shows them, which can be one
    // commit behind the moment being grounded; inputs and settings are written
    // from the part snapshot the question was sent with, live there too.
    const context = await groundedContext(part, shown(trace, 0, true), {
      inputs: [{ name: 'in', label: 'In', value: 7, text: '7', editable: true }],
      settings: [{ name: 'value', value: 3, text: '3', editable: false }],
      interactables: [{ id: 'add', name: 'part', state: { in: 7, load: 1, value: 3 } }],
    })
    // One payload cannot hold two values for the same name at the same moment,
    // so the displayed stamp goes, as the unavailable path already drops it.
    expect(context).not.toHaveProperty('interactables')
    // What the recorded moment has is still said, and said once.
    const inputs = context.inputs as Array<Record<string, unknown>>
    const settings = context.settings as Array<Record<string, unknown>>
    expect(inputs.find((item) => item.name === 'in')).toMatchObject({
      value: { type: 'integer', text: '3' },
      text: '3',
    })
    expect(settings.find((item) => item.name === 'value')).toMatchObject({
      value: { type: 'integer', text: '0' },
      text: '0',
    })
    const text = JSON.stringify(context)
    expect(text).not.toContain('"in":7')
    expect(text).not.toContain('"value":3')
  })
})

describe('unavailable means no values anywhere in the question', () => {
  it('drops the live account’s numbers, recent frames, interactables and settling', async () => {
    const { trace } = adder(7, 5)
    const live = {
      ...part,
      about: 'Adds two four-bit numbers.',
      ports: [
        { name: 'a', label: 'A', dir: 'in', value: 7, text: '7', editable: true },
        { name: 'sum', label: 'Sum', dir: 'out', value: 12, text: '12' },
      ],
      state: [{ name: 'mode', value: 'binary', text: 'binary', control: { kind: 'select' } }],
      openable: false,
    } as unknown as PartSnapshot
    const snapshot = {
      ...shown(trace, 0),
      replay: { active: false, stage: 0, end: 0, paused: false },
      running: false,
      ticking: false,
    } as unknown as ChromeSnapshot
    const context = dossierContext(live, snapshot, [{ id: 'slider', value: 7 }])
    expect(JSON.stringify(context)).toContain('"12"')
    const grounded = await groundedContext(live, snapshot, context, async () => ({
      run: await trace.runRef(),
      observation: undefined,
      frame: undefined,
      unsettled: [],
    }))
    expect(grounded.observation).toBeNull()
    expect(grounded.settled).toBeNull()
    expect(grounded.facts).toEqual([])
    expect(grounded).not.toHaveProperty('interactables')
    expect(grounded.outputs).toEqual([{ name: 'sum', label: 'Sum' }])
    expect(grounded.inputs).toEqual([{ name: 'a', label: 'A', editable: true }])
    expect(grounded.cycle).toEqual({ shown: 0, latest: 0, lookingBack: false })
    const text = JSON.stringify(grounded)
    expect(text).not.toContain('12')
    expect(text).not.toContain('"value"')
    // What can be done there is still said.
    expect(grounded.actions).toContain('set a')
    expect(grounded.selected).toEqual({ id: 'add', label: 'Adder' })
  })
})

describe('showing the referenced moment is exact', () => {
  it('a same-run cycle no longer kept is said to be gone, never shown as the earliest kept', async () => {
    const { trace } = adder(7, 5)
    const asked = await trace.observation(0)
    const state = {
      available: true,
      running: false,
      messages: [{ id: 'q', role: 'user' as const, text: 'why?', status: 'complete' as const, subject: { kind: 'moment' as const, observation: asked! } }],
    }
    const snapshot = shown(trace, 0)
    const later = { ...snapshot, trace: { ...snapshot.trace, cycle: 5001, latest: 5001, first: 2 } }
    expect(referencedMoment(state, later)).toEqual({ observation: asked!, cycle: 0, status: 'evicted' })
  })

  it('the trace holds a reference only for its own run, a kept index and the same state', async () => {
    const { model, trace } = adder(7, 5)
    const at = (await trace.observation(0))!
    expect(await trace.holds(at)).toBe(true)
    expect(await trace.holds({ ...at, stateDigest: await digestOf('other') })).toBe(false)
    expect(await trace.holds({ ...at, domain: 'physical-time', time: '999999' })).toBe(false)
    expect(await trace.holds({ ...at, index: '7', time: '7' })).toBe(false)
    model.set('add', 'b', 9)
    trace.record({ kind: 'set', path: 'add', key: 'b', value: 9 }, model.settle())
    trace.rerun(0, 'add', 'b', 3)
    expect(await trace.holds(at)).toBe(false)
  })
})
