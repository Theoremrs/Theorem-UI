import { expect, test } from 'bun:test'
import { blend, wcagContrast } from 'culori'
import vitesseDark from 'shiki/themes/vitesse-dark.mjs'
import vitesseLight from 'shiki/themes/vitesse-light.mjs'
import githubDark from 'shiki/themes/github-dark-default.mjs'
import type { ThemeRegistration } from 'shiki/core'
import { codeThemeForSurface } from './code-theme'

test('Vitesse keeps every authored paint, including alpha, on its native ground', () => {
  for (const [name, base, backgrounds] of [
    ['vitesse-dark', vitesseDark, ['#121212', 'rgb(18 18 18)']],
    ['vitesse-light', vitesseLight, ['#ffffff', '#fff', 'rgb(255, 255, 255)']],
  ] as const) {
    for (const background of backgrounds) {
      const placed = codeThemeForSurface(name, base, background)
      expect(placed.colors).toBe(base.colors)
      expect(placed.tokenColors).toBe(base.tokenColors)
      expect(placed).toEqual({ ...base, name: `${name} on ${background}` })
    }
  }
  const alpha = vitesseDark.tokenColors?.filter((rule) =>
    /^#[\da-f]{8}$/i.test(rule.settings.foreground ?? ''),
  )
  expect(alpha?.length).toBeGreaterThan(0)
})

test('Vitesse adapts when its actual code ground changes, without mutating the bundle', () => {
  const before = structuredClone(vitesseDark)
  const background = '#26394a'
  const placed = codeThemeForSurface('vitesse-dark', vitesseDark, background)
  expect(placed.tokenColors).not.toEqual(vitesseDark.tokenColors)
  for (const rule of placed.tokenColors ?? []) {
    if (!rule.settings.foreground) continue
    const paint = blend([background, rule.settings.foreground], 'normal', 'rgb')
    expect(wcagContrast(paint, background)).toBeGreaterThanOrEqual(4.5)
  }
  expect(vitesseDark).toEqual(before)
})

test('other palettes keep calibrated syntax on custom surfaces', () => {
  for (const background of ['#c2bebb', '#26394a']) {
    const placed = codeThemeForSurface(
      'github-dark-default',
      githubDark,
      background,
    )
    const foregrounds = [
      placed.colors?.['editor.foreground'],
      ...(placed.tokenColors ?? []).map((rule) => rule.settings.foreground),
    ].filter((color): color is string => color !== undefined)
    for (const color of foregrounds) {
      const paint = blend([background, color], 'normal', 'rgb')
      expect(wcagContrast(paint, background)).toBeGreaterThanOrEqual(4.5)
    }
    expect(new Set(foregrounds).size).toBeGreaterThan(2)
  }
})

test('a translucent or unknown ground does not receive the native-theme exception', () => {
  for (const background of ['#12121280', 'var(--custom-code-ground)']) {
    const placed = codeThemeForSurface('vitesse-dark', vitesseDark, background)
    expect(placed.tokenColors).not.toEqual(vitesseDark.tokenColors)
  }
  const noGround: ThemeRegistration = {
    ...vitesseDark,
    colors: { 'editor.foreground': '#dbd7caee' },
  }
  expect(
    codeThemeForSurface('vitesse-dark', noGround, '#121212').tokenColors,
  ).not.toEqual(vitesseDark.tokenColors)
})
