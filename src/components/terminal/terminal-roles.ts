// SOURCING: culori (OKLab/OKLCH conversion, gamut clamping, WCAG contrast,
// hex output); terminal-theme.ts's terminalTheme, the one projection of the
// workspace into terminal colours; @tanstack/highlight's githubDarkTheme for
// the code colours the terminal draws; terminal/src/preview/palette.rs's
// REFERENCE, the illustration palette P⁰ every pixel preview is indexed in.
//
// The complete terminal role contract (SPEC-THEOREM-ARTIFACT-CABINET-1.0 §7,
// procedural-pixel-previews.md §8): chrome, state, syntax, diff and
// illustration roles resolved together, from one workspace snapshot, by one
// adapter that both the Cabinet and the Terminal read. terminalTheme places
// the surfaces, text and diff tints; this module names their roles, places
// the roles the old contract lacked (success, link, syntax, selection,
// focus, disabled, the illustration palette), verifies every required pair as
// actually rendered, repairs what fails, and falls back to the known valid
// dark profile, with a diagnostic, when repair cannot make it read.
//
// No role privileges a hue: headings are the bright text in bold, the prompt
// and focus take the accent, and amber is the warning family only.
import { githubDarkTheme } from '@tanstack/highlight/themes/github-dark'
import { clampChroma, converter, formatHex, wcagContrast } from 'culori'
import type { Oklab, Oklch } from 'culori'
import { LINK, SLATE, SUCCESS, terminalTheme } from './terminal-theme'
import type { TerminalTheme, Workspace } from './terminal-theme'

const oklch = converter('oklch')
const oklab = converter('oklab')

/** Bumped whenever a rule here changes what a role resolves to. */
export const ROLES_VERSION = 2

/** Readable normal text, and essential nontext indicators (WCAG 1.4.3, 1.4.11). */
export const TEXT_RATIO = 4.5
export const INDICATOR_RATIO = 3

/**
 * The illustration reference palette P⁰, in index order: Flexoki's
 * (terminal/src/preview/palette.rs REFERENCE; terminal-roles.test.ts holds
 * the two equal). Indices are made against these and never change with the
 * theme; only the colours they are shown in do.
 */
export const ILLUSTRATION_REFERENCE = [
  '#100f0f', '#1c1b1a', '#403e3c', '#6f6e69', '#9f9d96', '#cecdc3', '#f2f0e5', '#fffcf0',
  '#f89a8a', '#d14d41', '#942822', '#f9ae77', '#da702c', '#9d4310', '#eccb60', '#d0a215',
  '#8e6b01', '#bec97e', '#879a39', '#536907', '#87d3c3', '#3aa99f', '#1c6c66', '#92bfdb',
  '#4385be', '#1a4f8c', '#c4b9e0', '#8b7ec8', '#4f3685', '#f4a4c2', '#ce5d97', '#87285e',
] as const // prettier-ignore

/** The syntax roles, one per class TanStack Highlight's github-dark emits. */
const SYNTAX_SOURCE = {
  keyword: githubDarkTheme.tokens.keyword,
  string: githubDarkTheme.tokens.string,
  number: githubDarkTheme.tokens.number,
  function: githubDarkTheme.tokens.function,
  variable: githubDarkTheme.tokens.variable,
  type: githubDarkTheme.tokens.type,
  tag: githubDarkTheme.tokens.tag,
  comment: githubDarkTheme.tokens.comment,
} as const
export type SyntaxRole = keyof typeof SYNTAX_SOURCE

export type TerminalRoles = {
  version: number
  /** One identity for every colour below; previews record it (§7.2). */
  revision: string
  mode: 'dark' | 'light'
  chrome: {
    bg: string
    raised: string
    /** The matte pixel previews sit on, a step below the background. */
    deep: string
    line: string
    text: string
    bright: string
    muted: string
    /** Headings: the bright text, drawn bold. Never a status hue. */
    heading: string
    /** Prompt, caret, progress and the selected card's border. */
    accent: string
    focus: string
    /** The letters of the thing that is chosen or matched. */
    mark: string
    selection: string
    disabled: string
    /** The prompt's cursor while the terminal is not focused. */
    idle: string
  }
  state: {
    error: string
    warning: string
    success: string
    link: string
    /** An approval waiting on the person: the warning family. */
    approval: string
  }
  syntax: Record<SyntaxRole, string>
  diff: {
    removedLine: string
    addedLine: string
    removedWords: string
    addedWords: string
    commentOnWords: string
  }
  /** Pᵗ = T(P⁰): the illustration palette pixel previews are shown in. */
  illustration: string[]
  /** Every role that a rule had to move to read, and any fallback taken. */
  diagnostics: string[]
}

const at = (colour: string): Oklch => {
  const parsed = oklch(colour)
  if (!parsed) throw new Error(`not a colour: ${colour}`)
  return { ...parsed, h: parsed.h ?? 0 }
}
const hex = (colour: Oklch | Oklab) =>
  formatHex(clampChroma(colour, colour.mode))

