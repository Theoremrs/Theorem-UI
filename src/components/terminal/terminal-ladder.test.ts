// The ladder (terminal-ladder.ts) in all six themes: every role reads where it is drawn, the four surfaces
// ascend by a step you can tell apart, and the role palette under it (wasmPalette) is unchanged by it.
import { describe, expect, test } from 'bun:test'
import { converter, wcagContrast } from 'culori'
import { modeEditor, modeTokens, modes } from '../../../scripts/palettes'
import { workspaceOf } from './terminal-theme'
import { terminalRoles, wasmPalette } from './terminal-roles'
import { CALL, READ, ladderPalette, terminalLadder } from './terminal-ladder'

const oklch = converter('oklch')
const SIX = modes.slice(0, 6)

describe('the ladder', () => {
  for (const mode of SIX) {
    const roles = terminalRoles(
      workspaceOf((t) => modeTokens(mode)[t]!),
      modeEditor(mode),
    )
    const ladder = terminalLadder(roles)
    const { surfaces: s, text, registers, line } = ladder

    test(`${mode.selector}: the surfaces ascend by at least 0.03 of lightness`, () => {
      const l = [s.canvas, s.panel, s.raised, s.selected].map((c) => oklch(c)!.l)
      for (let i = 1; i < l.length; i++) expect(l[i]! - l[i - 1]!).toBeGreaterThan(0.03)
    })

    test(`${mode.selector}: text reads on every surface it is drawn on`, () => {
      const grounds = [s.canvas, s.panel, s.raised, s.selected]
      for (const g of grounds) {
        expect(wcagContrast(text.primary, g)).toBeGreaterThanOrEqual(4.5)
        expect(wcagContrast(text.body, g)).toBeGreaterThanOrEqual(4.5)
        expect(wcagContrast(text.secondary, g)).toBeGreaterThanOrEqual(4.5)
        expect(wcagContrast(text.disabled, g)).toBeGreaterThanOrEqual(3)
        for (const c of Object.values(registers)) expect(wcagContrast(c, g)).toBeGreaterThanOrEqual(4.5)
      }
      expect(wcagContrast(registers.success, s.diffAddition)).toBeGreaterThanOrEqual(4.5)
      expect(wcagContrast(registers.failure, s.diffDeletion)).toBeGreaterThanOrEqual(4.5)
    })

    test(`${mode.selector}: primary, body, the registers and lines are as bright as pi's on the lightest surface`, () => {
      expect(wcagContrast(text.primary, s.selected)).toBeGreaterThanOrEqual(READ.primary)
      expect(wcagContrast(text.body, s.selected)).toBeGreaterThanOrEqual(READ.body)
      expect(oklch(text.primary)!.l).toBeGreaterThan(oklch(text.body)!.l)
      for (const c of Object.values(registers)) expect(wcagContrast(c, s.selected)).toBeGreaterThanOrEqual(READ.register)
      expect(wcagContrast(line, s.selected)).toBeGreaterThanOrEqual(READ.line)
      const laddered = ladderPalette(roles) as Record<string, unknown>
      expect([laddered.ink, laddered.heading, laddered.line]).toEqual([text.body, text.primary, line])
      // Markdown headings are gold, as pi's are: the approval register, read as the registers are.
      expect(laddered.gold).toBe(registers.approval)
    })

    test(`${mode.selector}: a tool call's block turns the canvas to the brand mark's hue at pi's step and saturation, and every call's text reads on it`, () => {
      const call = oklch(s.call)!
      const mark = oklch(roles.chrome.mark)!
      // At the block's chroma (about 0.017) rounding to 8-bit sRGB moves the hue a few degrees.
      expect(Math.abs(call.h! - mark.h!)).toBeLessThan(6)
      expect(call.l - oklch(s.canvas)!.l).toBeCloseTo(CALL.step, 2)
      expect(call.c / call.l).toBeCloseTo(CALL.saturation, 2)
      expect(Math.abs(oklch(text.call)!.h! - mark.h!)).toBeLessThan(3)
      expect(wcagContrast(text.call, s.call)).toBeGreaterThanOrEqual(READ.call)
      expect(wcagContrast(text.primary, s.call)).toBeGreaterThanOrEqual(7)
      expect(wcagContrast(text.secondary, s.call)).toBeGreaterThanOrEqual(4.5)
      expect(wcagContrast(text.disabled, s.call)).toBeGreaterThanOrEqual(3)
      for (const c of Object.values(registers)) expect(wcagContrast(c, s.call)).toBeGreaterThanOrEqual(4.5)
    })

    test(`${mode.selector}: the diff rows and a call's block are the only tinted grounds, and a call's state is its text's colour`, () => {
      const grounds = [s.canvas, s.panel, s.raised, s.selected, s.diffAddition, s.diffDeletion, s.call]
      expect(new Set(grounds).size).toBe(grounds.length)
      const laddered = ladderPalette(roles) as Record<string, unknown>
      for (const key of ['completedRow', 'runningRow', 'pendingRow', 'failedRow']) expect(key in laddered).toBe(false)
      for (const c of [registers.approval, registers.failure]) expect(wcagContrast(c, s.canvas)).toBeGreaterThanOrEqual(4.5)
    })

    test(`${mode.selector}: secondary and disabled are two colours`, () => {
      expect(text.secondary).not.toBe(text.disabled)
    })

    test(`${mode.selector}: the ladder keeps the role palette's panel and raised surfaces`, () => {
      const before = wasmPalette(roles)
      const laddered = ladderPalette(roles) as Record<string, unknown>
      expect(laddered.bg).toBe(before.bg)
      expect(laddered.raised).toBe(before.raised)
      expect(laddered.canvas).toBe(s.canvas)
    })
  }

  test('the role palette alone carries none of the keys the ladder adds', () => {
    const roles = terminalRoles(workspaceOf((t) => modeTokens(SIX[0]!)[t]!))
    const before = wasmPalette(roles) as Record<string, unknown>
    for (const key of ['canvas', 'selectedRow', 'completedInk', 'info', 'textDisabled', 'diffAddedMark', 'diffRemovedMark', 'call', 'callInk'])
      expect(key in before).toBe(false)
  })
})
