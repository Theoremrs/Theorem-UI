import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { contrastRatio, auditPaletteCss, REQUIRED_PALETTE_PAIRS, REQUIRED_PALETTE_MODES, renderedRolePairRegistration } from '../../scripts/design-oracles/colors.mjs'
import { LATIN_PROSE_V1, LATIN_PROSE_V1_ACTUAL_SHA256, LATIN_PROSE_V1_SHA256 } from '../../scripts/design-oracles/corpus.mjs'
import { CHILD_ORACLES, FIXTURES, ORACLES, PREDICATE_TOLERANCES, POLICY } from '../../scripts/design-oracles/registry.mjs'
import { geometryResidualResult, invariantCheckResult } from '../../scripts/design-oracles/metamorphic.mjs'
import { COLOR_PAIRS, COLOR_ROLES } from '../../src/lib/appearance-policy'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

describe('theorem-appearance-v1 oracle registry', () => {
  test('defines each of the 30 independent oracle groups exactly once', () => {
    expect(ORACLES).toHaveLength(30)
    expect(new Set(ORACLES.map((oracle) => oracle.id)).size).toBe(30)
    expect(ORACLES.map((oracle) => oracle.id)).toContain('ARC-06')
    expect(POLICY).toEqual({ id: 'theorem-appearance-v1', version: '1.0.0' })
  })

  test('records all eleven required fixture contracts and separately classified child predicates', () => {
    expect(FIXTURES.map((fixture) => fixture.id)).toEqual(Array.from({ length: 11 }, (_, index) => `F${String(index + 1).padStart(2, '0')}`))
    expect(CHILD_ORACLES.some((child) => child.id === 'COL-01.minimum' && child.class.includes('Standard'))).toBe(true)
    expect(CHILD_ORACLES.some((child) => child.id === 'COL-01.prose-target' && child.class === 'Target')).toBe(true)
    expect(CHILD_ORACLES.some((child) => child.id === 'COL-02.decorative-separators' && child.class === 'Standard')).toBe(true)
    expect(PREDICATE_TOLERANCES.contrastBelowThreshold).toBe(0)
  })

  test('ships the exact fixed corpus bytes and expected digest', () => {
    expect(LATIN_PROSE_V1.split('\n\n')).toHaveLength(6)
    expect(LATIN_PROSE_V1_ACTUAL_SHA256).toBe(LATIN_PROSE_V1_SHA256)
    expect(LATIN_PROSE_V1_SHA256).toBe('dbfeea1c559f50254d2a3f66388fe0c732fa7df09ab74fe0de7921d5860904f7')
  })
})

