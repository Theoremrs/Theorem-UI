// SOURCING: @tanstack/highlight's githubDarkTheme and @shikijs/themes' vitesse-dark (Anthony Fu's Vitesse Dark, MIT) for each editor's ground and code colours, read by scope rather than copied; culori to flatten a translucent token colour over its ground. lib/appearance-policy's PALETTES names the code theme each palette draws in.
//
// The dark editor a palette's terminal is drawn as. The terminal reads as an
// editor of its own beside the workspace: its code takes the palette's dark
// code theme, and in a dark workspace its conversation sits on that editor's
// ground, below the main screen. Vitesse is built on Vitesse's own editor
// colours, so its terminal sits on Vitesse Dark's ground in both modes
// (owner, 2026-11-22).
import { githubDarkTheme } from '@tanstack/highlight/themes/github-dark'
import vitesseDark from '@shikijs/themes/vitesse-dark'
import { formatHex, interpolate, parse } from 'culori'
import { PALETTES } from '@/lib/appearance-policy'

/** The syntax roles the terminal colours code in. */
export const SYNTAX_ROLES = [
  'keyword',
  'string',
  'number',
  'function',
  'variable',
  'type',
  'tag',
  'comment',
] as const
export type SyntaxRole = (typeof SYNTAX_ROLES)[number]

export type TerminalEditor = {
  /** The editor's ground: the terminal's canvas in a dark workspace. */
  ground: string
  /**
   * The terminal sits on the ground as it is, in both modes, where the
   * palette is built on this editor's own colours.
   */
  onGround: boolean
  syntax: Record<SyntaxRole, string>
}

export const GITHUB_DARK: TerminalEditor = {
  ground: githubDarkTheme.background,
  onGround: false,
  syntax: Object.fromEntries(
    SYNTAX_ROLES.map((role) => [role, githubDarkTheme.tokens[role]]),
  ) as Record<SyntaxRole, string>,
}

/** A token colour as drawn: one with alpha, laid over the ground. */
function over(colour: string, ground: string) {
  const parsed = parse(colour)
  if (!parsed) throw new Error(`not a colour: ${colour}`)
  return formatHex(
    interpolate([ground, { ...parsed, alpha: 1 }])(parsed.alpha ?? 1),
  )
}

/** The colour a TextMate theme gives the first rule naming `scope`. */
function scoped(theme: typeof vitesseDark, scope: string) {
  const rule = theme.tokenColors?.find((entry) =>
    ([] as string[]).concat(entry.scope ?? []).includes(scope),
  )
  const colour = rule?.settings.foreground
  if (!colour) throw new Error(`${theme.name} names no colour for ${scope}`)
  return colour
}

/** The TextMate scope each syntax role is drawn as. */
const SCOPES: Record<SyntaxRole, string> = {
  keyword: 'keyword',
  string: 'string',
  number: 'constant.numeric',
  function: 'entity.name.function',
  variable: 'variable',
  type: 'entity.name.type',
  tag: 'entity.name.tag',
  comment: 'comment',
}

const vitesseGround = vitesseDark.colors!['editor.background']!

export const VITESSE_DARK: TerminalEditor = {
  ground: vitesseGround,
  onGround: true,
  syntax: Object.fromEntries(
    SYNTAX_ROLES.map((role) => [
      role,
      over(scoped(vitesseDark, SCOPES[role]), vitesseGround),
    ]),
  ) as Record<SyntaxRole, string>,
}

const EDITORS: Record<string, TerminalEditor> = {
  'github-dark-default': GITHUB_DARK,
  'vitesse-dark': VITESSE_DARK,
}

/** The editor a palette's terminal is drawn as; a person's own colours take GitHub Dark's. */
export function editorFor(palette: string | undefined): TerminalEditor {
  const code = PALETTES.find((entry) => entry.value === palette)?.code.dark
  return (code && EDITORS[code]) ?? GITHUB_DARK
}
