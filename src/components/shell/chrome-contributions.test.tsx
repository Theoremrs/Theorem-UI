// SOURCING: bun:test over the shell chrome as contributions, rendered with
// React into happy-dom in a memory router as rail.test.tsx does: the rail
// shows what the nav-entry contributions say (the shipped ones in the shipped
// order), a hidden built-in and an installed destination follow the registry,
// safe mode drops the installed one, a throwing contribution is recorded and
// replaced, and the recovery page renders with user extensions off.
import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import { act } from 'react'
import { cleanup, render, waitFor } from '../../../test/workspace'
import {
  contributionsOf,
  registerContribution,
  useHandlerPreferences,
} from '@/lib/contributions/registry'
import { useFailures } from '@/lib/shell/failures'
import { useSafeMode } from '@/lib/shell/safe-mode'
import { MODES } from './builtin-nav'
import { SHIPPED_PRESETS, navEntryId } from './builtin-chrome'
import { ContributionBoundary } from './contribution-boundary'
import { RecoveryPage } from './recovery-page'
import { Rail } from './rail'
import { ARRANGEMENTS } from './arrangements'
import { useShell } from './shell-state'

function renderWith(element: React.ReactNode, initialEntry = '/') {
  const root = createRootRoute({ component: Outlet })
  const page = createRoute({
    getParentRoute: () => root,
    path: '/',
    component: () => <>{element}</>,
  })
  const router = createRouter({
    routeTree: root.addChildren([page]),
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
  })
  return render(<RouterProvider router={router} />)
}

const removes: Array<() => void> = []
let restoreFetch: (() => void) | undefined
beforeEach(() => {
  useShell.setState({ railOrder: [], panelCollapsed: {}, filesShown: false })
  useHandlerPreferences.getState().resetAll()
  useSafeMode.setState({ active: false, via: null })
  useFailures.getState().clear()
  const spy = spyOn(globalThis, 'fetch').mockImplementation(
    (async () =>
      new Response(null, { status: 404 })) as unknown as typeof fetch,
  )
  restoreFetch = () => spy.mockRestore()
})
afterEach(() => {
  while (removes.length) removes.pop()!()
  restoreFetch?.()
  cleanup()
})

const labels = (container: Element) =>
  [...container.querySelectorAll('nav[aria-label="Modes"] button')].map(
    (button) => button.getAttribute('aria-label'),
  )

test('the shipped navigation is contributions, and the rail renders the shipped list from them', async () => {
  const { container } = await renderWith(<Rail />)
  await waitFor(() => labels(container).length > 0)
  // The Vault is offered only where folders can be opened, as before.
  expect(labels(container)).toEqual(
    MODES.map((entry) => entry.label).filter((label) => label !== 'Vault'),
  )
})

test('every shipped destination, preset and the shipped shell register as built-in theorem.* contributions', () => {
  const entries = contributionsOf('nav-entry')
  for (const entry of MODES)
    expect(
      entries.find((one) => one.id === navEntryId(entry.mode))?.source.kind,
    ).toBe('builtin')
  expect(contributionsOf('shell').map((one) => one.id)).toContain(
    'theorem.shell.default',
  )
  expect(SHIPPED_PRESETS.map((one) => one.arrangement).sort()).toEqual(
    Object.keys(ARRANGEMENTS).sort(),
  )
  expect(contributionsOf('layout-preset').length).toBeGreaterThanOrEqual(3)
  expect(contributionsOf('theme').length).toBeGreaterThan(0)
})

test('hiding a built-in removes it from the rail; restoring brings it back', async () => {
  const { container } = await renderWith(<Rail />)
  await waitFor(() => labels(container).includes('Notes'))
  await act(async () =>
    useHandlerPreferences.getState().setHidden('theorem.nav.notes', true),
  )
  expect(labels(container)).not.toContain('Notes')
  await act(async () =>
    useHandlerPreferences.getState().setHidden('theorem.nav.notes', false),
  )
  expect(labels(container)).toContain('Notes')
})

test('Home cannot be hidden', async () => {
  useHandlerPreferences.getState().setHidden('theorem.nav.home', true)
  const { container } = await renderWith(<Rail />)
  await waitFor(() => labels(container).length > 0)
  expect(labels(container)).toContain('Home')
})

test('an installed destination appears while extensions are on and not in safe mode', async () => {
  removes.push(
    registerContribution(
      {
        kind: 'nav-entry',
        id: 'acme.nav.crm',
        label: 'CRM',
        meta: { to: '/' },
      },
      { kind: 'extension', extensionId: 'acme' },
    ),
  )
  const { container } = await renderWith(<Rail />)
  await waitFor(() => labels(container).length > 0)
  const more = () =>
    container.querySelector('nav[aria-label="More destinations"]')
  expect(more()?.textContent).toBeDefined()
  expect(more()?.querySelector('a[aria-label="CRM"]')).not.toBeNull()
  await act(async () => useSafeMode.getState().enter('query'))
  expect(more()).toBeNull()
  expect(labels(container)).toContain('Home')
})

function Broken(): never {
  throw new Error('shell exploded')
}

test('a throwing custom shell is recorded and the shipped presentation takes over', async () => {
  const consoleError = spyOn(console, 'error').mockImplementation(() => {})
  const { container } = await renderWith(
    <ContributionBoundary
      area="shell"
      contributionId="acme.shell.broken"
      fallback={<p>shipped shell</p>}
    >
      <Broken />
    </ContributionBoundary>,
  )
  await waitFor(() => container.textContent.includes('shipped shell'))
  consoleError.mockRestore()
  expect(useFailures.getState().failures[0]).toMatchObject({
    area: 'shell',
    contributionId: 'acme.shell.broken',
    message: 'shell exploded',
  })
})

test('the recovery page renders with extensions off, lists failures and offers restore and reset', async () => {
  useFailures.getState().record({
    area: 'handler',
    contributionId: 'acme.open.x',
    message: 'bad render',
  })
  useHandlerPreferences.getState().selectShell('acme.shell.broken')
  const { container } = await renderWith(<RecoveryPage />)
  await waitFor(() => container.textContent.includes('Recovery'))
  expect(useSafeMode.getState().active).toBe(true)
  const text = container.textContent
  expect(text).toContain('Restore the shipped shell')
  expect(text).toContain('Reset default handlers')
  expect(text).toContain('Reset layout')
  expect(text).toContain('acme.open.x')
  expect(text).toContain('bad render')
  const restore = [...container.querySelectorAll('button')].find(
    (button) => button.textContent === 'Restore the shipped shell',
  )!
  await act(async () => restore.click())
  expect(useHandlerPreferences.getState().shell).toBeUndefined()
})
