import { describe, expect, it } from 'bun:test'
import { plotted } from './timeline'
import type { TraceFrame } from './trace'

const frame: TraceFrame = {
  cycle: 0,
  cause: 'start',
  values: { alu: { carry: 1, result: 12 }, b: { out: 5 }, 'b/state': { value: 5 }, 'alu/add': { cout: 1 } },
}

describe('a plotted value', () => {
  it('is a port of the part when the part has one by that name', () => {
    expect(plotted('alu.carry', frame)).toEqual({ part: 'alu', port: 'carry' })
    expect(plotted('alu/add.cout', frame)).toEqual({ part: 'alu/add', port: 'cout' })
  })

  it('is a key of its state when the part has no such port', () => {
    expect(plotted('b.value', frame)).toEqual({ part: 'b/state', port: 'value' })
  })

  it('keeps a flattened name whole, and a name nothing recorded as it was written', () => {
    expect(plotted('acc.bits.0', frame)).toEqual({ part: 'acc', port: 'bits.0' })
    expect(plotted('lamp.on', undefined)).toEqual({ part: 'lamp', port: 'on' })
  })
})
