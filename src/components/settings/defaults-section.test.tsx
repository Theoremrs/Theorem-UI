// SOURCING: bun:test over the Defaults section, rendered with React into
// happy-dom: a tie is shown as waiting for the person, the shipped handler
// serves meanwhile, and Hide / Restore act on the preference store.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { act } from 'react'
import { cleanup, render } from '../../../test/workspace'
import {
  registerContribution,
  useHandlerPreferences,
} from '@/lib/contributions/registry'
import { DefaultsSection } from './defaults-section'

const removes: Array<() => void> = []
beforeEach(() => useHandlerPreferences.getState().resetAll())
afterEach(() => {
  while (removes.length) removes.pop()!()
  cleanup()
})

const button = (root: Element, text: string) =>
  [...root.querySelectorAll('button')].find((one) => one.textContent === text)

test('a tie shows as needing a choice and selects nothing', async () => {
  removes.push(
    registerContribution({
      kind: 'open-handler',
      id: 'theorem.open.csv',
      label: 'Table',
      serves: ['file:csv'],
    }),
    registerContribution(
      {
        kind: 'open-handler',
        id: 'acme.open.csv',
        label: 'Acme CSV',
        serves: ['file:csv'],
      },
      { kind: 'extension', extensionId: 'acme' },
    ),
  )
  const { container } = await render(<DefaultsSection />)
  expect(container.textContent).toContain('Needs a choice')
  expect(container.textContent).toContain('file:csv')
  expect(useHandlerPreferences.getState().byServes).toEqual({})
})

test('Hide and Restore change only the hidden list', async () => {
  const { container } = await render(<DefaultsSection />)
  const hide = button(container, 'Hide')!
  await act(async () => hide.click())
  expect(useHandlerPreferences.getState().hidden).toHaveLength(1)
  expect(container.textContent).toContain('Hidden from the rail')
  await act(async () => button(container, 'Restore')!.click())
  expect(useHandlerPreferences.getState().hidden).toEqual([])
})
