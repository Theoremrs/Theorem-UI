// The processor an agent writes for "how does a small processor add?", shared
// by the spatial scenarios: its parts, how they are built into a model, and
// the App document that mounts it.
const app = (main) => `<!doctype html>
<meta name="theorem:uses" content='state("model")'>
<div id="root"></div>
<script type="text/theorem-source" data-path="main.ts">${main}</script>`
export { app }

// Registers it can set, an ALU it composed from the library's adder and parts
// of its own, an accumulator on the clock, and a carry lamp.

export const PARTS = `import { mount, parts, type Part, type Vec3 } from '@theorem/spatial'

const register = (id: string, label: string, at: Vec3, value: number): Part => ({
  id, label, at,
  about: 'Holds a 4-bit number you can set bit by bit.',
  form: { shape: 'box', size: [1.1, 0.8, 0.8], radius: 0.16 },
  ports: { out: 'out' },
  state: { value },
  controls: { value: { kind: 'bits', bits: 4 } },
  compute: (_inputs, state) => ({ out: state.value }),
})

const andBank: Part = {
  id: 'and', label: 'AND bank', at: [0, -1.6, 0],
  about: 'ANDs the two numbers bit by bit.',
  form: { shape: 'box', size: [1.4, 1, 0.6], radius: 0.14 },
  ports: { a: 'in', b: 'in', out: 'out' },
  compute: ({ a, b }) => ({ out: Number(a) & Number(b) }),
  checks: [{ inputs: { a: 12, b: 10 }, expect: { out: 8 } }],
}

const alu: Part = {
  id: 'alu', label: 'ALU', at: [0, 0, 0],
  about: 'Adds or ANDs two 4-bit values.',
  form: { shape: 'box', size: [2.2, 2, 1.1], radius: 0.3 },
  ports: { a: 'in', b: 'in', op: 'in', result: 'out', carry: 'out' },
  defaults: { op: 0 },
  controls: { op: { kind: 'toggle', label: 'operation', off: 'Add', on: 'AND' } },
  inside(m) {
    m.part(parts.rippleAdder({ id: 'add', bits: 4, at: [0, 1.4, 0] }))
    m.part(andBank)
    m.part(parts.mux({ id: 'pick', at: [2.8, 0, 0] }))
    m.wire('.a', 'add.a')
    m.wire('.b', 'add.b')
    m.wire('.a', 'and.a')
    m.wire('.b', 'and.b')
    m.wire('add.sum', 'pick.a')
    m.wire('and.out', 'pick.b')
    m.wire('.op', 'pick.sel')
    m.wire('pick.out', '.result')
    m.wire('add.cout', '.carry')
  },
}

const lamp: Part = {
  id: 'lamp', label: 'Carry', at: [3.2, -1.3, 0],
  about: 'Lights when the addition carries out of the top bit.',
  form: { shape: 'sphere', radius: 0.36 },
  ports: { on: 'in' },
}

`

export const MOUNT = `const model = mount(document.getElementById('root')!, (m) => {
  m.part(register('a', 'Register A', [-3.4, 1, 0], 7))
  m.part(register('b', 'Register B', [-3.4, -1, 0], 5))
  m.part(alu)
  m.part(parts.register({ id: 'acc', label: 'Accumulator', bits: 4, at: [3.2, 0.8, 0] }))
  m.part(lamp)
  m.wire('a.out', 'alu.a')
  m.wire('b.out', 'alu.b')
  m.wire('alu.result', 'acc.in')
  m.wire('alu.carry', 'lamp.on')
}, { title: 'A 4-bit processor', remember: 'model' })
Object.assign(window, { model })
`

export const PROCESSOR = PARTS + MOUNT

/** The same text with every part's `at` taken away: what an agent writes when it leaves the arrangement to the library. */
export const unplaced = (text) =>
  text.replace(/\bat: \[[^\]]*\]/g, 'at: undefined').replace('id, label, at,', 'id, label, at: undefined,')

/** The processor with no part given a place, mounted with the named arrangement. */
export const UNPLACED_PROCESSOR = (arrange) =>
  unplaced(PROCESSOR).replace("remember: 'model' }", `remember: 'model', arrange: '${arrange}' }`)
