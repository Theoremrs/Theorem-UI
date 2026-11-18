// The acceptance cases of docs/plans/durable-artifacts: a question's numbers
// come from the recorded moment it names, and the four-bit adder they are
// read from agrees with integer arithmetic everywhere.
import { describe, expect, it } from 'bun:test'
import { signalText } from '@theorem/runtime'
import type { ChromeSnapshot, Grounding, PartSnapshot } from './chrome'
import { groundedContext, observedFacts, referencedMoment } from './dossier'
import { buildNetwork, ModelState } from './engine'
import { rippleAdder } from './parts'
import { CycleTrace } from './trace'

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
      runId: trace.recordingId,
      ground: async (): Promise<Grounding> => ({
        run: await trace.runRef(),
        observation: await trace.observation(cycle),
        unsettled: trace.unsettled(cycle) ?? [],
      }),
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
          observation: asked,
        },
      ],
    }
    expect(referencedMoment(state, shown(trace, 1))).toEqual({
      cycle: 0,
      runId: 'adder:0',
      current: true,
    })
    expect(referencedMoment(state, shown(trace, 0, true))).toBeUndefined()
    trace.rerun(0, 'add', 'b', 3)
    expect(referencedMoment(state, shown(trace, 1))).toMatchObject({
      cycle: 0,
      current: false,
    })
  })
})
