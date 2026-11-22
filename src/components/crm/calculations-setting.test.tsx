// SOURCING: bun:test over the calculations setting, with window.localStorage replaced by a stand-in whose writes fail while its reads still answer, as a full browser store does
import { afterEach, expect, test } from 'bun:test'
import { act } from 'react'
import { cleanup, render, waitFor } from '../../../test/blocks/render'
import {
  CALCULATIONS_KEY,
  setCalculationsShown,
  useCalculationsShown,
} from './calculations-setting'

const real = Object.getOwnPropertyDescriptor(window, 'localStorage')!
afterEach(async () => {
  await cleanup()
  Object.defineProperty(window, 'localStorage', real)
})

function Probe() {
  return <output>{useCalculationsShown() ? 'shown' : 'hidden'}</output>
}

test('when storage refuses the write, the new choice still takes effect for this visit', async () => {
  const stored = new Map<string, string>([[CALCULATIONS_KEY, 'off']])
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: () => {
        throw new Error('QuotaExceededError')
      },
    },
  })
  const { container } = await render(<Probe />)
  expect(container.textContent).toBe('hidden')

  await act(async () => setCalculationsShown(true))
  await waitFor(() => container.textContent === 'shown')

  await act(async () => setCalculationsShown(false))
  await waitFor(() => container.textContent === 'hidden')
})
