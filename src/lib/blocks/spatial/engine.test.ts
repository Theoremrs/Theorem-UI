import { describe, expect, it } from 'bun:test'
import { buildNetwork, ModelState  } from './engine'
import type {Builder} from './engine';
import { fullAdder, gate, register, rippleAdder } from './parts'
import { flatten } from './trace'

const model = (describe: (m: Builder) => void) => new ModelState(buildNetwork(describe))

describe('a spatial model', () => {
  it('adds through a ripple adder opened into full adders and gates', () => {
    const state = model((m) => {
      m.part(rippleAdder({ id: 'add', bits: 4 }))
    })
    state.set('add', 'a', 7)
    state.set('add', 'b', 9)
    const settled = state.settle()
    expect(settled.readings.get('add')?.outputs).toEqual({ sum: 0, cout: 1 })
    // Every inner part at every depth has its own reading.
    expect(settled.readings.get('add/fa3')?.outputs).toEqual({ sum: 0, cout: 1 })
    expect(settled.readings.get('add/fa0/x1')?.inputs).toEqual({ a: 1, b: 1 })
  })

  it('orders a network into stages, so the carry is seen travelling', () => {
    const state = model((m) => {
      m.part(rippleAdder({ id: 'add', bits: 4 }))
    })
    const settled = state.settle()
    const stage = (path: string) => settled.readings.get(path)?.stage
    expect(stage('add/sa')).toBe(0)
    expect(stage('add/fa0')).toBe(1)
    expect(stage('add/fa1')).toBe(2)
    expect(stage('add/fa3')).toBe(4)
    expect(stage('add/js')).toBe(5)
    expect(stage('add/fa0/x2')).toBeGreaterThan(stage('add/fa0/x1')!)
  })

  it('propagates a change to an unwired input through the wires', () => {
    const state = model((m) => {
      m.part(gate({ id: 'g1', kind: 'and' }))
      m.part(gate({ id: 'g2', kind: 'not' }))
      m.wire('g1.out', 'g2.a')
    })
    expect(state.settle().readings.get('g2')?.outputs).toEqual({ out: 1 })
    state.set('g1', 'a', 1)
    state.set('g1', 'b', 1)
    expect(state.isPin('g2', 'a')).toBe(false)
    expect(state.settle().readings.get('g2')?.outputs).toEqual({ out: 0 })
  })

  it('steps a clocked part from what the last settle saw', () => {
    const state = model((m) => {
      m.part(register({ id: 'pc', bits: 4 }))
      m.part(rippleAdder({ id: 'inc', bits: 4 }))
      m.wire('pc.out', 'inc.a')
      m.wire('inc.sum', 'pc.in')
    })
    state.set('inc', 'b', 1)
    let settled = state.settle()
    for (let count = 0; count < 17; count++) settled = state.step(settled)
    expect(state.states.get('pc')).toEqual({ value: 1 })
    expect(settled.readings.get('inc')?.outputs).toEqual({ sum: 2, cout: 0 })
  })

  it('holds and adds 32-bit numbers, and refuses a width it cannot hold', () => {
    const state = model((m) => {
      m.part(register({ id: 'r', bits: 32, value: 42 }))
      m.part(rippleAdder({ id: 'add', bits: 32 }))
      m.wire('r.out', 'add.a')
      m.wire('add.sum', 'r.in')
    })
    expect(state.states.get('r')).toEqual({ value: 42 })
    state.set('add', 'b', 2 ** 31)
    let settled = state.settle()
    expect(settled.readings.get('add')?.outputs).toEqual({ sum: 2 ** 31 + 42, cout: 0 })
    settled = state.step(settled)
    expect(state.states.get('r')).toEqual({ value: 2 ** 31 + 42 })
    // The next sum passes 32 bits: the register takes it wrapped.
    settled = state.step(settled)
    expect(state.states.get('r')).toEqual({ value: 42 })
    expect(settled.readings.get('add')?.outputs).toEqual({ sum: 2 ** 31 + 42, cout: 0 })
    expect(state.check()).toEqual([])
    expect(() => register({ id: 'wide', bits: 64 })).toThrow('wide: bits must be a whole number from 1 to 53, not 64')
  })

  it('settles a loop with no clock in it', () => {
    // A latch from two NOR gates holds what it was last set to.
    const state = model((m) => {
      m.part(gate({ id: 'n1', kind: 'nor' }))
      m.part(gate({ id: 'n2', kind: 'nor' }))
      m.wire('n1.out', 'n2.a')
      m.wire('n2.out', 'n1.b')
    })
    state.set('n1', 'a', 1)
    let settled = state.settle()
    expect(settled.readings.get('n1')?.outputs).toEqual({ out: 0 })
    expect(settled.readings.get('n2')?.outputs).toEqual({ out: 1 })
    // Released, it keeps what it was set to.
    state.set('n1', 'a', 0)
    settled = state.settle()
    expect(settled.readings.get('n1')?.outputs).toEqual({ out: 0 })
    expect(settled.readings.get('n2')?.outputs).toEqual({ out: 1 })
    // Reset from the other side, and released again, it holds the other value.
    state.set('n2', 'b', 1)
    state.settle()
    state.set('n2', 'b', 0)
    settled = state.settle()
    expect(settled.readings.get('n1')?.outputs).toEqual({ out: 1 })
    expect(settled.readings.get('n2')?.outputs).toEqual({ out: 0 })
  })

  it('keeps what a latch holds across a reload of the model', () => {
    const build = () =>
      model((m) => {
        m.part(gate({ id: 'n1', kind: 'nor' }))
        m.part(gate({ id: 'n2', kind: 'nor' }))
        m.wire('n1.out', 'n2.a')
        m.wire('n2.out', 'n1.b')
      })
    const before = build()
    before.set('n1', 'a', 1)
    before.settle()
    before.set('n1', 'a', 0)
    before.settle()
    const after = build()
    after.restore(before.snapshot())
    expect(after.settle().readings.get('n2')?.outputs).toEqual({ out: 1 })
  })

  it("runs every part's checks and says what failed", () => {
    const state = model((m) => {
      m.part(fullAdder({ id: 'fa' }))
      m.part({
        id: 'wrong',
        ports: { a: 'in', out: 'out' },
        compute: ({ a }) => ({ out: a }),
        checks: [{ name: 'doubles', inputs: { a: 2 }, expect: { out: 4 } }],
      })
    })
    expect(state.check()).toEqual(['wrong: doubles: out is 2, expected 4'])
  })

  it('keeps what the person changed across a revision that adds a part', () => {
    const before = model((m) => {
      m.part(register({ id: 'r', bits: 8 }))
      m.part(gate({ id: 'g', kind: 'and' }))
    })
    before.set('g', 'a', 1)
    before.states.set('r', { value: 42 })
    const snapshot = JSON.parse(JSON.stringify(before.snapshot()))
    const after = model((m) => {
      m.part(register({ id: 'r', bits: 8 }))
      m.part(gate({ id: 'g', kind: 'and' }))
      m.part(gate({ id: 'new', kind: 'or' }))
      m.wire('g.out', 'new.a')
    })
    after.restore(snapshot)
    expect(after.value('g', 'a')).toBe(1)
    expect(after.states.get('r')).toEqual({ value: 42 })
  })

  it('names what is wrong with a description', () => {
    expect(() => buildNetwork((m) => void m.part({ id: 'a b' }))).toThrow(/needs an id/)
    expect(() =>
      buildNetwork((m) => {
        m.part(gate({ id: 'g', kind: 'and' }))
        m.wire('g.out', 'g.c')
      }),
    ).toThrow(/g has no port "c" \(it has a, b, out\)/)
    expect(() =>
      buildNetwork((m) => {
        m.part(gate({ id: 'g', kind: 'and' }))
        m.part(gate({ id: 'h', kind: 'and' }))
        m.wire('g.a', 'h.a')
      }),
    ).toThrow(/wires run from outputs to inputs/)
    expect(() =>
      buildNetwork((m) => {
        m.part(gate({ id: 'g', kind: 'and' }))
        m.part(gate({ id: 'h', kind: 'and' }))
        m.wire('g.out', 'h.a')
        m.wire('h.out', 'h.a')
      }),
    ).toThrow(/an input takes one/)
    expect(() =>
      buildNetwork((m) => {
        m.part({
          id: 'p',
          ports: { a: 'in' },
          inside: (inner) => inner.wire('.a', '.a'),
        })
      }),
    ).toThrow(/Inside p, ".a" is an input/)
  })

  it('describes a part in words', () => {
    const state = model((m) => {
      m.part(fullAdder({ id: 'fa' }))
    })
    state.set('fa', 'a', 1)
    const text = state.describe('fa', state.settle())
    expect(text).toContain('Full adder (fa)')
    expect(text).toContain('outputs: sum=1 cout=0')
    expect(text).toContain('contains: XOR, XOR, AND, AND, OR')
  })
})

