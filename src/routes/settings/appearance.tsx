// SOURCING: next-themes (light/dark), lib/palette (colours), lib/appearance (preset, sizes, custom CSS), lib/life/store (the field behind the chat), coss ui SegmentedControl for choices and Switch for on and off, the settings frame
import { createFileRoute } from '@tanstack/react-router'
import { useTheme } from 'next-themes'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { useCopyToClipboard } from '@/hooks/use-copy-to-clipboard'
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from '@/components/coss/select'
import {
  NumberField,
  NumberFieldGroup,
  NumberFieldInput,
} from '@/components/coss/number-field'
import { Switch } from '@/components/coss/switch'
import { Textarea } from '@/components/coss/textarea'
import {
  SegmentedControl,
  SegmentedControlItem,
} from '@/components/coss/segmented-control'
import {
  setCalculationsShown,
  useCalculationsShown,
} from '@/components/crm/calculations-setting'
import {
  SettingsBox,
  SettingsPage,
  SettingsRow,
  SettingsSection,
} from '@/components/settings/settings-frame'
import { useLifeControls, useLifeShown } from '@/lib/life/store'
import { PALETTES, CALM_COLORS, COLOR_ROLES } from '@/lib/appearance-policy'
import {
  APPEARANCE_VERSION,
  appearanceDocumentSchema,
  appearanceOverridesSchema,
  customCssSchema,
  customFontInputSchema,
  useAppearance,
} from '@/lib/appearance'
import type {
  AppearanceMode,
  AppearanceSelection,
  AppearanceOverrides,
  AppearanceInput,
} from '@/lib/appearance'
import { LATIN_PROSE_V1_PARAGRAPHS } from '@/lib/appearance-corpus.mjs'
import { PaletteColors } from '@/components/settings/palette-colors'

export const Route = createFileRoute('/settings/appearance')({
  component: AppearanceSettings,
})

const THEMES = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'system', label: 'System' },
]

/** One choice of a segmented control; the control slides its indicator to the pressed item. */
export function Choice({
  pressed,
  onPress,
  label,
}: {
  pressed: boolean
  onPress: () => void
  label: string
}) {
  return (
    <SegmentedControlItem
      size="sm"
      aria-pressed={pressed}
      data-pressed={pressed ? '' : undefined}
      onClick={onPress}
    >
      {label}
    </SegmentedControlItem>
  )
}

