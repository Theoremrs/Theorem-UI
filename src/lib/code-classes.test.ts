// SOURCING: none — bun:test over ./code-classes and Shiki's bundled GitHub Dark Default theme
import { expect, test } from 'bun:test'
import githubDarkDefault from 'shiki/themes/github-dark-default.mjs'
import { classedLines, languageOf } from './code-classes'
import { CLASS_OF_COLOUR, GITHUB_DARK } from './code-colours'

type Rule = { settings?: { foreground?: string } }
const themeColours = new Set(
  ((githubDarkDefault.tokenColors ?? []) as Rule[]).flatMap((rule) =>
    rule.settings?.foreground ? [rule.settings.foreground.toLowerCase()] : [],
  ),
)
/** Colours the theme gives text that is not code of a kind: plain text, a carriage return, an ignored line. */
const PLAIN = ['#e6edf3', '#f0f6fc', '#161b22']

test('every colour GitHub Dark Default gives a token names a class, or is plain text', () => {
  const unnamed = [...themeColours].filter(
    (colour) => !(colour in CLASS_OF_COLOUR) && !PLAIN.includes(colour),
  )
  expect(unnamed).toEqual([])
})

test("the classes' colours are the theme's: the terminal draws what Shiki tokenized", () => {
  for (const name of Object.values(CLASS_OF_COLOUR)) {
    const colour = GITHUB_DARK[name as keyof typeof GITHUB_DARK]
    if (name !== 'deleted') expect(themeColours.has(colour)).toBe(true)
  }
})

test('TypeScript keeps its classes after an arrow, which `v`-flag patterns lose on JavaScriptCore', () => {
  const [line] = classedLines(
    'export const header = (line: string): string[] => fields(line, { strict: true })',
    'ts',
  )
  const classOf = (text: string) =>
    line?.find((token) => token.text === text)?.class
  expect(classOf('fields')).toBe('function')
  expect(classOf('true')).toBe('number')
})

test('offsets count UTF-16 code units, and a break splits the token it falls in', () => {
  const code = 'let s = "😀ab"'
  const tokens = classedLines(code, 'rust', [11]).flat()
  for (const token of tokens)
    expect(code.slice(token.offset, token.offset + token.text.length)).toBe(
      token.text,
    )
  expect(tokens.some((token) => token.offset === 11)).toBe(true)
})

test('a language is found by its name, an alias, or a file extension', () => {
  expect(languageOf('rust')).toBe('rust')
  expect(languageOf('RS')).toBe('rust')
  expect(languageOf('Dockerfile')).toBe('docker')
  expect(languageOf('sh')).toBe('shellscript')
  expect(languageOf('hpp')).toBe('cpp')
  expect(languageOf('patch')).toBe('diff')
  expect(languageOf('jsonc')).toBe('json')
  expect(languageOf('nonesuch')).toBeUndefined()
  expect(languageOf('')).toBeUndefined()
  expect(classedLines('one\ntwo', 'nonesuch')).toEqual([
    [{ text: 'one', offset: 0 }],
    [{ text: 'two', offset: 4 }],
  ])
})
