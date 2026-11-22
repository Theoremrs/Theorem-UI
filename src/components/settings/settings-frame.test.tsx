// SOURCING: bun:test over the settings frame, rendered with React into happy-dom (test/blocks/render) inside a memory router; the geometry rules are read from src/appearance.css as text, since happy-dom computes no cascade.
import { afterEach, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { useEffect, useState } from 'react'
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import { cleanup, render, waitFor } from '../../../test/blocks/render'
import { SettingsLayout, SettingsRow, SettingsSection } from './settings-frame'
import { settingsSection } from './sections'

afterEach(cleanup)

/** The frame at a settings path, with one section of rows on the sheet. */
async function frame(path = '/settings/responses') {
  const root = createRootRoute({
    component: () => (
      <SettingsLayout>
        <Outlet />
      </SettingsLayout>
    ),
  })
  const section = createRoute({
    getParentRoute: () => root,
    path,
    component: () => (
      <SettingsSection title="Output">
        <SettingsRow
          title="Response detail"
          description="How much a reply says."
        />
      </SettingsSection>
    ),
  })
  const router = createRouter({
    routeTree: root.addChildren([section]),
    history: createMemoryHistory({ initialEntries: [path] }),
  })
  await render(<RouterProvider router={router} />)
  await router.load()
  return document.querySelector('main')!
}

const appearanceCss = () =>
  readFile(new URL('../../appearance.css', import.meta.url), 'utf8')

test('the page, section and row read the appearance spacing roles, not fixed pixels', async () => {
  const main = await frame()
  const page = main.firstElementChild!
  expect(page.getAttribute('data-appearance-spacing-role')).toBe(
    'settings-page',
  )
  expect(
    main.querySelector('section')!.getAttribute('data-appearance-spacing-role'),
  ).toBe('settings-section')
  expect(
    main.querySelector('[data-appearance-part="settings-row"]'),
  ).not.toBeNull()
  // The fixed rhythm the density contract replaces is gone from the markup.
  for (const fixed of ['gap-8', 'px-6', 'py-8'])
    expect(page.className).not.toContain(fixed)

  const css = await appearanceCss()
  const rule = (role: string) =>
    css.slice(css.indexOf(`[data-appearance-spacing-role='${role}']`))
  expect(rule('settings-page')).toContain(
    'gap: calc(2 * var(--appearance-gap-group))',
  )
  expect(rule('settings-page')).toContain(
    'padding-inline: calc(1.5 * var(--appearance-gap-group))',
  )
  expect(rule('settings-section')).toContain('gap: var(--appearance-gap-group)')
  expect(css).toContain('min-block-size: var(--appearance-control-min)')
})

test('a section holding a table is compact, and an ordinary form section stays comfortable', async () => {
  const main = await frame()
  const section = main.querySelector('section')!
  expect(section.dataset.density).toBeUndefined()

  const css = await appearanceCss()
  expect(css).toContain(
    "[data-appearance-spacing-role='settings-section'][data-density='compact']",
  )
})

test('a table arriving with its data turns its own section compact, and only that section', async () => {
  const main = await frame()
  expect(main.querySelector('section')!.dataset.density).toBeUndefined()
  // A section whose table lands after the first render, as a queried one does.
  const LateTable = () => {
    const [rows, setRows] = useState<Array<string>>([])
    useEffect(() => setRows(['one']), [])
    return (
      <SettingsSection title="Recent turns">
        {rows.length > 0 && (
          <table>
            <tbody>
              {rows.map((row) => (
                <tr key={row}>
                  <td>{row}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </SettingsSection>
    )
  }
  await render(<LateTable />)
  const sections = [...document.querySelectorAll('section')]
  const tabled = sections.at(-1)!
  await waitFor(() => tabled.dataset.density === 'compact')
  // The form section beside it keeps the page's own density.
  expect(main.querySelector('section')!.dataset.density).toBeUndefined()
})

test('a wide section keeps the whole width, and a form page keeps its reading measure', () => {
  expect(settingsSection('/settings/ai')!.width).toBe(1280)
  expect(settingsSection('/settings/observe')!.width).toBe(1080)
  expect(settingsSection('/settings/responses')!.width).toBe(680)
})

test('the nav paints selection and hover from their resolved roles', async () => {
  await frame()
  const link = document.querySelector<HTMLAnchorElement>(
    'nav a[href="/settings/responses"]',
  )!
  expect(link.className).toContain('data-[status=active]:bg-selected')
  expect(link.className).toContain('data-[status=active]:text-ink')
  expect(link.className).toContain('hover:bg-hover')
  // A fixed height clipped enlarged type; the navigation role sets the minimum.
  expect(link.className).not.toContain('h-8')
  // `outline-none` also clears outline-style, so focus-visible drew no edge.
  expect(link.className).not.toContain('outline-none')
  expect(link.className).toContain('focus-visible:outline-focus')
})
