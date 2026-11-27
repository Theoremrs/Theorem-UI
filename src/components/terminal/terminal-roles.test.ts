// The complete terminal role contract (SPEC-THEOREM-ARTIFACT-CABINET-1.0 §7;
// acceptance A22, A24, A25, A26 at the unit level): every role resolved from
// one workspace, every required pair reading at its unrounded threshold, no
// hue privileged, and an unreadable or invalid workspace repaired or replaced
// by the known valid profile with a diagnostic, never passed silently.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { wcagContrast } from 'culori'
import { modeEditor, modeTokens, modes } from '../../../scripts/palettes'
import { workspaceOf } from './terminal-theme'
import type { Workspace } from './terminal-theme'
import { GITHUB_DARK } from './terminal-editor'
import type { TerminalEditor } from './terminal-editor'
import {
  FALLBACK_ROLES,
  ILLUSTRATION_REFERENCE,
  TEXT_RATIO,
  failingPairs,
  projectIllustration,
  requiredPairs,
  terminalRoles,
  wasmPalette,
} from './terminal-roles'

type Mode = (typeof modes)[number]
const mode = (selector: string) => modes.find((m) => m.selector === selector)!
const workspace = (m: Mode) => workspaceOf((name) => modeTokens(m)[name]!)
/** Each built-in mode's dark editor; a person's own colours take GitHub Dark's. */
const EDITORS: Record<string, TerminalEditor> = {
  Vitesse: modeEditor(mode("[data-palette='vitesse']")),
  'Vitesse dark': modeEditor(mode(".dark[data-palette='vitesse']")),
}

const WORKSPACES: Record<string, Workspace> = {
  'GitHub Sharp': workspace(mode(':root')),
  'GitHub Sharp dark': workspace(mode('.dark')),
  Stone: workspace(mode("[data-palette='stone']")),
  'Stone dark': workspace(mode(".dark[data-palette='stone']")),
  Vitesse: workspace(mode("[data-palette='vitesse']")),
  'Vitesse dark': workspace(mode(".dark[data-palette='vitesse']")),
  forest: workspace({ ...mode('.dark'), hue: 146, saturation: 0.18 }),
  paper: workspace({ ...mode(':root'), hue: 80, saturation: 0.1 }),
}

