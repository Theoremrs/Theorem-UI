// SOURCING: lib/appearance (the custom palette schema and its contrast pairs), lib/appearance-policy (the color roles), scripts/palettes' paletteTokens (a built-in palette's tokens as the generator places them), coss ui Input for the hex fields, the settings frame. The per-role color editor the interactive-responses plan asks for: the default palette's hues are a starting point, and every accent is the person's to change.
import { useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/coss/input'
import {
  SettingsBox,
  SettingsRow,
  SettingsSection,
} from '@/components/settings/settings-frame'
import {
  EDITABLE_COLOR_ROLES,
  useAppearance,
  appearanceOverridesSchema,
} from '@/lib/appearance'
import type { AppearanceOverrides } from '@/lib/appearance'
import { COLOR_ROLES } from '@/lib/appearance-policy'
import { paletteTokens } from '../../../scripts/palettes'

type Mode = 'light' | 'dark'
type Colors = Record<string, string>

const TOKENS = [...new Set(Object.values(COLOR_ROLES))]

/** The active palette's full token set in one mode: a custom palette being
 *  edited, or the built-in the person is looking at, as the page paints it. */
function seedColors(mode: Mode, overrides: AppearanceOverrides): Colors {
  const custom = overrides.customPalette?.[mode]
  const builtin = paletteTokens(
    overrides.palette && overrides.palette !== 'custom'
      ? overrides.palette
      : 'ember',
  )
  const tokens = builtin?.[mode] ?? {}
  return Object.fromEntries(
    TOKENS.map((token) => [
      token,
      custom?.[token] ??
        tokens[token] ??
        (mode === 'light' ? '#ffffff' : '#000000'),
    ]),
  )
}

/** The token an editable row paints. The raised surface is the popover
 *  token in the custom-palette contract (COLOR_ROLES), so that row edits
 *  `popover`; every other row edits its own name. */
const rowToken = (token: string) =>
  token === 'surface-raised' ? 'popover' : token

/**
 * The palette's colors, one row per role, in both display modes. Edits are
 * held locally until Apply, which validates the whole palette against the
 * registered contrast pairs (lib/appearance) — the same gate an imported
 * appearance passes — and then selects it as the custom palette.
 */
export function PaletteColors() {
  const { appearance, overrides, setOverrides } = useAppearance()
  const [draft, setDraft] = useState<{ light: Colors; dark: Colors }>()
  const [message, setMessage] = useState('')
  const [invalid, setInvalid] = useState(false)
  const colors = useMemo(
    () =>
      draft ?? {
        light: seedColors('light', overrides),
        dark: seedColors('dark', overrides),
      },
    [draft, overrides],
  )
  /** What a row shows: its own token, or the popover token for the raised
   *  surface (the custom-palette contract names it `popover`). */
  const shown = (mode: Mode, token: string) =>
    colors[mode][rowToken(token)] ?? ''
  const edit = (mode: Mode, token: string, value: string) => {
    const key = rowToken(token)
    setDraft({ ...colors, [mode]: { ...colors[mode], [key]: value } })
    setMessage('')
    setInvalid(false)
  }
  const apply = () => {
    const parsed = appearanceOverridesSchema.safeParse({
      ...overrides,
      palette: 'custom',
      customPalette: {
        name: overrides.customPalette?.name ?? 'Custom palette',
        light: colors.light,
        dark: colors.dark,
      },
    })
    if (!parsed.success) {
      setInvalid(true)
      setMessage(
        [...new Set(parsed.error.issues.map((issue) => issue.message))].join(
          ' ',
        ),
      )
      return
    }
    setOverrides(parsed.data)
    setDraft(undefined)
    setInvalid(false)
    setMessage('Custom palette applied.')
  }
  const reset = () => {
    setDraft(undefined)
    setMessage('')
    setInvalid(false)
    if (appearance.palette === 'custom')
      setOverrides({ palette: 'ember', customPalette: undefined })
  }
  return (
    <SettingsSection
      title="Palette colors"
      description="Every color of the palette, in both display modes. Edits apply as a custom palette; contrast is checked before anything is painted."
      action={
        <div className="flex gap-2">
          <Button size="sm" onClick={apply}>
            Apply colors
          </Button>
          <Button size="sm" variant="outline" onClick={reset}>
            Reset
          </Button>
        </div>
      }
    >
      <SettingsBox>
        {EDITABLE_COLOR_ROLES.map(({ token, label, hint }) => (
          <SettingsRow key={token} title={label} description={hint}>
            <div className="flex items-center gap-2">
              {(['light', 'dark'] as const).map((mode) => (
                <label key={mode} className="flex items-center gap-1.5">
                  <span
                    aria-hidden
                    className="size-5 shrink-0 rounded-sm border border-separator"
                    style={{ background: shown(mode, token) }}
                  />
                  <Input
                    size="sm"
                    className="w-24 font-mono"
                    aria-label={`${label}, ${mode}`}
                    spellCheck={false}
                    value={shown(mode, token)}
                    onChange={(event) =>
                      edit(mode, token, event.currentTarget.value)
                    }
                  />
                </label>
              ))}
            </div>
          </SettingsRow>
        ))}
      </SettingsBox>
      {message && (
        <p
          role={invalid ? 'alert' : 'status'}
          data-appearance-recipe="metadata"
          className={invalid ? 'text-error-ink' : 'text-ink-muted'}
        >
          {message}
        </p>
      )}
    </SettingsSection>
  )
}
