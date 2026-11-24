import { expect, test } from 'bun:test'
import { wcagContrast } from 'culori'
import { FALLBACK_ROLES } from './terminal-roles'
import type { TerminalRoles } from './terminal-roles'
import { ladderPalette } from './terminal-ladder'

// Exercise the final WASM palette, after the selected surface has been added.
// These two declared source fixtures vary surface hue; they are not claims
// about the built-in workspace palettes or a live browser capture.
const fixtures: TerminalRoles[] = [
  FALLBACK_ROLES,
  {
    ...FALLBACK_ROLES,
    revision: 'reading-test-warm',
    chrome: {
      ...FALLBACK_ROLES.chrome,
      bg: '#262421',
      raised: '#34312c',
      muted: '#a0a09c',
      accent: '#85a6a0',
      focus: '#85a6a0',
    },
  },
  {
    ...FALLBACK_ROLES,
    revision: 'reading-test-violet',
    chrome: {
      ...FALLBACK_ROLES.chrome,
      bg: '#211f32',
      raised: '#2f2a48',
    },
  },
]

test('resource links, retry text and metadata remain readable on selected rows', () => {
  for (const roles of fixtures) {
    const palette = ladderPalette(roles)
    for (const key of ['sage', 'accent', 'textDisabled'] as const) {
      for (const background of [
        palette.canvas,
        palette.bg,
        palette.selectedRow,
      ]) {
        expect(wcagContrast(palette[key], background)).toBeGreaterThanOrEqual(
          4.5,
        )
      }
    }
  }
})

test('elapsed time and line numbers are separate from truly inactive text', () => {
  const palette = ladderPalette(FALLBACK_ROLES)
  expect(
    wcagContrast(palette.textDisabled, palette.selectedRow),
  ).toBeGreaterThanOrEqual(4.5)
  expect(palette.textDisabled).not.toBe(palette.disabled)
  expect(
    wcagContrast(palette.muted, palette.selectedRow),
  ).toBeGreaterThanOrEqual(5)
  expect(wcagContrast(palette.muted, palette.selectedRow)).toBeGreaterThan(
    wcagContrast(palette.textDisabled, palette.selectedRow),
  )
})

test('the readability fix preserves the established fallback surfaces and inactive role', () => {
  const palette = ladderPalette(FALLBACK_ROLES)
  expect({
    bg: palette.bg,
    raised: palette.raised,
    canvas: palette.canvas,
    selectedRow: palette.selectedRow,
    disabled: palette.disabled,
  }).toEqual({
    bg: '#202733',
    raised: '#273042',
    canvas: '#121924',
    selectedRow: '#364052',
    disabled: '#8f98a0',
  })
})