/**
 * The lightest `colour` needs to be, lightness only, to read at `ratio` on
 * every surface; undefined when no lightness does.
 */
function readable(colour: string, surfaces: string[], ratio: number) {
  const c = at(colour)
  const reads = (l: number) =>
    surfaces.every((s) => wcagContrast(hex({ ...c, l }), s) >= ratio)
  if (reads(c.l)) return colour
  // Dark surfaces: lighten. A light surface would darken, but the terminal
  // surfaces terminalTheme places are dark in every workspace.
  if (!reads(1)) return undefined
  let low = c.l
  let high = 1
  for (let i = 0; i < 30; i++) {
    const mid = (low + high) / 2
    if (reads(mid)) high = mid
    else low = mid
  }
  return hex({ ...c, l: high })
}

/**
 * §7.3: P⁰ carried onto the terminal by its own relationships. Lightness
 * keeps each colour's place between the reference's black and paper, now
 * between the terminal's deep matte and paper; (a,b) keeps its offset from
 * the reference black around the matte's own (κ = 1, no rotation: the dark
 * profile authors none). Then gamut-clamped in OKLCH, not channel-clipped.
 */
export function projectIllustration(deep: string): string[] {
  const bg0 = oklab(ILLUSTRATION_REFERENCE[0])!
  const fg0 = oklab(ILLUSTRATION_REFERENCE[7])!
  const bgT = oklab(deep)!
  const fgT = fg0
  return ILLUSTRATION_REFERENCE.map((colour) => {
    const r = oklab(colour)!
    const t = (r.l - bg0.l) / (fg0.l - bg0.l)
    return hex({
      mode: 'oklab',
      l: bgT.l + t * (fgT.l - bgT.l),
      a: bgT.a + (r.a - bg0.a),
      b: bgT.b + (r.b - bg0.b),
    })
  })
}

