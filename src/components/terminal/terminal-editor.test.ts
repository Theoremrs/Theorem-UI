// The dark editors terminals are drawn as: GitHub Dark as TanStack Highlight
// gives it, and Anthony Fu's Vitesse Dark as shiki bundles it, each chosen by
// the palette's own dark code theme.
import { expect, test } from 'bun:test'
import { githubDarkTheme } from '@tanstack/highlight/themes/github-dark'
import {
  GITHUB_DARK,
  SYNTAX_ROLES,
  VITESSE_DARK,
  editorFor,
} from './terminal-editor'

test("each palette's terminal is drawn as its dark code theme's editor", () => {
  expect(editorFor('vitesse')).toBe(VITESSE_DARK)
  for (const palette of ['github-sharp', 'ember', 'stone', 'custom', undefined])
    expect(editorFor(palette)).toBe(GITHUB_DARK)
})

test('GitHub Dark is the code colours TanStack Highlight gives it', () => {
  expect(GITHUB_DARK.ground).toBe('#0d1117')
  for (const role of SYNTAX_ROLES)
    expect(GITHUB_DARK.syntax[role]).toBe(githubDarkTheme.tokens[role])
})

test("Vitesse Dark is Fu's ground and token colours, translucent ones as drawn on it", () => {
  expect(VITESSE_DARK.ground).toBe('#121212')
  expect(VITESSE_DARK.onGround).toBe(true)
  expect(VITESSE_DARK.syntax).toMatchObject({
    keyword: '#4d9375',
    string: '#c98a7d',
    number: '#4c9a91',
    function: '#80a665',
    variable: '#bd976a',
    type: '#5da994',
    tag: '#4d9375',
  })
  // #758575dd: the comment's green-grey at 87% over the ground.
  expect(VITESSE_DARK.syntax.comment).toBe('#687668')
})