export function AppearanceSettings() {
  const { theme, setTheme } = useTheme()
  const { appearance, overrides, selectPreset, setOverrides, resetOverrides } =
    useAppearance()
  const lifeShown = useLifeShown()
  const lifeOverride = useLifeControls((state) => state.shown)
  const lifePlaying = useLifeControls((state) => state.playing)
  const calculations = useCalculationsShown()
  const reset = () => {
    resetOverrides()
    setTheme('system')
    useLifeControls.setState({ shown: undefined })
  }
  return (
    <SettingsPage
      title="Appearance"
      description="How Theorem looks on this device."
      action={
        <Button variant="outline" onClick={reset}>
          Reset appearance
        </Button>
      }
    >
      <SettingsSection title="Display">
        <SettingsBox>
          <SettingsRow
            title="Preset"
            description="Switch the overall look while keeping your appearance choices."
          >
            <SegmentedControl size="sm" aria-label="Appearance preset">
              <Choice
                label="Calm"
                pressed={appearance.preset === 'calm'}
                onPress={() => selectPreset('calm')}
              />
              <Choice
                label="Expressive"
                pressed={appearance.preset === 'expressive'}
                onPress={() => selectPreset('expressive')}
              />
            </SegmentedControl>
          </SettingsRow>
          <SettingsRow
            title="Theme"
            description="Light, dark, or whatever the system uses."
          >
            <SegmentedControl size="sm" aria-label="Theme">
              {THEMES.map(({ value, label }) => (
                <Choice
                  key={value}
                  label={label}
                  pressed={theme === value}
                  onPress={() => setTheme(value)}
                />
              ))}
            </SegmentedControl>
          </SettingsRow>
          <SettingsRow
            title="Colors"
            description="The palette for both display modes."
          >
            <Select
              items={[
                ...PALETTES,
                ...(appearance.customPalette
                  ? [{ value: 'custom', label: appearance.customPalette.name }]
                  : []),
              ]}
              value={appearance.palette}
              onValueChange={(value) => {
                const palette = PALETTES.find((item) => item.value === value)
                if (palette) setOverrides({ palette: palette.value })
                else if (value === 'custom' && appearance.customPalette)
                  setOverrides({ palette: 'custom' })
              }}
            >
              <SelectTrigger
                aria-label="Colors"
                data-appearance-recipe="ui.label"
                className="w-48 max-w-full min-h-[max(2.25rem,var(--appearance-control-min))]"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                {PALETTES.map(({ value, label }) => (
                  <SelectItem
                    key={value}
                    value={value}
                    data-appearance-recipe="ui.label"
                  >
                    {label}
                  </SelectItem>
                ))}
                {appearance.customPalette && (
                  <SelectItem value="custom" data-appearance-recipe="ui.label">
                    {appearance.customPalette.name}
                  </SelectItem>
                )}
              </SelectPopup>
            </Select>
          </SettingsRow>
          <SettingsRow
            title="Text size"
            description="Conversation, headings, and the message editor."
          >
            <TextSizeControl
              label="Text size"
              value={appearance.scales.content}
              onChange={(content) => setOverrides({ scales: { content } })}
            />
          </SettingsRow>
          <SettingsRow title="Density" description="Spacing and control sizes.">
            <Select
              items={DENSITY_OPTIONS}
              value={appearance.density}
              onValueChange={(density) => {
                if (density) setOverrides({ density })
              }}
            >
              <SelectTrigger
                aria-label="Density"
                data-appearance-recipe="ui.label"
                className="w-48 max-w-full min-h-[max(2.25rem,var(--appearance-control-min))]"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                {DENSITY_OPTIONS.map(({ value, label }) => (
                  <SelectItem
                    key={value}
                    value={value}
                    data-appearance-recipe="ui.label"
                  >
                    {label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </SettingsRow>
          <SettingsRow
            title="Reading width"
            description="Preferred conversation width when there is room."
          >
            <SegmentedControl size="sm" aria-label="Reading width">
              <Choice
                label="Comfortable"
                pressed={appearance.reading === 'comfortable'}
                onPress={() => setOverrides({ reading: 'comfortable' })}
              />
              <Choice
                label="Wide"
                pressed={appearance.reading === 'wide'}
                onPress={() => setOverrides({ reading: 'wide' })}
              />
            </SegmentedControl>
          </SettingsRow>
          <SettingsRow
            title="Calculations under record tables"
            description="A Calculate row under each record table: counts, percentages, sums and dates over the records loaded. Off, the table shows only how many records it holds. Kept on this device."
          >
            <Switch
              aria-label="Calculations under record tables"
              checked={calculations}
              onCheckedChange={setCalculationsShown}
            />
          </SettingsRow>
        </SettingsBox>
      </SettingsSection>
      <PaletteColors />
      <SettingsSection
        title="Background"
        description="What runs behind the conversation."
      >
        <SettingsBox>
          <SettingsRow
            title="Life field"
            description="A Game of Life behind the chat that quickens as the model works. Right-click empty space for its controls."
          >
            <Switch
              aria-label="Life field"
              checked={lifeShown}
              onCheckedChange={(shown) => useLifeControls.setState({ shown })}
            />
          </SettingsRow>
          <SettingsRow
            title="Background animation"
            description={
              lifeShown
                ? lifePlaying
                  ? 'Playing. Pause it to keep the field still behind the conversation.'
                  : 'Paused. The field stays where it stopped until you play it again.'
                : 'Turn the Life field on to play or pause it.'
            }
          >
            <Switch
              aria-label="Background animation playing"
              checked={lifeShown && lifePlaying}
              disabled={!lifeShown}
              onCheckedChange={(playing) => useLifeControls.setState({ playing })}
            />
          </SettingsRow>
        </SettingsBox>
      </SettingsSection>
      <SettingsSection
        title="Customize"
        description="The preset chooses materials, layout and motion. Adjust anything else with a CSS snippet, or edit the full settings as JSON."
      >
        <CustomCss
          value={appearance.css}
          onApply={(css) => setOverrides({ css })}
        />
        <AppearanceImport
          selection={{ preset: appearance.preset, overrides }}
          mode={theme as AppearanceMode | undefined}
          life={lifeOverride}
          onModeChange={setTheme}
        />
      </SettingsSection>
    </SettingsPage>
  )
}

const DENSITY_OPTIONS = [
  { value: 'compact', label: 'Compact' },
  { value: 'comfortable', label: 'Comfortable' },
  { value: 'touch', label: 'Touch' },
] as const

/** The scale's limits (appearance.ts) and the body text's size at 1 (1rem). */
const MIN_SCALE = 0.75
const MAX_SCALE = 2

/**
 * The size body text renders at, in pixels. It is stored as a multiple of
 * the browser's own text size, so a reader who enlarged that keeps it; the
 * field shows and takes what that multiple comes to on this device.
 */
function TextSizeControl({
  label,
  value,
  onChange,
}: {
  label: string
  value: number
  onChange: (value: number) => void
}) {
  const base =
    typeof window === 'undefined'
      ? 16
      : parseFloat(getComputedStyle(document.documentElement).fontSize) || 16
  return (
    <div className="flex items-center gap-2">
      <NumberField
        className="w-24"
        min={Math.ceil(base * MIN_SCALE)}
        max={Math.floor(base * MAX_SCALE)}
        step={1}
        value={Math.round(value * base)}
        format={{ maximumFractionDigits: 0 }}
        onValueCommitted={(next) => {
          if (next !== null) onChange(next / base)
        }}
      >
        <NumberFieldGroup>
          <NumberFieldInput
            aria-label={label}
            aria-description="Pixels"
            data-appearance-recipe="ui.label"
            className="h-auto min-h-(--appearance-control-min) py-1 sm:h-auto"
          />
        </NumberFieldGroup>
      </NumberField>
      <span data-appearance-recipe="ui.label" className="text-ink-muted">
        px
      </span>
    </div>
  )
}

const CSS_EXAMPLE = `/* Applied after Theorem's own styles. Examples: */
:root {
  --appearance-scale-ui: 1.1;     /* sidebar and controls, 1 = 14px */
  --appearance-scale-code: 0.95;  /* code, 1 = 13px */
  --font-sans: 'Inter Variable', system-ui, sans-serif;
}
:root.dark {
  --redwood: #e0703a;             /* the accent, in dark */
}`

/**
 * A CSS snippet for what the page has no control for: interface and code
 * text size, fonts, colours, blur, anything a selector reaches. It is saved
 * with the rest of the appearance and goes into the export.
 */
function CustomCss({
  value,
  onApply,
}: {
  value: string
  onApply: (css: string) => void
}) {
  const [text, setText] = useState<string>()
  const [message, setMessage] = useState('')
  const [invalid, setInvalid] = useState(false)
  const apply = (css: string) => {
    const parsed = customCssSchema.safeParse(css)
    if (!parsed.success) {
      setInvalid(true)
      setMessage(parsed.error.issues.map((issue) => issue.message).join(' '))
      return
    }
    onApply(parsed.data)
    setText(undefined)
    setInvalid(false)
    setMessage(parsed.data ? 'Custom CSS applied.' : 'Custom CSS removed.')
  }
  return (
    <details
      className="appearance-import rounded-lg border border-separator p-3"
      open={value ? true : undefined}
    >
      <summary className="cursor-pointer" data-appearance-recipe="ui.label">
        Custom CSS
      </summary>
      <div className="mt-3 flex min-w-0 flex-col gap-3">
        <p data-appearance-recipe="metadata" className="text-ink-muted">
          Applied after Theorem’s own styles and saved with your appearance.
          Fonts must be installed on this device; only data: URLs load.
        </p>
        <Textarea
          className="w-full min-w-0 [&_textarea]:min-h-40"
          data-appearance-recipe="code"
          aria-label="Custom CSS"
          spellCheck={false}
          placeholder={CSS_EXAMPLE}
          value={text ?? value}
          onChange={(event) => setText(event.currentTarget.value)}
        />
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => apply(text ?? value)}>Apply CSS</Button>
          <Button
            variant="outline"
            onClick={() => {
              setText(CSS_EXAMPLE)
              setMessage('')
            }}
          >
            Load example
          </Button>
          {value ? (
            <Button variant="outline" onClick={() => apply('')}>
              Remove CSS
            </Button>
          ) : null}
        </div>
        {message && (
          <p
            role={invalid ? 'alert' : 'status'}
            data-appearance-recipe="metadata"
          >
            {message}
          </p>
        )}
      </div>
    </details>
  )
}

function AppearanceImport({
  selection,
  mode: currentMode,
  life: currentLife,
  onModeChange,
}: {
  selection: AppearanceSelection
  mode: AppearanceMode | undefined
  life: boolean | undefined
  onModeChange: (mode: AppearanceMode) => void
}) {
  const [text, setText] = useState<string>()
  const [message, setMessage] = useState('')
  const [invalid, setInvalid] = useState(false)
  const { isCopied, copyToClipboard } = useCopyToClipboard({
    onError: () => {
      setInvalid(true)
      setMessage(
        'Could not copy current settings. Check clipboard access and try again.',
      )
    },
  })
  const documentValue = {
    version: APPEARANCE_VERSION,
    ...selection,
    mode: currentMode,
    life: currentLife,
  }
  const documentText = JSON.stringify(documentValue, null, 2)
  const apply = async () => {
    let candidate: unknown
    try {
      candidate = JSON.parse(text ?? documentText)
    } catch {
      setInvalid(true)
      setMessage('Enter valid JSON.')
      return
    }
    const parsed = appearanceDocumentSchema.safeParse(candidate)
    if (!parsed.success) {
      setInvalid(true)
      setMessage(
        parsed.error.issues
          .map(
            ({ path, message: issue }) =>
              `${path.join('.') || 'Appearance'} — ${issue}`,
          )
          .join(' '),
      )
      return
    }
    const { preset, overrides, mode, life } = parsed.data
    try {
      const calibrated = await calibrateOverrides(overrides)
      useAppearance.getState().loadSelection({ preset, overrides: calibrated })
      if (mode) onModeChange(mode)
      useLifeControls.setState({ shown: life })
      // Resume the live export, but keep edits made while calibration ran.
      setText((current) => (current === text ? undefined : current))
    } catch (error) {
      setInvalid(true)
      setMessage(error instanceof Error ? error.message : String(error))
      return
    }
    setInvalid(false)
    setMessage('Appearance settings applied.')
  }
  return (
    <details className="appearance-import rounded-lg border border-separator p-3">
      <summary className="cursor-pointer" data-appearance-recipe="ui.label">
        Custom appearance
      </summary>
      <div className="mt-3 flex min-w-0 flex-col gap-3">
        <p data-appearance-recipe="metadata" className="text-ink-muted">
          Edit or paste appearance settings as JSON. Custom colors must be
          opaque sRGB and meet the readability checks. Font profiles reference
          an installed font. The app measures the reading widths when you apply
          a profile. Copy current settings exports the active appearance without
          changing your JSON draft.
        </p>
        <Textarea
          className="w-full min-w-0 [&_textarea]:min-h-32"
          data-appearance-recipe="code"
          aria-label="Custom appearance JSON"
          value={text ?? documentText}
          onChange={(event) => setText(event.currentTarget.value)}
        />
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => void apply()}>Apply custom appearance</Button>
          <Button
            variant="outline"
            onClick={() => {
              setInvalid(false)
              setMessage('')
              void copyToClipboard(documentText)
            }}
          >
            {isCopied ? 'Current settings copied' : 'Copy current settings'}
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              setText(
                JSON.stringify(
                  {
                    ...documentValue,
                    overrides: {
                      ...selection.overrides,
                      font: {
                        textFamily: 'IBM Plex Sans Variable',
                      },
                    },
                  },
                  null,
                  2,
                ),
              )
              setMessage('')
            }}
          >
            Load font example
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              const example = Object.fromEntries(
                (['light', 'dark'] as const).map((mode) => [
                  mode,
                  resolvedColors(mode),
                ]),
              )
              setText(
                JSON.stringify(
                  {
                    ...documentValue,
                    overrides: {
                      ...selection.overrides,
                      palette: 'custom',
                      customPalette: { name: 'Custom palette', ...example },
                    },
                  },
                  null,
                  2,
                ),
              )
              setMessage('')
            }}
          >
            Load palette example
          </Button>
        </div>
        {message && (
          <p
            role={invalid ? 'alert' : 'status'}
            data-appearance-recipe="metadata"
          >
            {message}
          </p>
        )}
      </div>
    </details>
  )
}