/** A short, stable identity for a set of colours. */
function digest(text: string) {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

/** A pair a rendered surface needs: foreground role, background, threshold. */
export type RequiredPair = {
  role: string
  on: string
  fg: string
  bg: string
  ratio: number
}

/** Every foreground/background pair the terminal and cabinet draw, with its threshold. */
export function requiredPairs(roles: TerminalRoles): RequiredPair[] {
  const { chrome, state, syntax, diff } = roles
  const surfaces: Record<string, string> = {
    bg: chrome.bg,
    raised: chrome.raised,
  }
  const pairs: RequiredPair[] = []
  const text = (role: string, fg: string, on = surfaces) => {
    for (const [name, bg] of Object.entries(on))
      pairs.push({ role, on: name, fg, bg, ratio: TEXT_RATIO })
  }
  text('chrome.text', chrome.text)
  text('chrome.bright', chrome.bright)
  text('chrome.muted', chrome.muted)
  text('chrome.heading', chrome.heading)
  text('chrome.accent', chrome.accent)
  text('chrome.mark', chrome.mark)
  for (const [name, fg] of Object.entries(state)) text(`state.${name}`, fg)
  for (const [name, fg] of Object.entries(syntax)) text(`syntax.${name}`, fg)
  const rows = { removedLine: diff.removedLine, addedLine: diff.addedLine }
  text('chrome.text', chrome.text, rows)
  for (const [name, fg] of Object.entries(syntax))
    text(`syntax.${name}`, fg, rows)
  const words = { removedWords: diff.removedWords, addedWords: diff.addedWords }
  text('chrome.text', chrome.text, words)
  text('diff.commentOnWords', diff.commentOnWords, words)
  for (const [name, fg] of Object.entries(syntax))
    if (name !== 'comment') text(`syntax.${name}`, fg, words)
  // Essential indicators: the focus ring and selected border on their surface.
  for (const [role, fg] of [
    ['chrome.focus', chrome.focus],
    ['chrome.accent', chrome.accent],
  ] as const)
    for (const [name, bg] of Object.entries(surfaces))
      pairs.push({ role, on: name, fg, bg, ratio: INDICATOR_RATIO })
  return pairs
}

/** The pairs that fail, by unrounded ratio: a near miss is a miss. */
export function failingPairs(roles: TerminalRoles) {
  return requiredPairs(roles)
    .map((pair) => ({ ...pair, actual: wcagContrast(pair.fg, pair.bg) }))
    .filter((pair) => pair.actual < pair.ratio)
}

/** The roles from terminalTheme's colours, repairing what does not read. */
function resolve(theme: TerminalTheme, dark: boolean): TerminalRoles {
  const diagnostics: string[] = []
  const surfaces = [theme.bg, theme.raised]
  const role = (name: string, colour: string, on = surfaces) => {
    const placed = readable(colour, on, TEXT_RATIO)
    if (placed === undefined) {
      diagnostics.push(`${name}: no lightness reads at ${TEXT_RATIO}:1`)
      return colour
    }
    if (placed !== colour) diagnostics.push(`${name}: lifted to read`)
    return placed
  }
  const diffSurfaces = [
    ...surfaces,
    theme.removedLine,
    theme.addedLine,
    theme.removedWords,
    theme.addedWords,
  ]
  const syntax = Object.fromEntries(
    Object.entries(SYNTAX_SOURCE).map(([name, colour]) => [
      name,
      role(
        `syntax.${name}`,
        colour,
        name === 'comment'
          ? surfaces.concat(theme.removedLine, theme.addedLine)
          : diffSurfaces,
      ),
    ]),
  ) as Record<SyntaxRole, string>
  const bg = at(theme.bg)
  const deep = hex({ ...bg, l: Math.max(0.12, bg.l - 0.06) })
  const roles: Omit<TerminalRoles, 'revision'> = {
    version: ROLES_VERSION,
    mode: dark ? 'dark' : 'light',
    chrome: {
      bg: theme.bg,
      raised: theme.raised,
      deep,
      line: theme.line,
      text: role('chrome.text', theme.ink, diffSurfaces),
      bright: role('chrome.bright', theme.bright),
      muted: role('chrome.muted', theme.muted),
      heading: role('chrome.heading', theme.bright),
      accent: role('chrome.accent', theme.sage),
      focus: role('chrome.focus', theme.sage),
      mark: role('chrome.mark', theme.mark),
      selection: theme.raised,
      disabled: theme.idle,
      idle: theme.idle,
    },
    state: {
      error: role('state.error', theme.error),
      warning: role('state.warning', theme.gold),
      success: role('state.success', SUCCESS),
      link: role('state.link', LINK),
      approval: role('state.approval', theme.gold),
    },
    syntax,
    diff: {
      removedLine: theme.removedLine,
      addedLine: theme.addedLine,
      removedWords: theme.removedWords,
      addedWords: theme.addedWords,
      commentOnWords: role('diff.commentOnWords', theme.commentOnWords, [
        theme.removedWords,
        theme.addedWords,
      ]),
    },
    illustration: projectIllustration(deep),
    diagnostics,
  }
  const { diagnostics: _, ...colours } = roles
  return { ...roles, revision: digest(JSON.stringify(colours)) }
}

/** The known valid dark profile: pi's slate, whose roles all read. */
export const FALLBACK_ROLES = resolve(SLATE, true)

/**
 * The workspace's complete terminal role contract. A workspace whose roles
 * cannot all be made to read, or whose tokens are not colours, takes the
 * same-mode known valid profile instead, and says so in its diagnostics.
 */
export function terminalRoles(workspace: Workspace): TerminalRoles {
  let roles: TerminalRoles
  try {
    const dark = at(workspace['sheet-from']).l < 0.5
    roles = resolve(terminalTheme(workspace), dark)
  } catch (error) {
    return {
      ...FALLBACK_ROLES,
      diagnostics: [
        `fallback: ${error instanceof Error ? error.message : String(error)}`,
      ],
    }
  }
  const failing = failingPairs(roles)
  if (failing.length === 0) return roles
  return {
    ...FALLBACK_ROLES,
    diagnostics: [
      ...roles.diagnostics,
      ...failing.map(
        (p) => `${p.role} on ${p.on}: ${p.actual.toFixed(3)} < ${p.ratio}`,
      ),
      'fallback: the dark slate profile',
    ],
  }
}

/**
 * What the WASM terminal reads (terminal/src/lib.rs Palette): the legacy
 * keys through one compatibility map, and the role keys beside them.
 */
export function wasmPalette(roles: TerminalRoles) {
  const { chrome, state, syntax, diff } = roles
  return {
    bg: chrome.bg,
    raised: chrome.raised,
    line: chrome.line,
    ink: chrome.text,
    bright: chrome.bright,
    muted: chrome.muted,
    idle: chrome.idle,
    // Compatibility: `sage` and `gold` callers read the accent and warning.
    sage: chrome.accent,
    gold: state.warning,
    error: state.error,
    removedLine: diff.removedLine,
    addedLine: diff.addedLine,
    removedWords: diff.removedWords,
    addedWords: diff.addedWords,
    commentOnWords: diff.commentOnWords,
    heading: chrome.heading,
    accent: chrome.accent,
    focus: chrome.focus,
    mark: chrome.mark,
    selection: chrome.selection,
    disabled: chrome.disabled,
    deep: chrome.deep,
    warning: state.warning,
    success: state.success,
    link: state.link,
    approval: state.approval,
    syntaxKeyword: syntax.keyword,
    syntaxString: syntax.string,
    syntaxNumber: syntax.number,
    syntaxFunction: syntax.function,
    syntaxVariable: syntax.variable,
    syntaxType: syntax.type,
    syntaxTag: syntax.tag,
    syntaxComment: syntax.comment,
  }
}