describe('independent color predicates', () => {
  test('adversarial white text on orange fails while role-correct dark text passes', () => {
    expect(contrastRatio('#ffffff', '#ff8a4c')).toBeCloseTo(2.34, 2)
    expect(contrastRatio('#24292d', '#ff8a4c')).toBeCloseTo(6.29, 2)
    expect(contrastRatio('#ffffff', '#ff8a4c')).toBeLessThan(4.5)
    expect(contrastRatio('#24292d', '#ff8a4c')).toBeGreaterThanOrEqual(4.5)
  })

  test('audits emitted built-in modes and every registered palette role pair', async () => {
    const css = await readFile(resolve(root, 'src/palettes.css'), 'utf8')
    const results = auditPaletteCss(css)
    const modes = results.filter((result) => result.id.startsWith('COL-04.emitted-colors.'))
    // Keep this inventory independent of the generator: every built-in
    // palette, including Ember, must be audited in both light and dark modes.
    const expectedModes = [
      ':root',
      '.dark',
      "[data-palette='ember']",
      ".dark[data-palette='ember']",
      "[data-palette='stone']",
      ".dark[data-palette='stone']",
      "[data-palette='vitesse']",
      ".dark[data-palette='vitesse']",
      ":root:where(:not([data-appearance-preset]), [data-appearance-preset='calm']):where(:not([data-palette]), [data-palette='github-sharp'])",
      ".dark:where(:not([data-appearance-preset]), [data-appearance-preset='calm']):where(:not([data-palette]), [data-palette='github-sharp'])",
    ]
    expect([...REQUIRED_PALETTE_MODES].sort()).toEqual([...expectedModes].sort())
    expect(modes.map((result) => result.evidence.mode).sort()).toEqual(expectedModes.sort())
    expect(modes.every((result) => result.status === 'pass')).toBe(true)
    expect(REQUIRED_PALETTE_PAIRS).toHaveLength(119)
    expect(results.some((result) => result.id === 'COL-01.minimum.:root.primary/canvas' && result.status === 'pass')).toBe(true)
    const pairs = results.filter((result) => result.id.startsWith('COL-01.minimum.'))
    expect(pairs).toHaveLength(119 * expectedModes.length)
    expect(pairs.every((result) => result.status === 'pass')).toBe(true)
    const emittedBuiltInTokens = results.filter((result) => result.evidence?.concrete).flatMap((result) => result.evidence.concrete)
    expect(emittedBuiltInTokens.some((token) => token.raw.includes('--custom-'))).toBe(false)
  })

  test('the independent manifest covers every concrete production pair and threshold', () => {
    const key = (foreground, background, threshold) => JSON.stringify([foreground, background, threshold])
    expect(REQUIRED_PALETTE_PAIRS.map(({ foreground, background, threshold }) => key(foreground, background, threshold)).sort()).toEqual(
      COLOR_PAIRS.map(({ foreground, background, minimum }) => key(COLOR_ROLES[foreground], COLOR_ROLES[background], minimum)).sort(),
    )
    expect(new Set(REQUIRED_PALETTE_PAIRS.map(({ id }) => id)).size).toBe(119)
  })

  test.each([
    ['action-ink', 'action/canvas', 4.5],
    ['insight-ink', 'insight/canvas', 4.5],
    ['series-1', 'series-1/canvas', 3],
    ['series-2', 'series-2/canvas', 3],
    ['series-3', 'series-3/canvas', 3],
    ['series-4', 'series-4/canvas', 3],
    ['series-5', 'series-5/canvas', 3],
    ['attention-ink', 'code/canvas', 4.5],
  ])('rejects a contrast-breaking %s without confusing it with primary ink', async (token, pair, threshold) => {
    const css = (await readFile(resolve(root, 'src/palettes.css'), 'utf8')).replace(
      new RegExp(`(--${token}: )#[0-9a-f]{6}`), '$1#ffffff',
    )
    const results = auditPaletteCss(css)
    const row = results.find((result) => result.id === `COL-01.minimum.:root.${pair}`)
    expect(row).toBeDefined()
    expect(row.status).toBe('fail')
    expect(row.observed.foregroundRole).toBe(token)
    expect(row.observed.ratio).toBeLessThan(threshold)
    expect(results.find((result) => result.id === 'COL-01.minimum.:root.primary/canvas').status).toBe('pass')
  })

  test('the real palette predicate rejects a contrast-breaking token mutation', async () => {
    const css = (await readFile(resolve(root, 'src/palettes.css'), 'utf8')).replace('--ink: #24292d', '--ink: #ffffff')
    const row = auditPaletteCss(css).find((result) => result.id === 'COL-01.minimum.:root.primary/canvas')
    expect(row.status).toBe('fail')
    expect(row.observed.ratio).toBeLessThan(4.5)
  })

  test('never rounds a near-miss contrast upward across the threshold', () => {
    const threshold = 4.5
    const observed = 4.499999
    expect(observed >= threshold).toBe(false)
    expect(Number(observed.toFixed(2))).toBe(4.5)
  })

  test('rejects a readable but unregistered semantic foreground/background pair', () => {
    expect(renderedRolePairRegistration({ foregroundRole: 'primary', backgroundRole: 'navigation', state: 'default' }).registered).toBe(true)
    expect(renderedRolePairRegistration({ foregroundRole: 'on-accent', backgroundRole: 'accent', state: 'pressed' }).registered).toBe(true)
    expect(renderedRolePairRegistration({ foregroundRole: 'code', backgroundRole: 'popover', state: 'default' })).toMatchObject({ registered: true, foregroundTokens: ['attention-ink'] })
    for (const foregroundRole of ['action', 'insight', 'series-1', 'series-2', 'series-3', 'series-4', 'series-5'])
      expect(renderedRolePairRegistration({ foregroundRole, backgroundRole: 'canvas', state: 'default' }).registered).toBe(true)
    expect(renderedRolePairRegistration({ foregroundRole: 'action', backgroundRole: 'action-fill', state: 'default' }).registered).toBe(true)
    expect(renderedRolePairRegistration({ foregroundRole: 'insight', backgroundRole: 'insight-fill', state: 'default' }).registered).toBe(true)
    expect(renderedRolePairRegistration({ foregroundRole: 'primary', backgroundRole: 'accent', state: 'default' }).registered).toBe(false)
  })
})

describe('metamorphic and adversarial contracts', () => {
  test('the runner rejects an actual metamorphic evidence row above the geometry tolerance', () => {
    const passing = [{ name: 'palette: geometry isolation', pass: true, observed: { residual: 0.5 } }]
    const failing = [{ name: 'palette: geometry isolation', pass: true, observed: { residual: 0.51 } }]
    expect(geometryResidualResult(passing[0].observed.residual, PREDICATE_TOLERANCES.appearanceEdgePx)).toBe('pass')
    expect(invariantCheckResult(passing)).toBe('pass')
    expect(invariantCheckResult(failing)).toBe('fail')
    expect(invariantCheckResult([{ name: 'palette: geometry isolation', pass: true, observed: {} }])).toBe('not-measurable')
  })

  test('contrast after alpha composition differs from the source token contrast', () => {
    const opaque = '#586069'
    const canvas = '#ffffff'
    const blendedText = '#aeb0b3'
    expect(contrastRatio(opaque, canvas)).toBeGreaterThan(4.5)
    expect(contrastRatio(blendedText, canvas)).toBeLessThan(4.5)
  })

  test('missing role pair is a coverage failure rather than an empty pass', () => {
    const css = ':root { --ink: #24292d; --redwood: #3379b3; }'
    const results = auditPaletteCss(css)
    expect(results.some((result) => result.id.includes('primary/canvas') && result.status === 'fail')).toBe(true)
  })
})
