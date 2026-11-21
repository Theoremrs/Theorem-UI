// SOURCING: the real appearance store and palette generator; exercises the
// editor's visible fields and Apply behavior through React's DOM test harness.
import { act } from 'react'
import { afterEach, beforeEach, expect, test } from 'bun:test'
import {
  APPEARANCE_STORAGE_KEY,
  DEFAULT_APPEARANCE,
  EDITABLE_COLOR_ROLES,
  useAppearance,
} from '@/lib/appearance'
import { COLOR_ROLES } from '@/lib/appearance-policy'
import {
  appearanceTokens,
  modes,
  paletteTokens,
} from '../../../scripts/palettes'
import {
  buttonNamed,
  cleanup,
  click,
  render,
} from '../../../test/blocks/render'
import { PaletteColors } from './palette-colors'

const initial = useAppearance.getState()
const field = (container: ParentNode, label: string, mode = 'light') =>
  container.querySelector<HTMLInputElement>(
    `input[aria-label="${label}, ${mode}"]`,
  )!
const rowToken = (token: string) =>
  token === 'surface-raised' ? 'popover' : token

beforeEach(() => useAppearance.getState().loadSelection(DEFAULT_APPEARANCE))
afterEach(async () => {
  await cleanup()
  useAppearance.setState(initial, true)
  localStorage.removeItem(APPEARANCE_STORAGE_KEY)
})

const enter = (input: HTMLInputElement, value: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })

const expressive = {
  light: appearanceTokens(modes.find((mode) => mode.selector === ':root')!),
  dark: appearanceTokens(modes.find((mode) => mode.selector === '.dark')!),
}

test('editing Expressive GitHub Sharp preserves every untouched displayed color', async () => {
  useAppearance.getState().selectPreset('expressive')
  const { container } = await render(<PaletteColors />)
  for (const mode of ['light', 'dark'] as const)
    for (const { token, label } of EDITABLE_COLOR_ROLES)
      expect(field(container, label, mode).value).toBe(
        expressive[mode][rowToken(token)]!,
      )

  await enter(field(container, 'Primary ink'), '#000000')
  await click(buttonNamed(container, 'Apply colors')!)
  const { appearance, overrides } = useAppearance.getState()
  expect(appearance.preset).toBe('expressive')
  expect(appearance.palette).toBe('custom')
  for (const mode of ['light', 'dark'] as const)
    for (const token of new Set(Object.values(COLOR_ROLES)))
      expect(overrides.customPalette?.[mode][token]).toBe(
        mode === 'light' && token === 'ink'
          ? '#000000'
          : expressive[mode][token]!,
      )
  expect(container.querySelector('[role="status"]')?.textContent).toBe(
    'Custom palette applied.',
  )
})

test('a draft follows its palette and does not return after switching away and back', async () => {
  const { container } = await render(<PaletteColors />)
  await enter(field(container, 'Primary ink'), '#000000')
  await act(async () =>
    useAppearance.getState().setOverrides({ palette: 'ember' }),
  )
  expect(field(container, 'Primary ink').value).toBe(
    paletteTokens('ember')!.light.ink!,
  )

  await act(async () =>
    useAppearance.getState().setOverrides({ palette: 'github-sharp' }),
  )
  expect(field(container, 'Primary ink').value).toBe(
    paletteTokens('github-sharp')!.light.ink!,
  )

  await act(async () =>
    useAppearance.getState().setOverrides({ palette: 'ember' }),
  )
  await click(buttonNamed(container, 'Apply colors')!)
  expect(useAppearance.getState().appearance.palette).toBe('custom')
  const saved = useAppearance.getState().overrides.customPalette!
  for (const mode of ['light', 'dark'] as const)
    for (const token of new Set(Object.values(COLOR_ROLES)))
      expect(saved[mode][token]).toBe(paletteTokens('ember')![mode][token])
})

test('changing expression refreshes the draft to the selected expression', async () => {
  const { container } = await render(<PaletteColors />)
  await enter(field(container, 'Primary ink'), '#000000')
  await act(async () => useAppearance.getState().selectPreset('expressive'))
  expect(field(container, 'Primary ink').value).toBe(expressive.light.ink!)
  expect(field(container, 'Canvas').value).toBe(
    expressive.light['surface-neutral']!,
  )
  await click(buttonNamed(container, 'Apply colors')!)
  expect(useAppearance.getState().appearance.preset).toBe('expressive')
  expect(useAppearance.getState().overrides.customPalette!.light.ink).toBe(
    expressive.light.ink,
  )
})

test('density and scale changes preserve the current palette draft', async () => {
  const { container } = await render(<PaletteColors />)
  await enter(field(container, 'Primary ink'), '#000000')
  await act(async () =>
    useAppearance
      .getState()
      .setOverrides({ density: 'touch', scales: { ui: 1.25 } }),
  )
  expect(field(container, 'Primary ink').value).toBe('#000000')
  await click(buttonNamed(container, 'Apply colors')!)
  const { appearance, overrides } = useAppearance.getState()
  expect(appearance.density).toBe('touch')
  expect(appearance.scales.ui).toBe(1.25)
  expect(overrides.customPalette!.light.ink).toBe('#000000')
})

test('legacy custom palettes edit their completed displayed colors', async () => {
  const colors = Object.fromEntries(
    Object.values(COLOR_ROLES)
      .filter((token) => !/^(action-|insight-|series-)/.test(token))
      .map((token) => [token, paletteTokens('ember')!.light[token]!]),
  )
  useAppearance.getState().loadSelection({
    preset: 'expressive',
    overrides: {
      palette: 'custom',
      customPalette: { name: 'Legacy ember', light: colors, dark: colors },
    },
  })
  const resolved = useAppearance.getState().appearance.customPalette!
  const { container } = await render(<PaletteColors />)
  for (const mode of ['light', 'dark'] as const)
    for (const { token, label } of EDITABLE_COLOR_ROLES)
      expect(field(container, label, mode).value).toBe(
        resolved[mode][rowToken(token)]!,
      )
})