describe('a settle that never comes to rest', () => {
  it('names the parts still changing rather than presenting them as settled', () => {
    // An inverter fed from its own output oscillates forever.
    const state = new ModelState(
      buildNetwork((m) => {
        m.part({ id: 'not', ports: { a: 'in', out: 'out' }, compute: ({ a }) => ({ out: a ? 0 : 1 }) })
        m.wire('not.out', 'not.a')
      }),
    )
    expect(state.settle().unsettled).toEqual(['not'])
  })

  it('a nested loop that oscillated in an early pass but rests at the end is not reported', () => {
    // The inner inverter oscillates only while enabled. In the first outer
    // pass its enable is not yet driven (so it runs); the driver then turns
    // it off and the final pass rests.
    const state = new ModelState(
      buildNetwork((m) => {
        m.part({
          id: 'c',
          ports: { en: 'in', out: 'out' },
          inside: (inner) => {
            inner.part({
              id: 'not',
              ports: { a: 'in', en: 'in', out: 'out' },
              compute: ({ a, en }) => ({ out: en === 0 ? 0 : a ? 0 : 1 }),
            })
            inner.wire('.en', 'not.en')
            inner.wire('not.out', 'not.a')
            inner.wire('not.out', '.out')
          },
        })
        m.part({ id: 'driver', ports: { d: 'in', en: 'out' }, compute: () => ({ en: 0 }) })
        m.wire('driver.en', 'c.en')
        m.wire('c.out', 'driver.d')
      }),
    )
    expect(state.settle().unsettled).toEqual([])
  })

  it('a nested loop still oscillating at the end is reported by its inner path', () => {
    const state = new ModelState(
      buildNetwork((m) => {
        m.part({
          id: 'c',
          ports: { en: 'in', out: 'out' },
          inside: (inner) => {
            inner.part({ id: 'not', ports: { a: 'in', out: 'out' }, compute: ({ a }) => ({ out: a ? 0 : 1 }) })
            inner.wire('not.out', 'not.a')
            inner.wire('not.out', '.out')
          },
        })
      }),
    )
    expect(state.settle().unsettled).toContain('c/not')
  })

  it('a network without a loop comes to rest', () => {
    const state = new ModelState(buildNetwork((m) => m.part(rippleAdder({ id: 'add', bits: 4 }))))
    expect(state.settle().unsettled).toEqual([])
  })
})

describe('wide integers', () => {
  it('a part returning a 64-bit bigint settles, compares and is traced exactly', () => {
    const state = new ModelState(
      buildNetwork((m) => {
        m.part({ id: 'wide', ports: { a: 'in', out: 'out' }, compute: () => ({ out: 18446744073709551615n }) })
      }),
    )
    const settled = state.settle()
    expect(settled.readings.get('wide')!.outputs.out).toBe(18446744073709551615n)
    expect(state.describe('wide', settled)).toContain('out=18446744073709551615')
    const into: Record<string, string | number> = {}
    flatten('out', 18446744073709551615n, into)
    expect(into.out).toBe('18446744073709551615')
  })
})
