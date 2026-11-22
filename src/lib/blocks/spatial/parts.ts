// SOURCING: none: a starting library of parts written with the same public
// PartSpec an agent writes. Nothing in the renderer knows these by name; an
// agent may reuse, compose, ignore or replace every one of them.

import { bitAt, widthOf, wrap } from './bits'
import type { Builder, PartSpec, Vec3, Values } from './engine'
import type { Form } from './form'

type Spec = PartSpec<Form, unknown>
type Place = { id: string; at?: Vec3; label?: string; about?: string }

const bit = (value: unknown) => (Number(value) ? 1 : 0)

const GATES = {
  and: { fn: (a: number, b: number) => a & b, about: 'Outputs 1 only when both inputs are 1.' },
  or: { fn: (a: number, b: number) => a | b, about: 'Outputs 1 when either input is 1.' },
  xor: { fn: (a: number, b: number) => a ^ b, about: 'Outputs 1 when exactly one input is 1.' },
  nand: { fn: (a: number, b: number) => 1 - (a & b), about: 'Outputs 0 only when both inputs are 1.' },
  nor: { fn: (a: number, b: number) => 1 - (a | b), about: 'Outputs 1 only when both inputs are 0.' },
} as const

export type GateKind = keyof typeof GATES | 'not'

const truthTable = (fn: (a: number, b: number) => number) =>
  [0, 1].flatMap((a) =>
    [0, 1].map((b) => ({ inputs: { a, b }, expect: { out: fn(a, b) } })),
  )

/** A logic gate on bits (0 or 1). */
export function gate(place: Place & { kind: GateKind }): Spec {
  if (place.kind === 'not')
    return {
      label: 'NOT',
      about: 'Outputs the opposite of its input.',
      form: { shape: 'cylinder', radius: 0.32, height: 0.5, axis: 'z' },
      cells: 90,
      ...place,
      ports: { a: 'in', out: 'out' },
      compute: ({ a }) => ({ out: 1 - bit(a) }),
      checks: [
        { inputs: { a: 0 }, expect: { out: 1 } },
        { inputs: { a: 1 }, expect: { out: 0 } },
      ],
    }
  const { fn, about } = GATES[place.kind]
  return {
    label: place.kind.toUpperCase(),
    about,
    form: { shape: 'box', size: [0.8, 0.8, 0.5], radius: 0.18 },
    cells: 110,
    ...place,
    ports: { a: 'in', b: 'in', out: 'out' },
    compute: ({ a, b }) => ({ out: fn(bit(a), bit(b)) }),
    checks: truthTable(fn),
  }
}

/** Adds three bits; built from two XORs, two ANDs and an OR, which it opens into. */
export function fullAdder(place: Place): Spec {
  return {
    label: 'Full adder',
    about: 'Adds bits a, b and a carry in, giving a sum bit and a carry out.',
    form: { shape: 'box', size: [1.3, 1.3, 0.7], radius: 0.22 },
    cells: 260,
    ...place,
    ports: { a: 'in', b: 'in', cin: 'in', sum: 'out', cout: 'out' },
    inside(m) {
      m.part(gate({ id: 'x1', kind: 'xor', at: [-1.6, 0.9, 0] }))
      m.part(gate({ id: 'x2', kind: 'xor', at: [0.4, 1.2, 0] }))
      m.part(gate({ id: 'a1', kind: 'and', at: [-1.6, -0.9, 0] }))
      m.part(gate({ id: 'a2', kind: 'and', at: [0.4, -0.3, 0] }))
      m.part(gate({ id: 'o1', kind: 'or', at: [2, -0.9, 0] }))
      m.wire('.a', 'x1.a')
      m.wire('.b', 'x1.b')
      m.wire('x1.out', 'x2.a')
      m.wire('.cin', 'x2.b')
      m.wire('.a', 'a1.a')
      m.wire('.b', 'a1.b')
      m.wire('x1.out', 'a2.a')
      m.wire('.cin', 'a2.b')
      m.wire('a1.out', 'o1.a')
      m.wire('a2.out', 'o1.b')
      m.wire('x2.out', '.sum')
      m.wire('o1.out', '.cout')
    },
    checks: [0, 1].flatMap((a) =>
      [0, 1].flatMap((b) =>
        [0, 1].map((cin) => ({
          inputs: { a, b, cin },
          expect: { sum: (a + b + cin) & 1, cout: (a + b + cin) >> 1 },
        })),
      ),
    ),
  }
}

const bitNames = (prefix: string, bits: number) =>
  Array.from({ length: bits }, (_, index) => `${prefix}${index}`)

