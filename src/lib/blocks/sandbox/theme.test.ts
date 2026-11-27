import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'bun:test'
import { APP_TOKENS, themeCss } from './theme'

const stylesheets = ['src/styles.css', 'src/palettes.css'].map((path) => readFileSync(path, 'utf8')).join('\n')

describe('the tokens a hosted App is handed', () => {
  // A `--theorem-*` name whose UI token no stylesheet declares reaches the
  // App empty, and the App draws with its fallback instead of the theme.
  test('each names a token the UI declares', () => {
    const undeclared = Object.values(APP_TOKENS).filter((token) => !stylesheets.includes(`--${token}:`))
    expect(undeclared).toEqual([])
  })

  test('include the series colours a chart draws its subjects with', () => {
    const css = themeCss({ scheme: 'dark', tokens: { 'series-1': '#86aafc' } })
    expect(Object.keys(APP_TOKENS)).toContain('series-5')
    expect(css).toContain('--theorem-series-1: #86aafc;')
  })
})
