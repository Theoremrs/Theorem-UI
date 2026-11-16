// The proposed ladder (terminal-ladder.ts) in all six themes: every role reads where it is drawn, the four surfaces
// ascend by a step you can tell apart, and a page that never asks for the proposal is sent what it always was.
import { describe, expect, test } from 'bun:test'
import { converter, wcagContrast } from 'culori'
import { modeTokens, modes } from '../../../scripts/palettes'
import { workspaceOf } from './terminal-theme'
import { terminalRoles, wasmPalette } from './terminal-roles'
import { proposedPalette, terminalLadder } from './terminal-ladder'

const oklch = converter('oklch')
const SIX = modes.slice(0, 6)

describe('the proposed ladder', () => {
  for (const mode of SIX) {
    const roles = terminalRoles(workspaceOf((t) => modeTokens(mode)[t]!))
    const ladder = terminalLadder(roles)
    const { surfaces: s, text, registers } = ladder

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

    test(`${mode.selector}: a waiting and a failed tool call sit on grounds of their own, and read there`, () => {
      const grounds = [s.canvas, s.panel, s.raised, s.selected, s.diffAddition, s.diffDeletion, s.approvalRow, s.failureRow]
      expect(new Set(grounds).size).toBe(grounds.length)
      expect(wcagContrast(text.primary, s.approvalRow)).toBeGreaterThanOrEqual(4.5)
      expect(wcagContrast(registers.approval, s.approvalRow)).toBeGreaterThanOrEqual(4.5)
      expect(wcagContrast(text.primary, s.failureRow)).toBeGreaterThanOrEqual(4.5)
      expect(wcagContrast(registers.failure, s.failureRow)).toBeGreaterThanOrEqual(4.5)
      const proposed = proposedPalette(roles)
      expect(proposed.pendingRow).toBe(s.approvalRow)
      expect(proposed.failedRow).toBe(s.failureRow)
      expect(proposed.runningRow).toBe(s.raised)
    })

    test(`${mode.selector}: secondary and disabled are two colours`, () => {
      expect(text.secondary).not.toBe(text.disabled)
    })

    test(`${mode.selector}: the proposal only adds to what the page sends today`, () => {
      const today = wasmPalette(roles)
      const proposed = proposedPalette(roles) as Record<string, unknown>
      expect(proposed.bg).toBe(today.bg)
      expect(proposed.raised).toBe(today.raised)
      expect(proposed.canvas).toBe(s.canvas)
    })
  }

  test('the palette a page that never asks for the proposal sends carries none of the new keys', () => {
    const roles = terminalRoles(workspaceOf((t) => modeTokens(SIX[0]!)[t]!))
    const today = wasmPalette(roles) as Record<string, unknown>
    for (const key of ['canvas', 'selectedRow', 'completedRow', 'runningRow', 'pendingRow', 'failedRow', 'completedInk', 'info', 'textDisabled', 'diffAddedMark', 'diffRemovedMark'])
      expect(key in today).toBe(false)
  })
})
