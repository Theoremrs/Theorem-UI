import { describe, expect, it } from 'bun:test'
import { arrangeElk, arrangeStages } from './arrange'
import { buildNetwork } from './engine'
import type { Builder } from './engine'
import { gate, rippleAdder } from './parts'

const sizes = () => ({ x: 1.3, y: 0.9 })

// A small datapath given no places: two sources, two gates in series, a sink.
const datapath = (m: Builder) => {
  m.part(gate({ id: 'a', kind: 'and' }))
  m.part(gate({ id: 'b', kind: 'or' }))
  m.part(gate({ id: 'c', kind: 'xor' }))
  m.part(gate({ id: 'd', kind: 'not' }))
  m.part(gate({ id: 'e', kind: 'not' }))
  m.wire('a.out', 'c.a')
  m.wire('b.out', 'c.b')
  m.wire('c.out', 'd.a')
  m.wire('d.out', 'e.a')
}

describe('arranging a network with ELK', () => {
  it('puts every part that gives no place somewhere, with its inputs left of its outputs along each wire', async () => {
    const network = buildNetwork(datapath)
    const { positions, routes } = await arrangeElk(network, sizes)
    expect(positions.size).toBe(5)
    for (const wire of network.wires) {
      const from = positions.get(wire.from.part)!
      const to = positions.get(wire.to.part)!
      expect(from[0]).toBeLessThan(to[0])
      expect(routes.get(wire.id)!.length).toBeGreaterThanOrEqual(2)
    }
    // Centred on the origin and flat.
    expect(positions.get('a')![2]).toBe(0)
  })

  it('is the same arrangement every time', async () => {
    const network = buildNetwork(datapath)
    const first = await arrangeElk(network, sizes)
    const second = await arrangeElk(buildNetwork(datapath), sizes)
    expect([...second.positions]).toEqual([...first.positions])
    expect([...second.routes]).toEqual([...first.routes])
  })

  it("keeps a part's own `at` over the arrangement and arranges the rest", async () => {
    const network = buildNetwork((m) => {
      m.part(gate({ id: 'a', kind: 'and', at: [7, -3, 1] }))
      m.part(gate({ id: 'b', kind: 'not' }))
      m.part(gate({ id: 'c', kind: 'not' }))
      m.wire('a.out', 'b.a')
      m.wire('b.out', 'c.a')
    })
    const { positions } = await arrangeElk(network, sizes)
    expect(positions.get('a')).toEqual([7, -3, 1])
    expect(positions.get('b')![0]).toBeLessThan(positions.get('c')![0])
  })

  it('does nothing to a network whose parts all give a place', async () => {
    const network = buildNetwork((m) => {
      m.part(gate({ id: 'a', kind: 'and', at: [1, 2, 3] }))
      m.part(gate({ id: 'b', kind: 'not', at: [4, 5, 6] }))
      m.wire('a.out', 'b.a')
    })
    const { positions, routes } = await arrangeElk(network, sizes)
    expect([...positions]).toEqual([['a', [1, 2, 3]], ['b', [4, 5, 6]]])
    expect(routes.size).toBe(0)
  })

  it('arranges the inside of a part, leaving the wires to its own ports out', async () => {
    const network = buildNetwork((m) => {
      m.part(rippleAdder({ id: 'add', bits: 4 }))
    })
    const inside = network.parts[0]!.inside!
    const bare = { ...inside, parts: inside.parts.map((part) => ({ ...part, spec: { ...part.spec, at: undefined } })) }
    const { positions } = await arrangeElk(bare, sizes)
    expect(positions.size).toBe(inside.parts.length)
    for (const wire of inside.wires)
      if (!wire.from.boundary && !wire.to.boundary && wire.from.part !== wire.to.part)
        expect(positions.get(wire.from.part)![0]).toBeLessThanOrEqual(positions.get(wire.to.part)![0])
  })
})

describe('arranging by stage', () => {
  it('keeps a part\'s own `at` and puts the rest in columns by stage', () => {
    const network = buildNetwork((m) => {
      m.part(gate({ id: 'a', kind: 'and', at: [7, -3, 1] }))
      m.part(gate({ id: 'b', kind: 'not' }))
      m.part(gate({ id: 'c', kind: 'not' }))
    })
    const { positions } = arrangeStages(network, sizes, (part) => (part.spec.id === 'c' ? 1 : 0))
    expect(positions.get('a')).toEqual([7, -3, 1])
    expect(positions.get('b')![0]).toBeLessThan(positions.get('c')![0])
  })
})
