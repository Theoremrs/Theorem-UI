// SOURCING: culori (OKLCH conversion, gamut clamping, WCAG contrast, hex output), the library terminal-theme.ts and terminal-roles.ts already derive every terminal colour with.
//
// The neutral surface ladder and semantic registers every terminal draws in,
// derived per palette by ONE rule from the colours the palette's terminal
// roles already have: its background, raised surface, bright, muted, mark and
// state hues. `ladderPalette` is what the page sends the Rust terminal
// (terminal-screen.tsx `loadWasm`): the role palette of `wasmPalette` with the
// ladder's values laid over it. The owner chose it as the default on
// 2026-11-15, from renders of all six themes (LEDGER L27).
//
// The rule, in OKLCH, so every palette steps the same way:
// - surfaces: the panel is the palette's own background. The canvas, where the
//   conversation sits, is a step below it (CANVAS_STEP in lightness). The raised
//   surface is the palette's own. The selected band is a step above the raised
//   surface (SELECTED_STEP). Each keeps its source's hue and chroma, so a warm
//   palette stays warm and a cool one cool, and the four are told apart by
//   lightness alone, by the same amount on every palette.
// - text: primary, body, secondary and disabled keep the hue and chroma of the
//   palette's bright, text and muted, and are placed in lightness where they
//   just read on the lightest surface (the selected band) at their READ
//   contrast, never darker than the palette has them. Because the selected band
//   is the lightest surface, they read at least that well on every darker one.
//   Primary and body sit where pi's do, about 0.95 and 0.90 of lightness
//   (owner, 2026-11-22: beside pi our text read dull). Markdown headings are
//   gold, as pi's are: the approval register (owner, 2026-11-22).
// - lines (table borders, guides, the prompt box, the header's rule) keep the
//   palette's line hue and are lifted to WCAG's 3:1 for a component's edge.
// - registers (informational, success, approval, failure): the hues the
//   palette's own state colours have, all four at one lightness and one chroma
//   (REGISTER_CHROMA, gamut-clamped), the lightness where the weakest of them
//   reads at REGISTER contrast on the selected band. One weight, so no state
//   shouts louder than another and colour is never the only signal.
// - diff rows: GitHub Dark's hues (as terminal-theme.ts keeps them) at one
//   lightness step above the panel and one chroma, lowered until every code
//   colour still reads on them; their gutter marks are the success and failure
//   registers.
// - tool calls: the one ground besides the diff rows and the selected row. As
//   pi draws its calls, a call's block is the canvas with its hue turned to the
//   palette's brand mark and lifted one small step (CALL), at the saturation
//   pi's has, so it changes hue rather than gaining colour or light; its target
//   is in the brand mark, lifted to read at READ.call on it (owner, 2026-11-22:
//   the brand mark over the terminal accent, so each palette's calls carry its
//   own colour).
// - no other band: a call's state, a running command, the person's own words
//   and code are told by their text's colour on the canvas.
// - brand: the palette's mark, lifted in lightness only if it does not read on
//   the selected band. It colours the text of what is relevant, never a band.
import { clampChroma, converter, formatHex, wcagContrast } from 'culori'
import type { Oklch } from 'culori'
import { wasmPalette } from './terminal-roles'
import type { TerminalRoles } from './terminal-roles'
import { CANVAS_STEP, canvasOf } from './terminal-theme'

export { CANVAS_STEP }

const oklch = converter('oklch')

/** Lightness the selected band sits above the raised surface; the canvas's step below the panel is terminal-theme.ts's. */
export const SELECTED_STEP = 0.06
/**
 * The contrast (WCAG 2) each register of text is placed at on the selected
 * band, the lightest surface; a call's target is placed on its block. primary,
 * body, register and call put the text where pi's is in lightness; line is
 * WCAG's 3:1 for a component's edge.
 */
export const READ = {
  primary: 10,
  body: 8.5,
  secondary: 5,
  disabled: 3.2,
  register: 7,
  call: 7.5,
  line: 3,
  brand: 4.5,
} as const
/** Every register shares this chroma (where sRGB allows) and one lightness. */
export const REGISTER_CHROMA = 0.1
/** A tinted row's lightness above the panel and its chroma, and GitHub Dark's red and green hues for the diff rows. */
export const DIFF_ROW = {
  step: 0.05,
  chroma: 0.045,
  hue: { added: 146.3, removed: 26.8 },
} as const
/**
 * A tool call's block: the canvas's lightness raised `step`, in the brand
 * mark's hue, at a chroma of `saturation` times its lightness. pi's block is its
 * canvas raised 0.03, at chroma 0.025 against lightness 0.303, the same
 * saturation as the canvas under it: a turn of hue, not more colour or light.
 */
export const CALL = { step: 0.03, saturation: 0.025 / 0.303 } as const
/** What the diff rows' text must still read at. */
const ROW_TEXT = 4.5

const at = (colour: string): Oklch => {
  const parsed = oklch(colour)
  if (!parsed) throw new Error(`not a colour: ${colour}`)
  return { ...parsed, h: parsed.h ?? 0 }
}
const hex = (colour: Oklch) => formatHex(clampChroma(colour, 'oklch'))

