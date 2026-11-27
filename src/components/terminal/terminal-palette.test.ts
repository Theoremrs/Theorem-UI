// SOURCING: culori (a dependency) for OKLCH and WCAG contrast; lib/code-colours' GitHub Dark for the code colours. The test only reads the crate's colour constants.
//
// The terminal crate draws its code in fixed colours, and the rest in pi's
// slate until the page sets its palette (terminal-theme.ts works out every
// other one from the slate). These checks hold the slate to DESIGN.md's
// rules: text at 4.5:1 on the surface it is drawn on, and the diff tints set
// in OKLCH at GitHub Dark's diff hues.
import { readFileSync } from 'node:fs'
import { expect, test } from 'bun:test'
import { GITHUB_DARK } from '@/lib/code-colours'
import { converter, differenceCiede2000, wcagContrast } from 'culori'
import { SLATE } from './terminal-theme'
import { FALLBACK_ROLES, wasmPalette } from './terminal-roles'

const oklch = converter('oklch')
const deltaE = differenceCiede2000()

const source = readFileSync(
  new URL('../../../terminal/src/lib.rs', import.meta.url),
  'utf8',
)
const hex = (r?: string, g?: string, b?: string) =>
  `#${r}${g}${b}`.toLowerCase()
/** The crate's colours by name: its code constants, and its slate's fields in capitals. */
const colour: Record<string, string> = {}
for (const [, name, r, g, b] of source.matchAll(
  /const (\w+): Color = Color::Rgb\(0x(\w\w), 0x(\w\w), 0x(\w\w)\);/g,
))
  colour[name!] = hex(r, g, b)
const slateSource = /const SLATE: Palette = Palette \{([^}]*)\};/.exec(
  source,
)?.[1]
const slate: Record<string, string> = {}
for (const [, name, r, g, b] of (slateSource ?? '').matchAll(
  /(\w+): Color::Rgb\(0x(\w\w), 0x(\w\w), 0x(\w\w)\)/g,
)) {
  slate[name!.replace(/_(\w)/g, (_, c: string) => c.toUpperCase())] = hex(
    r,
    g,
    b,
  )
  colour[name!.toUpperCase()] = hex(r, g, b)
}

const CHROME = [
  'INK',
  'BRIGHT',
  'MUTED',
  'HEADING',
  'ACCENT',
  'ERROR',
  'WARNING',
  'SUCCESS',
  'LINK',
  'APPROVAL',
]
const SYNTAX = [
  'SYNTAX_KEYWORD',
  'SYNTAX_FUNCTION',
  'SYNTAX_NUMBER',
  'SYNTAX_STRING',
  'SYNTAX_VARIABLE',
  'SYNTAX_TYPE',
  'SYNTAX_TAG',
  'SYNTAX_COMMENT',
]
const CODE = [...SYNTAX, 'INK']

const below = (fgs: string[], bgs: string[]) =>
  bgs.flatMap((bg) =>
    fgs
      .map((fg) => ({ fg, bg, ratio: wcagContrast(colour[fg]!, colour[bg]!) }))
      .filter(({ ratio }) => ratio < 4.5),
  )

test("the crate's default palette is the slate terminal-theme.ts derives every other from", () => {
  const legacy = Object.fromEntries(
    Object.keys(SLATE).map((name) => [name, slate[name]]),
  )
  expect(legacy).toEqual(SLATE)
  // And every role is what terminal-roles.ts resolves on the slate itself.
  expect(slate).toEqual(wasmPalette(FALLBACK_ROLES))
})

test("code draws in GitHub Dark's token colours, which Stone dark's Monaco uses", () => {
  const byClass: Record<string, string> = {
    keyword: 'SYNTAX_KEYWORD',
    function: 'SYNTAX_FUNCTION',
    number: 'SYNTAX_NUMBER',
    string: 'SYNTAX_STRING',
    type: 'SYNTAX_TYPE',
    variable: 'SYNTAX_VARIABLE',
    tag: 'SYNTAX_TAG',
    link: 'LINK',
  }
  for (const [cls, name] of Object.entries(byClass))
    expect(colour[name]).toBe(GITHUB_DARK[cls as keyof typeof GITHUB_DARK])
  // The comment grey is GitHub Dark's, lifted in lightness only to read on
  // the raised slate.
  const comment = oklch(colour.SYNTAX_COMMENT)!
  const github = oklch(GITHUB_DARK.comment)!
  expect(comment.l).toBeGreaterThan(github.l)
  expect(Math.abs(comment.h! - github.h!)).toBeLessThan(3)
})

test('every text colour reads at 4.5:1 on each surface it is drawn on', () => {
  expect(below(CHROME, ['BG', 'RAISED'])).toEqual([])
  expect(below(CODE, ['BG', 'REMOVED_LINE', 'ADDED_LINE'])).toEqual([])
  const onWords = [
    ...CODE.filter((name) => name !== 'SYNTAX_COMMENT'),
    'COMMENT_ON_WORDS',
  ]
  expect(below(onWords, ['REMOVED_WORDS', 'ADDED_WORDS'])).toEqual([])
})

test("a diff's tints keep GitHub Dark's diff hues, with removed and added alike in lightness and chroma", () => {
  const at = (name: string) => {
    const parsed = oklch(colour[name])
    if (!parsed) throw new Error(`terminal/src/lib.rs has no colour ${name}`)
    return parsed
  }
  const hue = (value: string) => oklch(value)!.h!
  const apart = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180)
  for (const [side, github] of [
    ['REMOVED', '#da3633'],
    ['ADDED', '#238636'],
  ] as const) {
    const row = at(`${side}_LINE`)
    const words = at(`${side}_WORDS`)
    expect(apart(row.h!, hue(github))).toBeLessThan(2)
    expect(apart(words.h!, hue(github))).toBeLessThan(2)
    // Changed words are brighter than their row: lighter and more chromatic.
    expect(words.l).toBeGreaterThan(row.l)
    expect(words.c).toBeGreaterThan(row.c * 2)
  }
  for (const kind of ['LINE', 'WORDS']) {
    const removed = at(`REMOVED_${kind}`)
    const added = at(`ADDED_${kind}`)
    expect(Math.abs(removed.l - added.l)).toBeLessThan(0.003)
    expect(Math.abs(removed.c - added.c)).toBeLessThan(0.003)
  }
})

test('changed words stand apart from a row that stays quiet on the slate', () => {
  // ΔE00 on GitHub Dark, removed / added: a row against its background
  // 11.0 / 14.1, changed words against their row 19.0 / 14.6.
  for (const side of ['REMOVED', 'ADDED']) {
    const row = colour[`${side}_LINE`]!
    expect(deltaE(row, colour.BG!)).toBeLessThan(14.5)
    expect(deltaE(colour[`${side}_WORDS`]!, row)).toBeGreaterThan(15)
  }
})
