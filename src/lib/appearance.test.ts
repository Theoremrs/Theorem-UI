import { describe, expect, test } from 'bun:test'
import { wcagContrast } from 'culori'
import { appearanceTokens, modes } from '../../scripts/palettes'
import {
  APPEARANCE_VERSION,
  appearanceDocumentSchema,
  appearanceOverridesSchema,
  appearanceSelectionSchema,
  customCssSchema,
  customPaletteSchema,
  DEFAULT_APPEARANCE,
  migrateLegacyAppearance,
  resolveAppearance,
} from './appearance'
import {
  CALM_COLORS,
  COLOR_PAIRS,
  COLOR_ROLES,
  SURFACE_ROLES,
} from './appearance-policy'

const storage = (data: Record<string, unknown>) => ({
  getItem: (key: string) =>
    key in data ? JSON.stringify({ state: data[key] }) : null,
})

const candidate = (dark: boolean) => {
  const tokens = appearanceTokens(modes[dark ? 1 : 0]!, true)
  return Object.fromEntries(
    [...new Set(Object.values(COLOR_ROLES))].map((role) => [
      role,
      tokens[role],
    ]),
  )
}

const customPalette = () => ({
  name: 'Custom',
  light: candidate(false),
  dark: candidate(true),
})

describe('appearance selection', () => {
  test('the Calm manifest keeps reading surfaces flat, the chart glass, Life off', () => {
    const appearance = resolveAppearance(DEFAULT_APPEARANCE)
    expect(appearance.palette).toBe('github-sharp')
    for (const role of SURFACE_ROLES)
      expect(appearance.materials[role]).toBe(
        role === 'chart' ? 'glass' : 'flat',
      )
    expect(appearance.life).toBe(false)
    for (const mode of modes.slice(0, 2)) {
      const tokens = appearanceTokens(mode, true)
      for (const [role, paint] of Object.entries(
        CALM_COLORS[mode.dark ? 'dark' : 'light'],
      ))
        expect(tokens[role]).toBe(paint)
    }
  })

  test('the chart defaults to glass in both presets and an explicit override wins', () => {
    for (const preset of ['calm', 'expressive'] as const)
      expect(resolveAppearance({ preset, overrides: {} }).materials.chart).toBe(
        'glass',
      )
    const overridden = resolveAppearance({
      preset: 'expressive',
      overrides: { materials: { chart: 'flat' } },
    })
    expect(overridden.materials.chart).toBe('flat')
    // The chart default does not change the artifact surface.
    expect(overridden.materials.artifact).toBe('flat')
  })

  test('overrides survive preset changes and do not couple materials', () => {
    const overrides = appearanceOverridesSchema.parse({
      materials: { composer: 'liquid' },
      scales: { content: 1.5 },
    })
    const calm = resolveAppearance({ preset: 'calm', overrides })
    const expressive = resolveAppearance({ preset: 'expressive', overrides })
    expect(calm.scales).toEqual({ content: 1.5, ui: 1, code: 1 })
    expect(expressive.scales).toEqual(calm.scales)
    expect(calm.materials.composer).toBe('liquid')
    expect(calm.materials.navigation).toBe('flat')
    expect(expressive.materials.composer).toBe('liquid')
    expect(expressive.materials.navigation).toBe('glass')
  })

  test('migrates old deliberate palette and liquid surface choices', () => {
    const migrated = migrateLegacyAppearance(
      storage({
        'theorem-ui:palette': { palette: 'vitesse' },
        'theorem-ui:surfaces': { composer: 'liquid' },
      }),
    )
    expect(migrated).toEqual({
      preset: 'expressive',
      overrides: {
        palette: 'vitesse',
        materials: { composer: 'liquid', navigation: 'liquid' },
      },
    })
    expect(
      migrateLegacyAppearance(
        storage({ 'theorem-ui:palette': { palette: 'unknown' } }),
      ),
    ).toEqual(DEFAULT_APPEARANCE)
  })

  test('old reply materials are retired without losing other theme preferences', () => {
    const legacy = {
      palette: 'stone',
      density: 'touch',
      scales: { content: 1.25 },
      materials: {
        canvas: 'paper',
        composer: 'glass',
        'assistant-reading': 'liquid',
      },
    } as const
    const expected = {
      ...legacy,
      materials: { canvas: 'paper', composer: 'glass' },
    } as const
    expect(appearanceOverridesSchema.parse(legacy)).toEqual(expected)
    const document = appearanceDocumentSchema.parse({
      version: APPEARANCE_VERSION,
      preset: 'expressive',
      overrides: legacy,
    })
    expect(document.overrides).toEqual(expected)
    expect(JSON.stringify(document)).not.toContain('assistant-reading')
  })

  test('portable documents reject unsupported versions, fields, fonts and role names', () => {
    const portable = {
      version: APPEARANCE_VERSION,
      preset: 'expressive',
      overrides: {},
      mode: 'dark',
      life: false,
    } as const
    expect(
      appearanceDocumentSchema.parse(JSON.parse(JSON.stringify(portable))),
    ).toEqual(portable)
    expect(
      appearanceDocumentSchema.safeParse({ ...portable, version: 2 }).success,
    ).toBe(false)
    expect(
      appearanceOverridesSchema.safeParse({ customField: true }).success,
    ).toBe(false)
    expect(
      appearanceOverridesSchema.safeParse({ materials: { unknown: 'flat' } })
        .success,
    ).toBe(false)
    expect(
      appearanceOverridesSchema.safeParse({
        font: {
          textFamily: 'X; color:red',
          comfortableMeasure: 40,
          wideMeasure: 50,
        },
      }).success,
    ).toBe(false)
  })

  test('a portable input can request a font without assuming its measures', () => {
    const overrides = { font: { textFamily: 'Helvetica' } }
    expect(
      appearanceDocumentSchema.safeParse({
        version: APPEARANCE_VERSION,
        preset: 'calm',
        overrides,
      }).success,
    ).toBe(true)
    expect(appearanceOverridesSchema.safeParse(overrides).success).toBe(false)
  })

  test('rejects a candidate that passes on canvas and fails in selected state', () => {
    const valid = customPalette()
    expect(
      appearanceOverridesSchema.safeParse({
        palette: 'custom',
        customPalette: valid,
      }).success,
    ).toBe(true)
    expect(
      appearanceOverridesSchema.safeParse({ palette: 'custom' }).success,
    ).toBe(false)
    valid.light['surface-selected'] = valid.light.ink
    const invalid = appearanceOverridesSchema.safeParse({
      palette: 'custom',
      customPalette: valid,
    })
    expect(invalid.success).toBe(false)
    if (!invalid.success)
      expect(
        invalid.error.issues.some(({ message }) =>
          message.includes('primary on selected'),
        ),
      ).toBe(true)
  })

  test.each([
    ['light', { ink: '#ffffff' }],
    ['dark', { ink: '#000000' }],
    ['light', { 'surface-neutral': '#000000' }],
    ['dark', { 'surface-neutral': '#ffffff' }],
  ] as const)(
    'a partial %s palette is checked against its completed colors (%j)',
    (mode, colors) => {
      const selection = {
        preset: 'calm',
        overrides: {
          palette: 'custom',
          customPalette: {
            name: 'Incomplete contrast',
            light: {},
            dark: {},
            [mode]: colors,
          },
        },
      }
      const imported = appearanceDocumentSchema.safeParse({
        version: APPEARANCE_VERSION,
        ...selection,
      })
      const saved = appearanceSelectionSchema.safeParse(selection)
      for (const result of [imported, saved]) {
        expect(result.success).toBe(false)
        if (!result.success)
          expect(
            result.error.issues.some(
              ({ path, message }) =>
                path.join('.') === `overrides.customPalette.${mode}.primary` &&
                message.includes('primary on canvas'),
            ),
          ).toBe(true)
      }
    },
  )

  test('a readable partial palette retains its colors and completes to a validated theme', () => {
    const parsed = appearanceDocumentSchema.parse({
      version: APPEARANCE_VERSION,
      preset: 'calm',
      overrides: {
        palette: 'custom',
        customPalette: {
          name: 'Partial theme',
          light: { ink: '#000000' },
          dark: { ink: '#ffffff' },
        },
      },
    })
    const resolved = resolveAppearance(
      appearanceSelectionSchema.parse({
        preset: parsed.preset,
        overrides: parsed.overrides,
      }),
    )
    expect(resolved.customPalette?.light.ink).toBe('#000000')
    expect(resolved.customPalette?.dark.ink).toBe('#ffffff')
    expect(resolved.customPalette?.name).toBe('Partial theme')
    for (const mode of ['light', 'dark'] as const)
      for (const { foreground, background, minimum } of COLOR_PAIRS) {
        const colors = resolved.customPalette![mode]
        expect(
          wcagContrast(
            colors[COLOR_ROLES[foreground]]!,
            colors[COLOR_ROLES[background]]!,
          ),
        ).toBeGreaterThanOrEqual(minimum)
      }
  })

  test('every emitted built-in set satisfies all registered role pairs after quantization', () => {
    for (const mode of modes) {
      const sets = [appearanceTokens(mode)]
      if (mode.selector === ':root' || mode.selector === '.dark')
        sets.push(appearanceTokens(mode, true))
      for (const tokens of sets) {
        for (const { foreground, background, minimum } of COLOR_PAIRS) {
          const ink = tokens[COLOR_ROLES[foreground]]!
          const fill = tokens[COLOR_ROLES[background]]!
          expect(ink).toMatch(/^#[0-9a-f]{6}$/)
          expect(fill).toMatch(/^#[0-9a-f]{6}$/)
          expect(wcagContrast(ink, fill)).toBeGreaterThanOrEqual(minimum)
        }
      }
    }
  })

  test('all five series slots are exposed and follow an explicit override', () => {
    // The coverage defect: series 2 and 5 once read raw teal / graph-agent,
    // which the custom schema did not expose, so a user edit left them behind.
    const slots = [
      'series-1',
      'series-2',
      'series-3',
      'series-4',
      'series-5',
    ] as const
    for (const slot of slots) expect(Object.values(COLOR_ROLES)).toContain(slot)
    const valid = customPalette()
    // A neutral custom theme: every series set to one deliberate grey that
    // still clears 3:1 on the candidate surfaces.
    for (const slot of slots) {
      valid.light[slot] = '#595959'
      valid.dark[slot] = '#a6a6a6'
    }
    const parsed = appearanceOverridesSchema.safeParse({
      palette: 'custom',
      customPalette: valid,
    })
    expect(parsed.success).toBe(true)
    if (parsed.success)
      for (const slot of slots) {
        expect(parsed.data.customPalette?.light[slot]).toBe('#595959')
        expect(parsed.data.customPalette?.dark[slot]).toBe('#a6a6a6')
      }
  })

  test.each([
    ['black surfaces', '#000000', '#ffffff'],
    ['gray surfaces', '#707070', '#ffffff'],
    ['white surfaces', '#ffffff', '#000000'],
  ] as const)(
    'a legacy palette on %s migrates without changing its saved colors or preferences',
    (label, background, foreground) => {
      const added = new Set([
        'action-ink',
        'action-container',
        'insight-ink',
        'insight-container',
        'series-1',
        'series-2',
        'series-3',
        'series-4',
        'series-5',
      ])
      const previousPairs = COLOR_PAIRS.filter(
        (pair) =>
          !added.has(COLOR_ROLES[pair.foreground]) &&
          !added.has(COLOR_ROLES[pair.background]),
      )
      const colors: Record<string, string> = Object.fromEntries(
        Object.values(COLOR_ROLES)
          .filter((token) => !added.has(token))
          .map((token) => [token, background]),
      )
      for (const pair of previousPairs)
        colors[COLOR_ROLES[pair.foreground]] = foreground
      // Establish that this was a valid saved palette before the new roles.
      for (const pair of previousPairs)
        expect(
          wcagContrast(
            colors[COLOR_ROLES[pair.foreground]]!,
            colors[COLOR_ROLES[pair.background]]!,
          ),
        ).toBeGreaterThanOrEqual(pair.minimum)

      const older = {
        name: `Legacy ${label}`,
        light: { ...colors },
        dark: { ...colors },
      }
      const selection = {
        preset: 'expressive',
        overrides: {
          palette: 'custom',
          customPalette: older,
          density: 'touch',
          scales: { ui: 1.25 },
        },
      }
      const parsed = appearanceSelectionSchema.safeParse(selection)
      expect(parsed.success).toBe(true)
      if (!parsed.success) return
      const resolved = resolveAppearance(parsed.data)
      expect(resolved.preset).toBe('expressive')
      expect(resolved.density).toBe('touch')
      expect(resolved.scales.ui).toBe(1.25)
      expect(resolved.customPalette?.name).toBe(older.name)
      for (const mode of ['light', 'dark'] as const)
        for (const [token, color] of Object.entries(colors))
          expect(resolved.customPalette?.[mode][token]).toBe(color)
      expect(
        customPaletteSchema.safeParse(resolved.customPalette).success,
      ).toBe(true)

      // A contradictory new color explicitly chosen by the user is still
      // rejected; only absent defaults may adapt during completion.
      expect(
        appearanceSelectionSchema.safeParse({
          ...selection,
          overrides: {
            ...selection.overrides,
            customPalette: {
              ...older,
              light: { ...older.light, 'action-ink': background },
            },
          },
        }).success,
      ).toBe(false)
    },
  )

  test('an older custom palette missing the new tokens still loads, filled from the default', () => {
    const valid = customPalette()
    // Simulate a palette saved before action/insight/series existed.
    const older = {
      name: 'Old theme',
      light: { ...valid.light },
      dark: { ...valid.dark },
    }
    for (const token of [
      'action-ink',
      'action-container',
      'insight-ink',
      'insight-container',
      'series-1',
      'series-2',
      'series-3',
      'series-4',
      'series-5',
    ]) {
      delete older.light[token]
      delete older.dark[token]
    }
    const parsed = appearanceSelectionSchema.safeParse({
      preset: 'expressive',
      overrides: {
        palette: 'custom',
        customPalette: older,
        density: 'touch',
        scales: { ui: 1.25 },
      },
    })
    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    const resolved = resolveAppearance(parsed.data)
    // The new tokens are filled from the default palette, not dropped.
    expect(resolved.customPalette?.light['series-1']).toMatch(/^#[0-9a-f]{6}$/)
    expect(resolved.customPalette?.dark['action-ink']).toMatch(/^#[0-9a-f]{6}$/)
    // The person's own saved colours are preserved.
    expect(resolved.customPalette?.light.ink).toBe(valid.light.ink)
    expect(resolved.customPalette?.name).toBe('Old theme')
    expect(resolved.preset).toBe('expressive')
    expect(resolved.density).toBe('touch')
    expect(resolved.scales.ui).toBe(1.25)
  })
})

describe('custom CSS', () => {
  const ok = (css: string) => customCssSchema.safeParse(css).success

  test('takes plain rules and data: URLs', () => {
    expect(ok('.aui-composer { border-radius: 4px; }')).toBe(true)
    expect(ok('body { background: url("data:image/png;base64,AAAA"); }')).toBe(
      true,
    )
    expect(ok("body { background: url( 'data:image/svg+xml,<svg/>' ); }")).toBe(
      true,
    )
  })

  test('refuses anything that could reach the network, however it is spelled', () => {
    for (const css of [
      '@import "https://example.test/theme.css";',
      '@IMPORT url(https://example.test/theme.css);',
      '@\\69 mport "https://example.test/theme.css";',
      'body { background: u\\72l(https://example.test/a.png); }',
      'body { background: url(https://example.test/a.png); }',
      'body { background: url( "//example.test/a.png"); }',
      '@font-face { font-family: X; src: url(https://example.test/x.woff2); }',
      'body { background: src("https://example.test/a.png"); }',
      'body { background: image-set("https://example.test/a.png" 1x); }',
      'body { background: -webkit-image-set("https://example.test/a.png" 1x); }',
      'body { content: "\\2014"; }',
    ]) {
      expect({ css, ok: ok(css) }).toEqual({ css, ok: false })
    }
  })
})
