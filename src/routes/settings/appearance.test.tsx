// SOURCING: none — bun:test over Settings, Appearance, rendered into happy-dom through test/blocks/render with the real shell state
import { afterEach, expect, test } from 'bun:test'
import { useShell } from '@/components/shell/shell-state'
import { AppearanceSettings } from './appearance'
import { cleanup, click, render } from '../../../test/blocks/render'

const initial = useShell.getState()
afterEach(async () => {
  await cleanup()
  useShell.setState(initial, true)
  localStorage.removeItem('theorem-ui:shell')
})

test('Settings, Appearance opens the Workspace as a drawer until the person makes it part of the screen, kept on this device', async () => {
  const { container } = await render(<AppearanceSettings />)
  const group = container.querySelector('[aria-label="Workspace opens as"]')!
  const choice = (label: string) =>
    [...group.querySelectorAll('button')].find(
      (button) => button.textContent.trim() === label,
    )!
  expect(choice('Drawer').getAttribute('aria-pressed')).toBe('true')
  expect(choice('Part of the screen').getAttribute('aria-pressed')).toBe(
    'false',
  )

  await click(choice('Part of the screen'))
  expect(useShell.getState().workbenchAttachment).toBe('docked')
  expect(choice('Part of the screen').getAttribute('aria-pressed')).toBe('true')
  const saved = JSON.parse(localStorage.getItem('theorem-ui:shell')!)
  expect(saved.state.workbenchAttachment).toBe('docked')

  await click(choice('Drawer'))
  expect(useShell.getState().workbenchAttachment).toBe('drawer')
})
