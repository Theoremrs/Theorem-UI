import { beforeEach, describe, expect, test } from 'bun:test'
import { DEFAULT_APPEARANCE, useAppearance } from '@/lib/appearance'
import { createAppearancePort, tellAppearance } from './appearance'

const effect = (appearance: string) =>
  ({
    id: 1,
    kind: 'appearanceApply',
    resource: { type: 'workspace', workspace: 'w1' },
    payload: { appearance },
  }) as Parameters<ReturnType<typeof createAppearancePort>['perform']>[0]

beforeEach(() => useAppearance.getState().loadSelection(DEFAULT_APPEARANCE))

describe('telling the core the appearance', () => {
  test('is sent at start and on every change, as the selection and nothing else', () => {
    const told: string[] = []
    const stop = tellAppearance(useAppearance, (text) => told.push(text))
    expect(told).toEqual([JSON.stringify({ preset: 'calm', overrides: {} })])
    useAppearance.getState().selectPreset('expressive')
    useAppearance.getState().setOverrides({ palette: 'github-sharp' })
    expect(told.map((text) => JSON.parse(text))).toEqual([
      { preset: 'calm', overrides: {} },
      { preset: 'expressive', overrides: {} },
      { preset: 'expressive', overrides: { palette: 'github-sharp' } },
    ])
    stop()
  })

  test('a change that leaves the selection as it was is not told again', () => {
    const told: string[] = []
    const stop = tellAppearance(useAppearance, (text) => told.push(text))
    useAppearance.getState().selectPreset('calm')
    expect(told).toHaveLength(1)
    stop()
  })

  test('unmounting stops the telling', () => {
    const told: string[] = []
    const stop = tellAppearance(useAppearance, (text) => told.push(text))
    stop()
    useAppearance.getState().selectPreset('expressive')
    expect(told).toHaveLength(1)
  })
})

describe('applying a saved arrangement’s theme', () => {
  const port = createAppearancePort(useAppearance)

  test('sets the store through its setter and answers accepted', async () => {
    const saved = JSON.stringify({
      preset: 'expressive',
      overrides: { density: 'compact' },
    })
    expect(await port.perform(effect(saved), 'r')).toEqual({
      outcome: 'accepted',
    })
    const state = useAppearance.getState()
    expect(state.preset).toBe('expressive')
    expect(state.overrides).toEqual({ density: 'compact' })
    expect(state.appearance.density).toBe('compact')
  })

  test('applying re-tells the core through the subscription', async () => {
    const told: string[] = []
    const stop = tellAppearance(useAppearance, (text) => told.push(text))
    await port.perform(
      effect(JSON.stringify({ preset: 'expressive', overrides: {} })),
      'r',
    )
    expect(told).toHaveLength(2)
    stop()
  })

  test('JSON that does not parse is refused with a reason and leaves the store alone', async () => {
    const before = useAppearance.getState().preset
    const answer = await port.perform(effect('{not json'), 'r')
    expect(answer).toEqual({
      outcome: 'refused',
      code: 'invalid_appearance',
      reason: 'the saved theme is not JSON',
    })
    expect(useAppearance.getState().preset).toBe(before)
  })

  test('a value that fails the schema is refused with the first problem and leaves the store alone', async () => {
    const answer = await port.perform(
      effect(JSON.stringify({ preset: 'loud', overrides: {} })),
      'r',
    )
    expect(answer.outcome).toBe('refused')
    expect(answer.outcome === 'refused' && answer.reason).toContain('preset')
    expect(useAppearance.getState().preset).toBe('calm')
    const extra = await port.perform(
      effect(
        JSON.stringify({
          preset: 'expressive',
          overrides: { density: 'huge' },
        }),
      ),
      'r',
    )
    expect(extra.outcome).toBe('refused')
    expect(useAppearance.getState().preset).toBe('calm')
  })
})
