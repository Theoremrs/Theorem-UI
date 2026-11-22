// SOURCING: culori (parse, OKLCH to sRGB, WCAG contrast), as components/terminal/terminal-theme.ts uses it; the grain colour and the ink share are lib/face/identity's and ./painter's INK, so the contrast here is of the colours the painter makes. Which of the two looks the face has (light matter on a dark body, or ink on a light one) is the existing FaceLook's; this only chooses between them from a surface's colours.
import { converter, formatHex, parse, wcagContrast } from 'culori'
import { THEO } from '@/lib/face/identity'
import type { FaceLook } from '@/lib/figures'
import { INK } from './painter'

const rgb = converter('rgb')

/** How Theo is drawn on a terminal surface, from the surface's own colours. */
export interface TerminalFace {
  /** The body (plate) colour, as `#rrggbb`: the surface's ink, so it reads on the surface. */
  body: string
  /** The look to draw with: always the plate; its matter is ink (dark) on a light body, light on a dark one. */
  look: FaceLook
  /**
   * The matter is ink over the whole body, so the plate never draws in to a ball
   * behind an orb (it is ink off the plate there, and the plate would hide it).
   */
  flat: boolean
  /** WCAG contrast of the body on the surface. */
  bodyOnSurface: number
  /** WCAG contrast of the eyes (matter as drawn, fully covered) on the body. */
  eyesOnBody: number
}

/** The eye as the painter draws it: light is the grain's colour, ink is the grain's colour with the light taken out. */
function eyes(hue: number) {
  const light = rgb({
    mode: 'oklch',
    l: THEO.lightness,
    c: THEO.chroma,
    h: hue,
  })
  const ink = { ...light, r: light.r * INK, g: light.g * INK, b: light.b * INK }
  return { light, ink }
}

/**
 * Theo for a terminal surface. The body takes the surface's ink; the eyes are
 * whichever of light and ink has more contrast against it. On a dark
 * terminal that is a light body with dark eyes (the inverse of the chat
 * face); on a light one it is the chat face's own dark body with light eyes.
 * A palette neither of those suits (mid tones) gets the better of the two,
 * and the numbers say how good that is.
 */
export function terminalFace(
  surface: string,
  ink: string,
  hue: number = THEO.hue,
): TerminalFace {
  const ground = parse(surface)
  const body = parse(ink)
  if (!ground || !body) throw new Error(`Not a colour: ${surface} or ${ink}`)
  const matter = eyes(hue)
  const onInk = wcagContrast(matter.ink, body)
  const onLight = wcagContrast(matter.light, body)
  const inked = onInk >= onLight
  return {
    body: formatHex(body),
    look: { visor: true, ink: inked, paper: false },
    flat: inked,
    bodyOnSurface: wcagContrast(body, ground),
    eyesOnBody: inked ? onInk : onLight,
  }
}
