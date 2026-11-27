// SOURCING: Shiki's bundled themes and Culori's CSS color parsing. Vitesse
// keeps its authored hierarchy on its own editor ground; adapted surfaces
// retain code-contrast.ts's contrast repair.
import { formatHex, parse } from 'culori'
import type { ThemeRegistration } from 'shiki/core'
import { readableCodeColor } from './code-contrast'

const opaqueColor = (color: string | undefined) => {
  const parsed = color && parse(color)
  return parsed && (parsed.alpha ?? 1) === 1 ? formatHex(parsed) : undefined
}

/** A bundled code theme placed on the surface that will actually paint it. */
export function codeThemeForSurface(
  name: string,
  base: ThemeRegistration,
  background: string,
): ThemeRegistration {
  const placedName = `${name} on ${background}`
  const nativeGround = opaqueColor(base.colors?.['editor.background'])
  if (
    (name === 'vitesse-dark' || name === 'vitesse-light') &&
    nativeGround !== undefined &&
    opaqueColor(background) === nativeGround
  ) {
    // Quiet punctuation and comments, including their alpha, are part of
    // Vitesse's design. Do not turn them into opaque, equally bright text.
    return { ...base, name: placedName }
  }

  const readable = (color: string) => readableCodeColor(color, background)
  return {
    ...base,
    name: placedName,
    colors: Object.fromEntries(
      Object.entries(base.colors ?? {}).map(([slot, color]) => [
        slot,
        slot === 'editor.foreground' ? readable(color) : color,
      ]),
    ),
    tokenColors: base.tokenColors?.map((rule) => ({
      ...rule,
      settings: {
        ...rule.settings,
        ...(rule.settings.foreground && {
          foreground: readable(rule.settings.foreground),
        }),
      },
    })),
  }
}