function resolvedColors(mode: 'light' | 'dark') {
  const root = document.documentElement
  // Read emitted built-in rules directly so the current preset stays active.
  const names = new Set(Object.values(COLOR_ROLES))
  const fixed = CALM_COLORS[mode] as Record<string, string>
  const stylesheetRules = Array.from(document.styleSheets).flatMap((sheet) => {
    try {
      return Array.from(sheet.cssRules)
    } catch {
      return []
    }
  })
  const base = stylesheetRules.find(
    (rule) =>
      rule instanceof CSSStyleRule &&
      rule.selectorText === (mode === 'dark' ? '.dark' : ':root') &&
      rule.style.getPropertyValue('--redwood-hover'),
  ) as CSSStyleRule | undefined
  const fallback = getComputedStyle(root)
  return Object.fromEntries(
    [...names].map((name) => {
      const token = name === 'popover' ? 'surface-raised' : name
      return [
        name,
        fixed[token] ??
          (
            base?.style.getPropertyValue(`--${token}`) ||
            fallback.getPropertyValue(`--${token}`)
          ).trim(),
      ]
    }),
  )
}

async function calibrateOverrides(
  overrides: AppearanceInput,
): Promise<AppearanceOverrides> {
  if (!overrides.font) return appearanceOverridesSchema.parse(overrides)
  const font = customFontInputSchema.parse(overrides.font)
  await verifyFontFamily(font.textFamily)
  if (font.codeFamily) await verifyFontFamily(font.codeFamily)
  const sample = document.createElement('div')
  Object.assign(sample.style, {
    position: 'fixed',
    visibility: 'hidden',
    inset: '0 auto auto 0',
    width: 'max-content',
    whiteSpace: 'normal',
    margin: '0',
    padding: '0',
    font: `400 16px / 1.5 ${JSON.stringify(font.textFamily)}, var(--font-sans)`,
    fontKerning: 'normal',
    fontSynthesis: 'none',
    letterSpacing: 'normal',
    wordSpacing: 'normal',
  })
  const runs = LATIN_PROSE_V1_PARAGRAPHS.map((text) => {
    const run = document.createElement('span')
    run.style.display = 'table'
    run.textContent = text
    sample.append(run)
    return run
  })
  document.body.append(sample)
  try {
    const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' })
    const advance = runs.reduce(
      (total, run) => total + run.getBoundingClientRect().width,
      0,
    )
    const count = LATIN_PROSE_V1_PARAGRAPHS.reduce(
      (total, text) => total + Array.from(segmenter.segment(text)).length,
      0,
    )
    const measure = (target: number) =>
      Math.round((target * advance) / count / 4) / 4
    return appearanceOverridesSchema.parse({
      ...overrides,
      font: {
        ...font,
        comfortableMeasure: measure(80),
        wideMeasure: measure(100),
      },
    })
  } finally {
    sample.remove()
  }
}

async function verifyFontFamily(family: string) {
  const quoted = JSON.stringify(family)
  const probe = 'WmjQ 0185 Theorem reading profile'
  await document.fonts.load(`400 32px ${quoted}`, probe)
  await document.fonts.ready
  // FontFaceSet.load() can resolve to an empty array for both installed
  // and missing families. A rendered width change from a known fallback
  // confirms that the request has an effect on this browser.
  const canvas = document.createElement('canvas').getContext('2d')
  if (!canvas)
    throw new Error('This browser could not measure the custom font.')
  const width = (font: string) => {
    canvas.font = `400 32px ${font}`
    return canvas.measureText(probe).width
  }
  const found = ['monospace', 'serif'].some(
    (fallback) =>
      Math.abs(width(`${quoted}, ${fallback}`) - width(fallback)) > 0.01,
  )
  if (!found)
    throw new Error(`The font ${quoted} is unavailable on this device.`)
}
