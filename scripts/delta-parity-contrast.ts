// SOURCING: culori (OKLCH, WCAG contrast) and the repo's own terminal-ladder.ts (the surface ladder) over scripts/palettes.ts, the spec every palette's tokens come from. The design-oracles skill's evaluate.py is policy-driven over rendered observations; this measures token pairs only, which is all this file claims.
//
//   bun scripts/delta-parity-contrast.ts
//
// Writes docs/plans/theo-workbench/evidence/delta-parity-contrast.json: for each of the six themes, the
// ladder against the colours the workbench drew before it, and every text role on every surface it can
// sit on with its WCAG 2 ratio.
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { converter, wcagContrast } from 'culori'
import { modeTokens, modes } from './palettes'
import { workspaceOf } from '../src/components/terminal/terminal-theme'
import { terminalRoles } from '../src/components/terminal/terminal-roles'
import {
  CANVAS_STEP,
  DIFF_ROW,
  READ,
  REGISTER_CHROMA,
  SELECTED_STEP,
  ladderPalette,
  terminalLadder,
} from '../src/components/terminal/terminal-ladder'

const oklch = converter('oklch')
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(
  ROOT,
  'docs/plans/theo-workbench/evidence/delta-parity-contrast.json',
)

const THEMES = [
  ['github-sharp-light', ':root'],
  ['github-sharp-dark', '.dark'],
  ['stone-light', "[data-palette='stone']"],
  ['stone-dark', ".dark[data-palette='stone']"],
  ['vitesse-light', "[data-palette='vitesse']"],
  ['vitesse-dark', ".dark[data-palette='vitesse']"],
] as const

const lightness = (colour: string) => oklch(colour)!.l

type Pair = {
  text: string
  surface: string
  textColour: string
  surfaceColour: string
  wcag: number
  needs: number
  /** Whether the pair is a surface the role is drawn on. */
  applicable: boolean
  pass: boolean
}

const failures: string[] = []
const themes: Record<string, unknown> = {}