/** The lowest lightness (from `from` up) at which every colour made by `make` reads on `surface` at `ratio`. */
function lowestReading(
  make: (l: number) => string[],
  surface: string,
  ratio: number,
  from: number,
): number {
  const reads = (l: number) =>
    make(l).every((colour) => wcagContrast(colour, surface) >= ratio)
  if (reads(from)) return from
  let low = from
  let high = 1
  for (let i = 0; i < 30; i++) {
    const mid = (low + high) / 2
    if (reads(mid)) high = mid
    else low = mid
  }
  return high
}

/** `colour`'s hue and chroma at lightness `l`. */
const withL = (colour: Oklch, l: number, c = colour.c): Oklch => ({
  ...colour,
  l,
  c,
})

/** `colour` lifted in lightness, keeping its hue and chroma, until it reads on `surface` at `ratio`. */
const lift = (colour: string, surface: string, ratio: number) => {
  const c = at(colour)
  return hex(
    withL(c, lowestReading((l) => [hex(withL(c, l))], surface, ratio, c.l)),
  )
}

export type Ladder = {
  surfaces: {
    canvas: string
    panel: string
    raised: string
    selected: string
    diffAddition: string
    diffDeletion: string
    call: string
  }
  /** Table borders, guides, the prompt box and the header's rule. */
  line: string
  text: {
    primary: string
    body: string
    secondary: string
    disabled: string
    call: string
  }
  registers: {
    informational: string
    success: string
    approval: string
    failure: string
  }
  brand: string
}

/** The ladder for one palette's terminal roles. */
export function terminalLadder(roles: TerminalRoles): Ladder {
  const { chrome, state, syntax } = roles
  const panel = at(chrome.bg)
  const raised = at(chrome.raised)
  const canvas = canvasOf(chrome.bg)
  const selected = hex(withL(raised, raised.l + SELECTED_STEP))

  const muted = at(chrome.muted)
  const text = (ratio: number) =>
    hex(
      withL(
        muted,
        lowestReading((l) => [hex(withL(muted, l))], selected, ratio, muted.l),
      ),
    )
  const secondary = text(READ.secondary)
  const disabled = text(READ.disabled)
  // The disabled text is never lighter than the secondary: the two are one hue and chroma
  // placed by contrast, secondary at the higher one.
  const primary = lift(chrome.bright, selected, READ.primary)
  const body = lift(chrome.text, selected, READ.body)
  const line = lift(chrome.line, selected, READ.line)

  const hues = {
    informational: at(state.link).h!,
    success: at(state.success).h!,
    approval: at(state.approval).h!,
    failure: at(state.error).h!,
  }
  const registerAt = (l: number) =>
    Object.fromEntries(
      Object.entries(hues).map(([name, h]) => [
        name,
        hex({ mode: 'oklch', l, c: REGISTER_CHROMA, h }),
      ]),
    ) as Ladder['registers']
  const registerL = lowestReading(
    (l) => Object.values(registerAt(l)),
    selected,
    READ.register,
    0.5,
  )
  const registers = registerAt(registerL)

  const mark = at(chrome.mark)
  const brand = hex(
    withL(
      mark,
      lowestReading((l) => [hex(withL(mark, l))], selected, READ.brand, mark.l),
    ),
  )

  const callL = at(canvas).l + CALL.step
  const call = hex({
    mode: 'oklch',
    l: callL,
    c: CALL.saturation * callL,
    h: mark.h,
  })
  // pi's call target is in its block's hue; this one too, lifted to read as brightly.
  const callText = lift(brand, call, READ.call)

  const texts = [
    chrome.text,
    chrome.bright,
    chrome.muted,
    ...Object.values(syntax),
  ]
  const row = (h: number) => {
    let l = panel.l + DIFF_ROW.step
    const tint = (lightness: number) =>
      hex({ mode: 'oklch', l: lightness, c: DIFF_ROW.chroma, h })
    while (
      !texts.every((colour) => wcagContrast(colour, tint(l)) >= ROW_TEXT) &&
      l > panel.l
    )
      l -= 0.0005
    return tint(l)
  }

  return {
    surfaces: {
      canvas,
      panel: chrome.bg,
      raised: chrome.raised,
      selected,
      diffAddition: row(DIFF_ROW.hue.added),
      diffDeletion: row(DIFF_ROW.hue.removed),
      call,
    },
    line,
    text: { primary, body, secondary, disabled, call: callText },
    registers,
    brand,
  }
}

/**
 * What the Rust terminal reads (terminal/src/lib.rs `Palette`): the role
 * palette of `wasmPalette` with the ladder laid over it.
 */
export function ladderPalette(roles: TerminalRoles) {
  const ladder = terminalLadder(roles)
  const { surfaces, line, text, registers, brand } = ladder
  return {
    ...wasmPalette(roles),
    // Roles of the base palette that take the ladder's value.
    ink: text.body,
    bright: text.primary,
    heading: text.primary,
    line,
    muted: text.secondary,
    disabled: text.disabled,
    success: registers.success,
    error: registers.failure,
    warning: registers.approval,
    approval: registers.approval,
    // The transcript's Markdown headings.
    gold: registers.approval,
    link: registers.informational,
    mark: brand,
    addedLine: surfaces.diffAddition,
    removedLine: surfaces.diffDeletion,
    // Roles the ladder adds.
    canvas: surfaces.canvas,
    selectedRow: surfaces.selected,
    // A finished call's name is the primary text, bold, on its block.
    completedInk: text.primary,
    call: surfaces.call,
    callInk: text.call,
    info: registers.informational,
    textDisabled: text.disabled,
    diffAddedMark: registers.success,
    diffRemovedMark: registers.failure,
  }
}