describe('terminal roles', () => {
  for (const [name, w] of Object.entries(WORKSPACES)) {
    const roles = terminalRoles(w, EDITORS[name] ?? GITHUB_DARK)
    test(`${name}: every required pair reads, unrounded`, () => {
      expect(failingPairs(roles)).toEqual([])
      expect(roles.diagnostics.some((d) => d.startsWith('fallback'))).toBe(
        false,
      )
      for (const pair of requiredPairs(roles))
        expect(wcagContrast(pair.fg, pair.bg)).toBeGreaterThanOrEqual(
          pair.ratio,
        )
    })
    test(`${name}: the mark reads as text on both surfaces`, () => {
      const { mark, bg, raised } = roles.chrome
      expect(wcagContrast(mark, bg)).toBeGreaterThanOrEqual(TEXT_RATIO)
      expect(wcagContrast(mark, raised)).toBeGreaterThanOrEqual(TEXT_RATIO)
      expect(
        requiredPairs(roles).filter((p) => p.role === 'chrome.mark'),
      ).toHaveLength(2)
    })
    test(`${name}: headings are not a status hue`, () => {
      expect(roles.chrome.heading).toBe(roles.chrome.bright)
      expect(roles.chrome.heading).not.toBe(roles.state.warning)
      expect(roles.chrome.accent).not.toBe(roles.state.warning)
    })
  }

  test('status families stay distinct after projection', () => {
    for (const w of Object.values(WORKSPACES)) {
      const { error, warning, success, link } = terminalRoles(w).state
      expect(new Set([error, warning, success, link]).size).toBe(4)
    }
  })

  test('one revision per resolved palette; a theme change is a new revision', () => {
    const a = terminalRoles(WORKSPACES['GitHub Sharp']!)
    const b = terminalRoles(WORKSPACES['GitHub Sharp']!)
    const c = terminalRoles(WORKSPACES.forest!)
    expect(a.revision).toBe(b.revision)
    expect(a.revision).not.toBe(c.revision)
  })

  test('a workspace token that is not a colour takes the known valid profile, with a diagnostic', () => {
    const broken = { ...WORKSPACES['GitHub Sharp']!, ink: 'not-a-colour' }
    const roles = terminalRoles(broken)
    expect(roles.revision).toBe(FALLBACK_ROLES.revision)
    expect(roles.diagnostics[0]).toStartWith('fallback:')
  })

  test('a gamut-extreme, low-contrast custom workspace is repaired, and says what moved', () => {
    const neon = Object.fromEntries(
      Object.keys(WORKSPACES['GitHub Sharp']!).map((k) => [
        k,
        k.startsWith('ink')
          ? 'color(display-p3 0 1 0)'
          : 'oklch(0.62 0.37 330)',
      ]),
    ) as Workspace
    const roles = terminalRoles(neon)
    expect(failingPairs(roles)).toEqual([])
    for (const colour of Object.values(roles.chrome))
      expect(colour).toMatch(/^#[0-9a-f]{6}$/)
    // Either repaired in place or replaced by the fallback: never silent.
    expect(roles.diagnostics.length).toBeGreaterThan(0)
  })
})

describe('illustration palette', () => {
  test('P⁰ is the Rust preview palette, index for index', () => {
    const rust = readFileSync(
      new URL('../../../terminal/src/preview/palette.rs', import.meta.url),
      'utf8',
    )
    const block = rust.slice(rust.indexOf('pub const REFERENCE'))
    const colours = [...block.matchAll(/\[0x(..), 0x(..), 0x(..)\]/g)]
      .slice(0, 32)
      .map(([, r, g, b]) => `#${r}${g}${b}`.toLowerCase())
    expect(colours).toEqual([...ILLUSTRATION_REFERENCE])
  })

  test('a theme remaps colours, never the index count or order of lightness', () => {
    const roles = terminalRoles(WORKSPACES.forest!)
    expect(roles.illustration).toHaveLength(32)
    expect(roles.illustration[0]).toBe(roles.chrome.deep)
    // The neutral ramp keeps its order from the matte to paper.
    const ramp = roles.illustration
      .slice(0, 8)
      .map((c) => wcagContrast(c, '#000000'))
    for (let i = 1; i < ramp.length; i++)
      expect(ramp[i]!).toBeGreaterThan(ramp[i - 1]!)
  })

  test('projection on the reference black is the identity', () => {
    expect(projectIllustration(ILLUSTRATION_REFERENCE[0])).toEqual([
      ...ILLUSTRATION_REFERENCE,
    ])
  })
})

describe('the terminal palette the WASM reads', () => {
  test('legacy keys come through the one compatibility map', () => {
    const roles = terminalRoles(WORKSPACES['Stone dark']!)
    const palette = wasmPalette(roles)
    expect(palette.gold).toBe(roles.state.warning)
    expect(palette.sage).toBe(roles.chrome.accent)
    expect(palette.heading).toBe(roles.chrome.heading)
    expect(palette.mark).toBe(roles.chrome.mark)
    // Every key the Rust Palette declares is sent.
    const rust = readFileSync(
      new URL('../../../terminal/src/lib.rs', import.meta.url),
      'utf8',
    )
    const struct = rust.slice(
      rust.indexOf('struct Palette {'),
      rust.indexOf('}', rust.indexOf('struct Palette {')),
    )
    const fields = [...struct.matchAll(/^\s+(\w+): Color,/gm)].map(([, f]) =>
      f!.replace(/_(\w)/g, (_, c: string) => c.toUpperCase()),
    )
    expect(Object.keys(palette).sort()).toEqual(fields.sort())
  })
})
