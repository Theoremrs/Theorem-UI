// SOURCING: culori (OKLCH conversion, gamut clamping, WCAG contrast, hex output), the library terminal-theme.ts and terminal-roles.ts already derive every terminal colour with.
//
// The proposed neutral ladder and semantic registers for the workbench
// (the "Delta-parity" proposal), derived per palette by ONE rule from the
// colours the palette's terminal already has: its background, raised surface,
// bright, muted, mark and state hues. It is opt-in: `proposedPalette` is the
// legacy palette the Rust terminal reads (wasmPalette) with the proposal's
// values laid over it; a page that never calls it draws what it always drew.
//
// The rule, in OKLCH, so every palette steps the same way:
// - surfaces: the panel is the palette's own background. The canvas, where the
//   conversation sits, is a step below it (CANVAS_STEP in lightness). The raised
//   surface is the palette's own. The selected band is a step above the raised
//   surface (SELECTED_STEP). Each keeps its source's hue and chroma, so a warm
//   palette stays warm and a cool one cool, and the four are told apart by
//   lightness alone, by the same amount on every palette.
// - text: primary is the palette's bright; secondary and disabled keep the
//   muted's hue and chroma and are placed in lightness where they just read on
//   the lightest surface (the selected band) at SECONDARY / DISABLED contrast,
//   never darker than the muted already is. Because the selected band is the
//   lightest surface, they read at least that well on every darker one.
// - registers (informational, success, approval, failure): the hues the
//   palette's own state colours have, all four at one lightness and one chroma
//   (REGISTER_CHROMA, gamut-clamped), the lightness where the weakest of them
//   reads at REGISTER contrast on the selected band. One weight, so no state
//   shouts louder than another and colour is never the only signal.
// - diff rows: GitHub Dark's hues (as terminal-theme.ts keeps them) at one
//   lightness step above the panel and one chroma, lowered until every code
//   colour still reads on them; their gutter marks are the success and failure
//   registers.
// - decision rows: a tool call that waits on the person, and one that failed,
//   sit on a ground tinted the same way from the approval and failure hues, so
//   neither is mistaken for the running block or for a selected row.
// - brand: the palette's mark, lifted in lightness only if it does not read on
//   the selected band. It colours the text of what is relevant, never a band.
import { clampChroma, converter, formatHex, wcagContrast } from 'culori'
import type { Oklch } from 'culori'
import { wasmPalette } from './terminal-roles'
import type { TerminalRoles } from './terminal-roles'

const oklch = converter('oklch')

/** Lightness the canvas sits below the panel, and the selected band above the raised surface. */
export const CANVAS_STEP = -0.06
export const SELECTED_STEP = 0.06
/** The contrast (WCAG 2) each register of text is placed at on the selected band, the lightest surface. */
export const READ = {
  primary: 7,
  secondary: 5,
  disabled: 3.2,
  register: 5.5,
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

export type Ladder = {
  surfaces: {
    canvas: string
    panel: string
    raised: string
    selected: string
    diffAddition: string
    diffDeletion: string
    /** A tool call waiting on the person's decision, and one that failed. */
    approvalRow: string
    failureRow: string
  }
  text: { primary: string; body: string; secondary: string; disabled: string }
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
  const canvas = hex(withL(panel, panel.l + CANVAS_STEP))
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
  const primary = hex(
    withL(
      at(chrome.bright),
      lowestReading(
        (l) => [hex(withL(at(chrome.bright), l))],
        selected,
        READ.primary,
        at(chrome.bright).l,
      ),
    ),
  )

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
      lowestReading(
        (l) => [hex(withL(mark, l))],
        selected,
        READ.brand,
        mark.l,
      ),
    ),
  )

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
      approvalRow: row(hues.approval),
      failureRow: row(hues.failure),
    },
    text: { primary, body: chrome.text, secondary, disabled },
    registers,
    brand,
  }
}

/**
 * What the Rust terminal reads (terminal/src/lib.rs `Palette`): the legacy
 * palette of `wasmPalette` with the ladder laid over it. Replacing the
 * default with the proposal is `loadWasm` sending this instead of
 * `wasmPalette(roles)`.
 */
export function proposedPalette(roles: TerminalRoles) {
  const ladder = terminalLadder(roles)
  const { surfaces, text, registers, brand } = ladder
  return {
    ...wasmPalette(roles),
    // Existing roles that take the proposal's value.
    bright: text.primary,
    muted: text.secondary,
    disabled: text.disabled,
    success: registers.success,
    error: registers.failure,
    warning: registers.approval,
    approval: registers.approval,
    gold: registers.approval,
    link: registers.informational,
    mark: brand,
    addedLine: surfaces.diffAddition,
    removedLine: surfaces.diffDeletion,
    // Roles the proposal adds.
    canvas: surfaces.canvas,
    selectedRow: surfaces.selected,
    // A finished call is recessive: no block and a secondary name. The running one is the
    // neutral block. One that waits on a decision, or failed, is on its own tinted ground.
    completedRow: surfaces.canvas,
    runningRow: surfaces.raised,
    pendingRow: surfaces.approvalRow,
    failedRow: surfaces.failureRow,
    completedInk: text.secondary,
    info: registers.informational,
    textDisabled: text.disabled,
    diffAddedMark: registers.success,
    diffRemovedMark: registers.failure,
  }
}
