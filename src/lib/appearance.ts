// SOURCING: Zustand persist, Zod and Culori, already used by the app's settings and palette generator.
import { wcagContrast } from 'culori'
import { z } from 'zod'
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import {
  COLOR_PAIRS,
  COLOR_ROLES,
  MATERIALS,
  PALETTES,
  SURFACE_ROLES,
  TEXT_RECIPES,
} from './appearance-policy'
import type { Material, SurfaceRole } from './appearance-policy'
import { paletteTokens } from '../../scripts/palettes'

export const APPEARANCE_STORAGE_KEY = 'theorem-ui:appearance'
export const APPEARANCE_VERSION = 1

const paletteSchema = z.enum(PALETTES.map(({ value }) => value))
const presetSchema = z.enum(['calm', 'expressive'])
const modeSchema = z.enum(['system', 'light', 'dark'])
const material = z.enum(MATERIALS)
const density = z.enum(['compact', 'comfortable', 'touch'])
const reading = z.enum(['comfortable', 'wide'])
const layout = z.enum(['conversation', 'sidecar'])
const motion = z.enum(['system', 'reduced'])
// The cabinet's preview preference. Absent is "use theme default": the
// preset decides (expressive → pixel, calm → full_fidelity).
export const previewPreferenceSchema = z.enum(['pixel', 'full_fidelity'])
const scale = z.number().min(0.75).max(2)
const fontFamily = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[\p{L}\p{N}][\p{L}\p{N} _-]*$/u)
const lineHeight = z.number().min(1.2).max(2.5)
const measure = z.number().min(20).max(100)
const opaqueHex = z
  .string()
  .regex(/^#[0-9a-f]{6}$/i, 'Use an opaque, six-digit sRGB hex color.')
/** The snippet with its comments taken out, so a comment cannot split a word the checks look for. */
const uncommented = (css: string) => css.replace(/\/\*[\s\S]*?(?:\*\/|$)/g, ' ')

/**
 * A custom CSS snippet, applied after the app's own styles. It travels with
 * an exported appearance, so it may not reach the network: no @import, and no
 * url() or src() but data: URLs. A browser decodes CSS escapes before it
 * reads a word (`@\69 mport` is `@import`), so the snippet may hold none,
 * and the functions that take a bare string as an address are refused.
 */
export const customCssSchema = z
  .string()
  .max(20_000, 'Keep custom CSS under 20,000 characters.')
  .refine(
    (css) => !css.includes('\\'),
    'Custom CSS cannot use backslash escapes.',
  )
  .refine(
    (css) => !/@import/i.test(uncommented(css)),
    'Custom CSS cannot use @import.',
  )
  .refine(
    (css) => !/(?:url|src)\((?!\s*['"]?\s*data:)/i.test(uncommented(css)),
    'Custom CSS can only use data: URLs.',
  )
  .refine(
    (css) => !/(?:image-set|image|cross-fade)\(/i.test(uncommented(css)),
    'Custom CSS cannot use image-set(), image() or cross-fade(); use url() with a data: URL.',
  )
const customColorRoles = z.enum([...new Set(Object.values(COLOR_ROLES))])
/** A saved palette's colours. New tokens (action/insight/series) are optional
 *  on read so an older saved palette still loads. The contrast gate completes
 *  missing tokens with the same defaults used when the palette is applied. */
const customColors = z.partialRecord(customColorRoles, opaqueHex)

/** The color roles a person edits in Settings, in the order they are shown:
 *  the surfaces first, then the inks, then the semantic accents. Each entry
 *  names the CSS token it paints and what the colour means. */
export const EDITABLE_COLOR_ROLES = [
  {
    token: 'surface-neutral',
    label: 'Canvas',
    hint: 'Reading and long-running work',
  },
  {
    token: 'surface-raised',
    label: 'Raised surface',
    hint: 'Cards, previews and popovers',
  },
  {
    token: 'surface-sidebar',
    label: 'Navigation',
    hint: 'The sidebar and rail',
  },
  { token: 'surface-composer', label: 'Composer', hint: 'Where you write' },
  {
    token: 'surface-user-message',
    label: 'Your messages',
    hint: 'The background behind your chat messages',
  },
  {
    token: 'surface-artifact',
    label: 'Artifacts',
    hint: 'The background behind generated content',
  },
  {
    token: 'surface-hover',
    label: 'Hover surface',
    hint: 'Rows and items under the pointer',
  },
  {
    token: 'surface-selected',
    label: 'Selection',
    hint: 'The chosen row or item',
  },
  { token: 'ink', label: 'Primary ink', hint: 'Body text' },
  { token: 'ink-muted', label: 'Secondary ink', hint: 'Labels and metadata' },
  {
    token: 'attention-ink',
    label: 'Code ink',
    hint: 'Inline code on reading surfaces',
  },
  {
    token: 'redwood',
    label: 'Accent',
    hint: 'Brand, active selection, emphasis',
  },
  {
    token: 'redwood-hover',
    label: 'Accent hover',
    hint: 'The accent fill under the pointer',
  },
  {
    token: 'redwood-pressed',
    label: 'Accent pressed',
    hint: 'The accent fill while pressed',
  },
  { token: 'redwood-ink', label: 'Accent ink', hint: 'Links and accent text' },
  { token: 'on-redwood', label: 'On accent', hint: 'Text on the accent fill' },
  {
    token: 'action-ink',
    label: 'Action',
    hint: 'An action available now or a pending decision',
  },
  {
    token: 'action-container',
    label: 'Action fill',
    hint: 'The action accent as a background',
  },
  {
    token: 'insight-ink',
    label: 'Insight',
    hint: 'A learned relationship or capture confirmation',
  },
  {
    token: 'insight-container',
    label: 'Insight fill',
    hint: 'The insight accent as a background',
  },
  { token: 'teal-ink', label: 'Success', hint: 'A completed outcome' },
  {
    token: 'teal-container',
    label: 'Success fill',
    hint: 'Success as a background',
  },
  { token: 'ochre-ink', label: 'Warning', hint: 'Caution' },
  {
    token: 'ochre-container',
    label: 'Warning fill',
    hint: 'Warning as a background',
  },
  { token: 'error-ink', label: 'Error', hint: 'A failed outcome' },
  {
    token: 'error-container',
    label: 'Error fill',
    hint: 'Error as a background',
  },
  {
    token: 'error-solid',
    label: 'Destructive action',
    hint: 'The fill for destructive buttons',
  },
  {
    token: 'on-error',
    label: 'On destructive action',
    hint: 'Text on destructive buttons',
  },
  { token: 'focus', label: 'Focus ring', hint: 'Keyboard focus' },
  {
    token: 'line-separator',
    label: 'Separator',
    hint: 'Hairlines between rows',
  },
  {
    token: 'line-control',
    label: 'Control boundary',
    hint: 'Borders of fields and controls',
  },
  {
    token: 'series-1',
    label: 'Data series 1',
    hint: 'First chart series: line, markers and legend',
  },
  {
    token: 'series-2',
    label: 'Data series 2',
    hint: 'Second chart series',
  },
  {
    token: 'series-3',
    label: 'Data series 3',
    hint: 'Third chart series',
  },
  {
    token: 'series-4',
    label: 'Data series 4',
    hint: 'Fourth chart series',
  },
  {
    token: 'series-5',
    label: 'Data series 5',
    hint: 'Fifth chart series',
  },
] as const satisfies readonly { token: string; label: string; hint: string }[]

export const customPaletteSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(60),
    light: customColors,
    dark: customColors,
  })
  .superRefine((palette, context) => {
    const colors = completeCustomPalette(palette)
    for (const mode of ['light', 'dark'] as const) {
      for (const { foreground, background, minimum } of COLOR_PAIRS) {
        const ink = colors[mode][COLOR_ROLES[foreground]]
        const fill = colors[mode][COLOR_ROLES[background]]
        if (ink && fill && wcagContrast(ink, fill) < minimum) {
          context.addIssue({
            code: 'custom',
            path: [mode, foreground],
            message: `${foreground} on ${background} needs ${minimum}:1 contrast.`,
          })
        }
      }
    }
  })

export const customFontInputSchema = z.strictObject({
  textFamily: fontFamily,
  codeFamily: fontFamily.optional(),
  contentLineHeight: lineHeight.optional(),
  uiLineHeight: lineHeight.optional(),
  codeLineHeight: lineHeight.optional(),
  comfortableMeasure: measure.optional(),
  wideMeasure: measure.optional(),
})

const calibratedFontSchema = customFontInputSchema
  .extend({
    comfortableMeasure: measure,
    wideMeasure: measure,
  })
  .refine(
    ({ comfortableMeasure, wideMeasure }) => comfortableMeasure <= wideMeasure,
    {
      path: ['wideMeasure'],
      message:
        'The wide measure must be at least as large as the comfortable measure.',
    },
  )

const appearanceOptionsSchema = z
  .strictObject({
    palette: z.union([paletteSchema, z.literal('custom')]),
    customPalette: customPaletteSchema,
    density,
    reading,
    layout,
    motion,
    preview: previewPreferenceSchema,
    css: customCssSchema,
    scales: z
      .strictObject({ content: scale, ui: scale, code: scale })
      .partial(),
    // Accept v1 reply overrides without resetting the rest of a saved theme.
    // Replies now share the canvas, so this obsolete override is not exported.
    materials: z
      .partialRecord(z.enum(SURFACE_ROLES), material)
      .transform((materials) => {
        delete materials['assistant-reading']
        return materials
      }),
  })
  .partial()

function checkCustomPalette({
  palette,
  customPalette,
}: z.infer<typeof appearanceOptionsSchema>) {
  return palette !== 'custom' || customPalette !== undefined
}

export const appearanceOverridesSchema = appearanceOptionsSchema
  .extend({ font: calibratedFontSchema.optional() })
  .refine(checkCustomPalette, {
    path: ['customPalette'],
    message: 'Select a validated custom palette.',
  })

export const appearanceSelectionSchema = z.strictObject({
  preset: presetSchema,
  overrides: appearanceOverridesSchema,
})

export const appearanceDocumentSchema = appearanceSelectionSchema.extend({
  version: z.literal(APPEARANCE_VERSION),
  mode: modeSchema.optional(),
  life: z.boolean().optional(),
  overrides: appearanceOptionsSchema
    .extend({ font: customFontInputSchema.optional() })
    .refine(checkCustomPalette, {
      path: ['customPalette'],
      message: 'Select a validated custom palette.',
    }),
})

export type AppearancePreset = z.infer<typeof presetSchema>
export type AppearanceMode = z.infer<typeof modeSchema>
export type AppearanceInput = z.infer<
  typeof appearanceDocumentSchema
>['overrides']
export type AppearanceOverrides = z.infer<typeof appearanceOverridesSchema>
export type AppearanceSelection = z.infer<typeof appearanceSelectionSchema>

const flatMaterials = Object.fromEntries(
  SURFACE_ROLES.map((role) => [role, 'flat']),
) as Record<SurfaceRole, Material>
const presetDefaults = {
  calm: { materials: flatMaterials, life: false },
  expressive: {
    materials: {
      ...flatMaterials,
      canvas: 'paper',
      navigation: 'glass',
      // The composer and the side panel are the same frost over the Life field.
      composer: 'glass',
      'user-message': 'paper',
    },
    life: true,
  },
} as const

export const DEFAULT_APPEARANCE: AppearanceSelection = {
  preset: 'calm',
  overrides: {},
}

export function resolveAppearance({ preset, overrides }: AppearanceSelection) {
  const defaults = presetDefaults[preset]
  // An older saved custom palette predates the action/insight/series tokens.
  // Fill those from the default palette so the custom surface keeps a complete,
  // contrast-checked set instead of dropping the whole saved appearance.
  const customPalette = overrides.customPalette
    ? completeCustomPalette(overrides.customPalette)
    : undefined
  return {
    preset,
    palette: overrides.palette ?? 'github-sharp',
    customPalette,
    font: overrides.font,
    density: overrides.density ?? 'comfortable',
    reading: overrides.reading ?? 'comfortable',
    layout: overrides.layout ?? 'conversation',
    motion: overrides.motion ?? 'system',
    css: overrides.css ?? '',
    scales: { content: 1, ui: 1, code: 1, ...overrides.scales },
    materials: {
      ...defaults.materials,
      ...overrides.materials,
      'assistant-reading': 'flat' as const,
      // The chart frame is glass by default (owner, 2026-11-19); its plotted
      // data stays on a stable reading surface. An explicit override wins.
      chart: overrides.materials?.chart ?? ('glass' as const),
    },
    life: defaults.life,
  }
}

/** The default palette's tokens, used to fill tokens an older custom palette
 *  lacks. Read from the generated stylesheet's :root/.dark calm blocks. */
const DEFAULT_TOKENS = paletteTokens('github-sharp')

function completeCustomPalette(palette: {
  name: string
  light: Record<string, string | undefined>
  dark: Record<string, string | undefined>
}) {
  const fill = (mode: 'light' | 'dark') => {
    const saved = palette[mode]
    const fallback = DEFAULT_TOKENS?.[mode] ?? {}
    const alternate =
      DEFAULT_TOKENS?.[mode === 'light' ? 'dark' : 'light'] ?? {}
    const complete: Record<string, string> = {}
    for (const token of new Set(Object.values(COLOR_ROLES))) {
      const value = saved[token] ?? fallback[token]
      if (value) complete[token] = value
    }

    // A saved light mode can have dark surfaces, or the reverse. Missing
    // new roles prefer the built-in colors, then inherit a saved ink or
    // surface that satisfies their actual pairs. Saved colors stay intact.
    const fillMissing = (
      token: string,
      inheritedToken: string,
      pendingBackground?: string,
    ) => {
      if (saved[token] !== undefined) return
      const chosen = [
        complete[token],
        alternate[token],
        complete[inheritedToken],
        complete.ink,
      ].find(
        (value) =>
          value !== undefined &&
          COLOR_PAIRS.every(({ foreground, background, minimum }) => {
            const inkToken = COLOR_ROLES[foreground]
            const fillToken = COLOR_ROLES[background]
            if (inkToken !== token && fillToken !== token) return true
            if (fillToken === pendingBackground) return true
            const ink = inkToken === token ? value : complete[inkToken]
            const backdrop = fillToken === token ? value : complete[fillToken]
            return Boolean(
              ink && backdrop && wcagContrast(ink, backdrop) >= minimum,
            )
          }),
      )
      if (chosen !== undefined) complete[token] = chosen
    }
    for (const [ink, container, inherited] of [
      ['action-ink', 'action-container', 'redwood-ink'],
      ['insight-ink', 'insight-container', 'ochre-ink'],
    ] as const) {
      fillMissing(
        ink,
        inherited,
        saved[container] === undefined ? container : undefined,
      )
      fillMissing(container, 'surface-neutral')
    }
    for (const [series, inherited] of [
      ['series-1', 'redwood-ink'],
      ['series-2', 'teal-ink'],
      ['series-3', 'ochre-ink'],
      ['series-4', 'ink'],
      ['series-5', 'ink-muted'],
    ] as const)
      fillMissing(series, inherited)

    return complete
  }
  return { name: palette.name, light: fill('light'), dark: fill('dark') }
}

export type ResolvedAppearance = ReturnType<typeof resolveAppearance>

function storedState(storage: Pick<Storage, 'getItem'>, key: string): unknown {
  try {
    return JSON.parse(storage.getItem(key) ?? 'null')?.state
  } catch {
    return undefined
  }
}

export function migrateLegacyAppearance(
  storage: Pick<Storage, 'getItem'>,
): AppearanceSelection {
  const oldPalette = z
    .object({ palette: paletteSchema })
    .safeParse(storedState(storage, 'theorem-ui:palette'))
  const oldSurface = z
    .object({ composer: material })
    .safeParse(storedState(storage, 'theorem-ui:surfaces'))
  const oldLife = z
    .object({ shown: z.boolean() })
    .safeParse(storedState(storage, 'theorem-ui:life'))
  if (!oldPalette.success && !oldSurface.success && !oldLife.success)
    return DEFAULT_APPEARANCE
  return {
    preset: 'expressive',
    overrides: {
      ...(oldPalette.success && { palette: oldPalette.data.palette }),
      ...(oldSurface.success && {
        materials: {
          composer: oldSurface.data.composer,
          navigation:
            oldSurface.data.composer === 'liquid' ? 'liquid' : 'glass',
        },
      }),
    },
  }
}

interface AppearanceState extends AppearanceSelection {
  appearance: ResolvedAppearance
  selectPreset: (preset: AppearancePreset) => void
  setOverrides: (overrides: AppearanceOverrides) => void
  resetOverrides: () => void
  loadSelection: (selection: AppearanceSelection) => void
}

function initialAppearance() {
  try {
    return typeof window === 'undefined'
      ? DEFAULT_APPEARANCE
      : migrateLegacyAppearance(window.localStorage)
  } catch {
    return DEFAULT_APPEARANCE
  }
}

const initial = initialAppearance()
const withResolved = (selection: AppearanceSelection) => ({
  ...selection,
  appearance: resolveAppearance(selection),
})

export const useAppearance = create<AppearanceState>()(
  persist(
    (set) => ({
      ...withResolved(initial),
      selectPreset: (preset) =>
        set((state) =>
          withResolved(
            appearanceSelectionSchema.parse({
              preset,
              overrides: state.overrides,
            }),
          ),
        ),
      setOverrides: (patch) =>
        set((state) => {
          const overrides = appearanceOverridesSchema.parse({
            ...state.overrides,
            ...patch,
            scales: patch.scales
              ? { ...state.overrides.scales, ...patch.scales }
              : state.overrides.scales,
            materials: patch.materials
              ? { ...state.overrides.materials, ...patch.materials }
              : state.overrides.materials,
          })
          return withResolved({ preset: state.preset, overrides })
        }),
      resetOverrides: () =>
        set(({ preset }) => withResolved({ preset, overrides: {} })),
      loadSelection: (selection) =>
        set(withResolved(appearanceSelectionSchema.parse(selection))),
    }),
    {
      name: APPEARANCE_STORAGE_KEY,
      version: APPEARANCE_VERSION,
      partialize: ({ preset, overrides }) => ({ preset, overrides }),
      merge: (persisted, state) => {
        const parsed = appearanceSelectionSchema.safeParse(persisted)
        if (!parsed.success) {
          if (persisted !== undefined)
            console.warn(
              'Invalid saved appearance preferences:',
              parsed.error.issues,
            )
          return state
        }
        return { ...state, ...withResolved(parsed.data) }
      },
    },
  ),
)

export const useSurfaceMaterial = (role: SurfaceRole) =>
  useAppearance((state) => state.appearance.materials[role])

function applyAppearance(appearance: ResolvedAppearance) {
  const root = document.documentElement
  root.dataset.appearancePreset = appearance.preset
  root.dataset.palette = appearance.palette
  root.dataset.density = appearance.density
  root.dataset.readingWidth = appearance.reading
  root.dataset.appearanceMotion = appearance.motion
  root.dataset.appearanceState = JSON.stringify(appearance)
  for (const role of SURFACE_ROLES)
    root.setAttribute(`data-material-${role}`, appearance.materials[role])
  // Only a chosen size goes on the root, so custom CSS can set the rest
  // (appearance.css holds the defaults).
  for (const [name, value] of Object.entries(appearance.scales)) {
    if (value === 1) root.style.removeProperty(`--appearance-scale-${name}`)
    else root.style.setProperty(`--appearance-scale-${name}`, `${value}`)
  }
  applyCustomCss(appearance.css)
  const { font, customPalette } = appearance
  const properties = {
    '--appearance-prose-line-height': `calc(${TEXT_RECIPES.prose.size * (font?.contentLineHeight ?? TEXT_RECIPES.prose.lineHeight)}rem * var(--appearance-scale-content))`,
    '--appearance-font-text':
      font && `${JSON.stringify(font.textFamily)}, var(--font-sans)`,
    '--appearance-font-mono':
      font?.codeFamily &&
      `${JSON.stringify(font.codeFamily)}, var(--font-mono)`,
    '--appearance-measure-comfortable': font && `${font.comfortableMeasure}em`,
    '--appearance-measure-wide': font && `${font.wideMeasure}em`,
  }
  for (const [name, value] of Object.entries(properties)) {
    if (value) root.style.setProperty(name, value)
    else root.style.removeProperty(name)
  }
  for (const [name, recipe] of Object.entries(TEXT_RECIPES)) {
    const key = `--recipe-${name.replace('.', '-')}`
    // A custom font replaces the interface's text and code faces; what the
    // person writes keeps Manrope and its own line.
    const family =
      recipe.family === 'human'
        ? 'var(--font-human)'
        : `var(--appearance-font-${recipe.family}, var(--font-${recipe.family === 'text' ? 'sans' : 'mono'}))`
    const ratio =
      recipe.family === 'human'
        ? recipe.lineHeight
        : (font?.[`${recipe.scale}LineHeight`] ?? recipe.lineHeight)
    root.style.setProperty(
      key,
      `${recipe.weight} calc(${recipe.size}rem * var(--appearance-scale-${recipe.scale})) / ${ratio} ${family}`,
    )
  }
  for (const token of new Set(Object.values(COLOR_ROLES))) {
    for (const mode of ['light', 'dark'] as const) {
      const name = `--custom-${mode}-${token}`
      const value = customPalette?.[mode][token]
      if (value && appearance.palette === 'custom')
        root.style.setProperty(name, value)
      else root.style.removeProperty(name)
    }
  }
}

const CUSTOM_CSS_ID = 'theorem-custom-css'

/**
 * The snippet goes last in the document, after every stylesheet the app
 * loads, so a rule of equal weight to the app's own wins.
 */
function applyCustomCss(css: string) {
  let style = document.getElementById(CUSTOM_CSS_ID)
  if (!css) {
    style?.remove()
    return
  }
  if (!style) {
    style = document.createElement('style')
    style.id = CUSTOM_CSS_ID
  }
  if (style.textContent !== css) style.textContent = css
  // The DOM types call body non-null, but it is null until the parser reaches it.
  const body = () => document.body as HTMLElement | null
  const place = () => {
    const parent = body() ?? document.head
    if (style.parentNode !== parent || style.nextElementSibling)
      parent.append(style)
  }
  place()
  if (!body())
    document.addEventListener('DOMContentLoaded', place, { once: true })
}

if (typeof window !== 'undefined') {
  applyAppearance(useAppearance.getState().appearance)
  useAppearance.subscribe(({ appearance }, { appearance: before }) => {
    if (appearance === before) return
    const reflows =
      appearance.density !== before.density ||
      appearance.reading !== before.reading ||
      appearance.layout !== before.layout ||
      appearance.font !== before.font ||
      Object.keys(appearance.scales).some(
        (key) =>
          appearance.scales[key as keyof typeof appearance.scales] !==
          before.scales[key as keyof typeof before.scales],
      )
    if (reflows) document.dispatchEvent(new Event('theorem-appearance-reflow'))
    applyAppearance(appearance)
  })
}

// Keep this early paint script to known enum values. The store validates the
// full envelope, custom data, and persisted overrides before applying them.
export const appearanceScript = `try {
  var read = function(key) { try { return JSON.parse(localStorage.getItem(key)); } catch (e) { return null; } };
  var saved = read(${JSON.stringify(APPEARANCE_STORAGE_KEY)});
  var state = saved?.version === ${APPEARANCE_VERSION} && ['calm', 'expressive'].includes(saved?.state?.preset) ? saved.state : null;
  var palettes = ${JSON.stringify(PALETTES.map(({ value }) => value))};
  var oldPalette = read('theorem-ui:palette')?.state?.palette;
  var oldSurface = read('theorem-ui:surfaces')?.state?.composer;
  var oldLife = read('theorem-ui:life')?.state?.shown;
  var legacy = palettes.includes(oldPalette) || ${JSON.stringify(MATERIALS)}.includes(oldSurface) || typeof oldLife === 'boolean';
  var root = document.documentElement;
  root.dataset.appearancePreset = state?.preset ?? (legacy ? 'expressive' : 'calm');
  var palette = state ? state.overrides?.palette : oldPalette;
  if (palettes.includes(palette)) root.dataset.palette = palette;
  var density = state?.overrides?.density;
  if (['compact', 'comfortable', 'touch'].includes(density)) root.dataset.density = density;
  if (state?.overrides?.reading === 'wide') root.dataset.readingWidth = 'wide';
} catch (e) {}`
