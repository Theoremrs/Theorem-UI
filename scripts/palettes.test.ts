import { describe, expect, test } from 'bun:test'
import { converter, wcagContrast } from 'culori'
import { PALETTES_CSS, palettesCss } from './palettes'

const oklch = converter('oklch')

/** Each mode's block of the stylesheet, as token name to value. */
function blocks(css: string): Record<string, Record<string, string>> {
  return Object.fromEntries(
    [...css.matchAll(/^([^\n{]+) \{\n([\s\S]*?)\n\}/gm)].map((match) => [
      match[1],
      Object.fromEntries(
        [...match[2]!.matchAll(/--([\w-]+): ([^;]+);/g)].map((token) => [
          token[1],
          token[2],
        ]),
      ),
    ]),
  )
}

const css = await Bun.file(PALETTES_CSS).text()
/** The palette modes' own blocks: not the Calm fallbacks (whose selectors
 *  carry :where) nor the custom palette's var() passthroughs. */
const modes = Object.fromEntries(
  Object.entries(blocks(css)).filter(
    ([selector, tokens]) =>
      !selector.includes(':where') &&
      !selector.includes('custom') &&
      Object.values(tokens).every((value) => /^#|var\(--/.test(value)),
  ),
)

describe('palettes', () => {
  test('the stylesheet is what the rules make', () => {
    expect(css).toBe(palettesCss())
  })

  test('every mode sets every colour itself, so none falls back to another', () => {
    const names = Object.values(modes).map((tokens) =>
      Object.keys(tokens).sort(),
    )
    expect(names).toHaveLength(8)
    for (const set of names) expect(set).toEqual(names[0]!)
  })

  test.each([
    ['strong', ['redwood', 'teal', 'ochre']],
    [
      'ink',
      [
        'redwood-ink',
        'teal-ink',
        'ochre-ink',
        'error-ink',
        'action-ink',
        'insight-ink',
      ],
    ],
    [
      'container',
      [
        'redwood-container',
        'teal-container',
        'ochre-container',
        'error-container',
        'action-container',
        'insight-container',
      ],
    ],
    ['graph', ['graph-plan', 'graph-agent', 'graph-tag', 'graph-attachment']],
  ])(
    'the %s tier is one lightness and one chroma across its families',
    (_, names) => {
      for (const tokens of Object.values(modes)) {
        // An ink the contrast repair moved (Stone's link and response
        // accents) keeps its hue and chroma but takes the lightness its
        // surfaces need; the tier's lightness is the one its largest group
        // of inks still holds.
        const drawn = names.map((name) => oklch(tokens[name])!)
        let colors: typeof drawn = []
        for (const anchor of drawn) {
          const near = drawn.filter(
            (color) => Math.abs(color.l - anchor.l) < 0.02,
          )
          if (near.length > colors.length) colors = near
        }
        expect(colors.length).toBeGreaterThanOrEqual(
          Math.ceil(names.length / 2),
        )
        for (const color of colors) {
          // Within what 8-bit hex can hold, and the 0.02 band the group
          // was gathered at.
          expect(Math.abs(color.l - colors[0]!.l)).toBeLessThan(0.02)
          expect(Math.abs(color.c - colors[0]!.c)).toBeLessThan(0.006)
        }
      }
    },
  )

  test('text and the focus ring keep their contrast', () => {
    for (const tokens of Object.values(modes)) {
      const ratio = (fore: string, back: string) =>
        wcagContrast(tokens[fore]!, tokens[back]!)
      for (const back of ['sheet-from', 'sheet-to', 'surface-raised'])
        expect(ratio('ink', back)).toBeGreaterThan(4.5)
      expect(ratio('ink-muted', 'sheet-from')).toBeGreaterThan(4.5)
      expect(ratio('on-redwood', 'redwood')).toBeGreaterThan(4.5)
      for (const family of [
        'redwood',
        'teal',
        'ochre',
        'error',
        'action',
        'insight',
      ])
        expect(ratio(`${family}-ink`, `${family}-container`)).toBeGreaterThan(
          4.5,
        )
      expect(ratio('focus', 'surface-sidebar')).toBeGreaterThan(3)
    }
  })
})