for (const [name, selector] of THEMES) {
  const mode = modes.find((m) => m.selector === selector)!
  const roles = terminalRoles(workspaceOf((token) => modeTokens(mode)[token]!))
  const ladder = terminalLadder(roles)
  const laddered = ladderPalette(roles)
  const { surfaces } = ladder

  // The colours from before the ladder: the role palette alone.
  const before = {
    canvas: roles.chrome.bg,
    panel: roles.chrome.bg,
    raised: roles.chrome.raised,
    selected: roles.chrome.bg,
    primary: roles.chrome.bright,
    body: roles.chrome.text,
    secondary: roles.chrome.muted,
    disabled: roles.chrome.disabled,
  }

  const order = ['canvas', 'panel', 'raised', 'selected'] as const
  const steps = order.map((key, i) => ({
    surface: key,
    hex: surfaces[key],
    oklchL: Number(lightness(surfaces[key]).toFixed(4)),
    deltaToNext:
      i < order.length - 1
        ? Number(
            (
              lightness(surfaces[order[i + 1]!]) - lightness(surfaces[key])
            ).toFixed(4),
          )
        : null,
  }))
  const surfaceNames = {
    canvas: surfaces.canvas,
    panel: surfaces.panel,
    raised: surfaces.raised,
    selected: surfaces.selected,
    diffAddition: surfaces.diffAddition,
    diffDeletion: surfaces.diffDeletion,
    approvalRow: surfaces.approvalRow,
    failureRow: surfaces.failureRow,
  }
  // Where each text role is drawn: body and primary everywhere; secondary on the three ordinary grounds and on the
  // selected band; disabled on the grounds a time or a line number sits on, and on the band; registers and brand
  // on the grounds and the band; a diff mark on its own row; a waiting or failed tool call's glyph and name on its row.
  const roleSurfaces: Record<string, string[]> = {
    primary: ['canvas', 'panel', 'raised', 'selected', 'approvalRow', 'failureRow'],
    body: ['canvas', 'panel', 'raised', 'selected', 'diffAddition', 'diffDeletion'],
    secondary: ['canvas', 'panel', 'raised', 'selected'],
    disabled: ['canvas', 'panel', 'raised', 'selected'],
    brand: ['canvas', 'panel', 'raised', 'selected'],
    informational: ['canvas', 'panel', 'raised', 'selected'],
    success: ['canvas', 'panel', 'raised', 'selected', 'diffAddition'],
    approval: ['canvas', 'panel', 'raised', 'selected', 'approvalRow'],
    failure: ['canvas', 'panel', 'raised', 'selected', 'diffDeletion', 'failureRow'],
  }
  const textColours: Record<string, string> = {
    primary: ladder.text.primary,
    body: ladder.text.body,
    secondary: ladder.text.secondary,
    disabled: ladder.text.disabled,
    brand: ladder.brand,
    ...ladder.registers,
  }
  const needs = (role: string) =>
    role === 'disabled' ? 3 : role === 'primary' ? 4.5 : 4.5
  const pairs: Pair[] = []
  for (const [role, colour] of Object.entries(textColours))
    for (const surface of Object.keys(surfaceNames)) {
      const surfaceColour = surfaceNames[surface as keyof typeof surfaceNames]
      const wcag = wcagContrast(colour, surfaceColour)
      const applicable = roleSurfaces[role]!.includes(surface)
      const pass = wcag >= needs(role)
      if (applicable && !pass) failures.push(`${name}: ${role} on ${surface}: ${wcag.toFixed(2)}`)
      pairs.push({
        text: role,
        surface,
        textColour: colour,
        surfaceColour,
        wcag: Number(wcag.toFixed(2)),
        needs: needs(role),
        applicable,
        pass,
      })
    }
  // Secondary and disabled as they were before the ladder, on the surfaces of that time, for the comparison the critique makes.
  const beforePairs = (['secondary', 'disabled'] as const).flatMap((role) =>
    (['panel', 'raised'] as const).map((surface) => ({
      text: role,
      surface,
      textColour: before[role],
      surfaceColour: before[surface],
      wcag: Number(wcagContrast(before[role], before[surface]).toFixed(2)),
    })),
  )
  const gap = (a: string, b: string) =>
    Number((lightness(a) - lightness(b)).toFixed(4))
  themes[name] = {
    selector,
    surfaces: steps,
    decisionRows: {
      approval: surfaces.approvalRow,
      failure: surfaces.failureRow,
    },
    diffRows: {
      addition: surfaces.diffAddition,
      deletion: surfaces.diffDeletion,
      lightnessAbovePanel: {
        addition: gap(surfaces.diffAddition, surfaces.panel),
        deletion: gap(surfaces.diffDeletion, surfaces.panel),
      },
    },
    text: ladder.text,
    registers: ladder.registers,
    brand: ladder.brand,
    secondaryMinusDisabledLightness: gap(
      ladder.text.secondary,
      ladder.text.disabled,
    ),
    before: {
      secondary: before.secondary,
      disabled: before.disabled,
      secondaryMinusDisabledLightness: gap(before.secondary, before.disabled),
      pairs: beforePairs,
    },
    paletteOverrides: Object.fromEntries(
      Object.entries(laddered).filter(([key]) =>
        [
          'canvas',
          'selectedRow',
          'completedRow',
          'runningRow',
          'pendingRow',
          'failedRow',
          'completedInk',
          'info',
          'textDisabled',
          'diffAddedMark',
          'diffRemovedMark',
        ].includes(key),
      ),
    ),
    pairs,
  }
}

mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(
  OUT,
  JSON.stringify(
    {
      about:
        'Token-pair contrast of the Delta-parity ladder, derived by terminal-ladder.ts from each theme. WCAG 2 ratio. `applicable` marks the surfaces a role is drawn on; `pass` is the ratio against `needs` (4.5 for text, 3 for disabled). Token pairs only: not a rendered-accessibility claim.',
      rule: {
        canvasStepL: CANVAS_STEP,
        selectedStepL: SELECTED_STEP,
        readTargetsOnSelectedBand: READ,
        registerChroma: REGISTER_CHROMA,
        diffRow: DIFF_ROW,
      },
      themes,
      failures,
    },
    null,
    2,
  ) + '\n',
)
console.log(
  failures.length
    ? `FAILURES\n${failures.join('\n')}`
    : 'every applicable pair reads',
  `\nwrote ${OUT}`,
)
process.exit(failures.length ? 1 : 0)
