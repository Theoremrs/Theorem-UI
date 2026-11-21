import { describe, expect, test } from 'bun:test'
import { converter, wcagContrast } from 'culori'
import {
  PALETTES_CSS,
  palettesCss,
  modeTokens,
  modes as authoredModes,
} from './palettes'
import { REQUIRED_PALETTE_PAIRS } from './design-oracles/colors.mjs'

const oklch = converter('oklch')

/** A sorted window bounds the entire spread, independently of family order. */
function lightnessBand<T extends { l: number }>(drawn: T[]): T[] {
  const sorted = [...drawn].sort((a, b) => a.l - b.l)
  let best: T[] = []
  const spread = (colors: T[]) => colors.at(-1)!.l - colors[0]!.l
  for (let start = 0; start < sorted.length; start++) {
    const candidate = sorted
      .slice(start)
      .filter((color) => color.l - sorted[start]!.l < 0.02)
    if (
      candidate.length > best.length ||
      (candidate.length === best.length && spread(candidate) < spread(best))
    )
      best = candidate
  }
  return best
}

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

  test('a lightness band cannot hide a wide spread behind a central anchor', () => {
    const orders = [
      [0.5, 0.485, 0.515],
      [0.485, 0.5, 0.515],
      [0.515, 0.5, 0.485],
    ]
    const expected = lightnessBand(orders[0]!.map((l) => ({ l })))
    expect(expected).toHaveLength(2)
    for (const order of orders) {
      const band = lightnessBand(order.map((l) => ({ l })))
      expect(band).toEqual(expected)
      expect(band.at(-1)!.l - band[0]!.l).toBeLessThan(0.02)
    }
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
    (tier, names) => {
      for (const [selector, tokens] of Object.entries(modes)) {
        const drawn = names.map((name) => ({ name, ...oklch(tokens[name])! }))
        // Strong, container, and graph tiers have no repair exception.
        const colors = tier === 'ink' ? lightnessBand(drawn) : drawn
        expect(
          Math.max(...colors.map((color) => color.l)) -
            Math.min(...colors.map((color) => color.l)),
        ).toBeLessThan(0.02)
        // Even repaired inks retain the shared chroma within quantization.
        expect(
          Math.max(...drawn.map((color) => color.c)) -
            Math.min(...drawn.map((color) => color.c)),
        ).toBeLessThan(0.006)
        if (tier !== 'ink') continue
        expect(colors.length).toBeGreaterThanOrEqual(
          Math.ceil(names.length / 2),
        )

        const raw = modeTokens(
          authoredModes.find((mode) => mode.selector === selector)!,
        )
        const painted = (name: string): string => {
          const value = tokens[name]!
          const alias = value.match(/^var\(--([\w-]+)\)$/)
          return alias ? painted(alias[1]!) : value
        }
        for (const outlier of drawn.filter(
          (color) => !colors.includes(color),
        )) {
          // Only these inks are contrast-repaired. Prove that the original
          // color actually needed repair against an independently named edge.
          expect(['redwood-ink', 'action-ink', 'insight-ink']).toContain(
            outlier.name,
          )
          expect(tokens[outlier.name]).not.toBe(raw[outlier.name])
          const edges = REQUIRED_PALETTE_PAIRS.filter(
            (pair) => pair.foreground === outlier.name,
          )
          expect(edges.length).toBeGreaterThan(0)
          expect(
            edges.some(
              (pair) =>
                wcagContrast(raw[outlier.name]!, painted(pair.background)) <
                pair.threshold,
            ),
          ).toBe(true)
          expect(
            edges.every(
              (pair) =>
                wcagContrast(painted(outlier.name), painted(pair.background)) >=
                pair.threshold,
            ),
          ).toBe(true)
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
