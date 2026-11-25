// SOURCING: GitHub Dark's code colours (GitHub Primer's dark syntax colours, as Shiki's github-dark-default theme and the terminal crate's GitHub Dark constants in terminal/src/lib.rs carry them); plain data, kept apart from the highlighter (code-classes.ts) so the terminal's theme can read it without loading a grammar.

/**
 * GitHub Dark's code colours by highlight class: the colours the terminal
 * crate draws each class in (terminal-roles.ts makes them read on every
 * surface). `link` and `token` (plain text) are GitHub Dark's too.
 */
export const GITHUB_DARK = {
  attr: '#79c0ff',
  'code-inline': '#ffa657',
  command: '#d2a8ff',
  comment: '#8b949e',
  deleted: '#ff7b72',
  function: '#d2a8ff',
  heading: '#79c0ff',
  inserted: '#7ee787',
  keyword: '#ff7b72',
  link: '#58a6ff',
  literal: '#79c0ff',
  meta: '#8b949e',
  number: '#79c0ff',
  operator: '#d2a8ff',
  property: '#79c0ff',
  selector: '#7ee787',
  string: '#a5d6ff',
  tag: '#7ee787',
  token: '#c9d1d9',
  type: '#ffa657',
  variable: '#ffa657',
} as const

/**
 * The class each colour of GitHub Dark Default names. Every token colour the
 * theme gives is here except its plain text, which has no class
 * (code-classes.test.ts holds the two together). A bold #79c0ff is a heading.
 */
export const CLASS_OF_COLOUR: Record<string, string> = {
  '#ff7b72': 'keyword',
  '#ffa198': 'deleted',
  '#a5d6ff': 'string',
  '#79c0ff': 'number',
  '#d2a8ff': 'function',
  '#ffa657': 'variable',
  '#7ee787': 'tag',
  '#8b949e': 'comment',
}