/** Fans an n-bit number out into its bits, least significant first. */
export function split(place: Place & { bits: number }): Spec {
  const bits = widthOf(place.bits, place.id)
  const outs = bitNames('b', bits)
  return {
    label: 'Split',
    about: `Separates a ${place.bits}-bit number into its bits, b0 the least significant.`,
    form: { shape: 'box', size: [0.4, 0.5 + place.bits * 0.42, 0.4], radius: 0.12 },
    cells: 60,
    ...place,
    ports: { in: 'in', ...Object.fromEntries(outs.map((name) => [name, 'out' as const])) },
    compute: ({ in: value }) =>
      Object.fromEntries(outs.map((name, index) => [name, bitAt(wrap(value, bits), index)])),
  }
}

/** Joins bits back into an n-bit number. */
export function join(place: Place & { bits: number }): Spec {
  const ins = bitNames('b', widthOf(place.bits, place.id))
  return {
    label: 'Join',
    about: `Gathers ${place.bits} bits into one number, b0 the least significant.`,
    form: { shape: 'box', size: [0.4, 0.5 + place.bits * 0.42, 0.4], radius: 0.12 },
    cells: 60,
    ...place,
    ports: { ...Object.fromEntries(ins.map((name) => [name, 'in' as const])), out: 'out' },
    compute: (inputs) => ({
      out: ins.reduce((sum, name, index) => sum + bit(inputs[name]) * 2 ** index, 0),
    }),
  }
}

/** Adds two n-bit numbers through a chain of full adders the carry ripples along. */
export function rippleAdder(place: Place & { bits: number }): Spec {
  const bits = widthOf(place.bits, place.id)
  const mask = 2 ** bits - 1
  return {
    label: `${bits}-bit adder`,
    about: `Adds two ${bits}-bit numbers. Each full adder waits for the carry from the one below it, so the carry ripples upward one stage at a time.`,
    form: { shape: 'box', size: [1.8, 1.6, 0.8], radius: 0.26 },
    cells: 420,
    ...place,
    ports: { a: 'in', b: 'in', cin: 'in', sum: 'out', cout: 'out' },
    defaults: { cin: 0 },
    inside(m: Builder<Form, unknown>) {
      const height = bits * 1.9
      m.part(split({ id: 'sa', bits, at: [-4, 0.8, 0] }))
      m.part(split({ id: 'sb', bits, at: [-4, -0.8, -1.2] }))
      m.part(join({ id: 'js', bits, at: [4, 0, 0] }))
      m.wire('.a', 'sa.in')
      m.wire('.b', 'sb.in')
      for (let index = 0; index < bits; index++) {
        m.part(fullAdder({ id: `fa${index}`, at: [0, index * 1.9 - height / 2 + 0.95, 0] }))
        m.wire(`sa.b${index}`, `fa${index}.a`)
        m.wire(`sb.b${index}`, `fa${index}.b`)
        m.wire(index === 0 ? '.cin' : `fa${index - 1}.cout`, `fa${index}.cin`, {
          label: index === 0 ? undefined : 'carry',
        })
        m.wire(`fa${index}.sum`, `js.b${index}`)
      }
      m.wire('js.out', '.sum')
      m.wire(`fa${bits - 1}.cout`, '.cout')
    },
    checks: [
      [3, 5, 0],
      [mask, 1, 0],
      [mask, mask, 1],
    ].map(([a, b, cin]) => ({
      inputs: { a, b, cin },
      expect: { sum: wrap(a! + b! + cin!, bits), cout: a! + b! + cin! > mask ? 1 : 0 },
    })),
  }
}

/** Chooses input a when sel is 0 and b when sel is 1. */
export function mux(place: Place): Spec {
  return {
    label: 'Mux',
    about: 'Passes input a through when sel is 0, and input b when sel is 1.',
    form: { shape: 'extrude', outline: [[-0.4, -0.75], [0.4, -0.45], [0.4, 0.45], [-0.4, 0.75]], depth: 0.45 },
    cells: 120,
    ...place,
    ports: { a: 'in', b: 'in', sel: 'in', out: 'out' },
    compute: ({ a, b, sel }) => ({ out: bit(sel) ? b : a }),
    checks: [
      { inputs: { a: 4, b: 9, sel: 0 }, expect: { out: 4 } },
      { inputs: { a: 4, b: 9, sel: 1 }, expect: { out: 9 } },
    ],
  }
}

/** Holds a number, taking its input on each clock step when load is 1. */
export function register(place: Place & { bits?: number; value?: number }): Spec {
  const bits = widthOf(place.bits ?? 8, place.id)
  return {
    label: 'Register',
    about: 'Holds a number. On each clock step it takes its input if load is 1, and otherwise keeps what it has.',
    form: { shape: 'box', size: [1.2, 0.7, 0.7], radius: 0.14 },
    cells: 160,
    ...place,
    ports: { in: 'in', load: 'in', out: 'out' },
    defaults: { load: 1 },
    state: { value: wrap(place.value ?? 0, bits) },
    compute: (_inputs: Values, state: Values) => ({ out: state.value }),
    tick: ({ in: input, load }: Values, state: Values) =>
      // Nothing wired to its input: it keeps what the person set.
      bit(load) && input !== undefined ? { value: wrap(input, bits) } : state,
  }
}
