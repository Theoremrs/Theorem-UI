// The ladder (terminal-ladder.ts) in all six themes: every role reads where it is drawn, the four surfaces
// ascend by a step you can tell apart, and the role palette under it (wasmPalette) is unchanged by it.
import { describe, expect, test } from 'bun:test'
import { converter, wcagContrast } from 'culori'
import { modeTokens, modes } from '../../../scripts/palettes'
import { workspaceOf } from './terminal-theme'
import { terminalRoles, wasmPalette } from './terminal-roles'
import { ladderPalette, terminalLadder } from './terminal-ladder'

const oklch = converter('oklch')
const SIX = modes.slice(0, 6)

describe('the ladder', () => {
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
      const laddered = ladderPalette(roles)
      expect(laddered.pendingRow).toBe(s.approvalRow)
      expect(laddered.failedRow).toBe(s.failureRow)
      expect(laddered.runningRow).toBe(s.raised)
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
    for (const key of ['canvas', 'selectedRow', 'completedRow', 'runningRow', 'pendingRow', 'failedRow', 'completedInk', 'info', 'textDisabled', 'diffAddedMark', 'diffRemovedMark'])
      expect(key in before).toBe(false)
  })
})
