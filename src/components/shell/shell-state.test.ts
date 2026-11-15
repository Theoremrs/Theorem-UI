// SOURCING: bun:test over the shell state's persistence, against happy-dom's
// localStorage.
import { expect, test } from 'bun:test'
import { PANEL_WIDTH, useShell } from './shell-state'

test('a reload opens the panel on its own list, not the files', async () => {
  localStorage.setItem(
    'theorem-ui:shell',
    JSON.stringify({
      state: { filesShown: true, explorerOpen: false },
      version: 3,
    }),
  )
  await useShell.persist.rehydrate()
  expect(useShell.getState().filesShown).toBe(false)
  expect(useShell.getState().explorerOpen).toBe(false)

  useShell.getState().setFilesShown(true)
  const saved = JSON.parse(localStorage.getItem('theorem-ui:shell')!)
  expect(saved.state.filesShown).toBeUndefined()
  localStorage.removeItem('theorem-ui:shell')
})

test('a layout saved under either version 4 takes the wider panel and folds the files', async () => {
  localStorage.setItem(
    'theorem-ui:shell',
    JSON.stringify({
      state: { panelWidth: 200, explorerOpen: true },
      version: 4,
    }),
  )
  await useShell.persist.rehydrate()
  expect(useShell.getState().explorerOpen).toBe(false)
  expect(useShell.getState().panelWidth).not.toBe(200)
  localStorage.removeItem('theorem-ui:shell')
})

test('a panel left at the old default width takes the new one, and a dragged width is kept', async () => {
  const saved = (panelWidth: number) =>
    localStorage.setItem(
      'theorem-ui:shell',
      JSON.stringify({ state: { panelWidth }, version: 6 }),
    )
  saved(354)
  await useShell.persist.rehydrate()
  expect(useShell.getState().panelWidth).toBe(PANEL_WIDTH.default)
  saved(320)
  await useShell.persist.rehydrate()
  expect(useShell.getState().panelWidth).toBe(320)
  localStorage.removeItem('theorem-ui:shell')
})

test('a panel left at the version 7 default of 280 takes the narrower one', async () => {
  const saved = (panelWidth: number) =>
    localStorage.setItem(
      'theorem-ui:shell',
      JSON.stringify({ state: { panelWidth }, version: 7 }),
    )
  saved(280)
  await useShell.persist.rehydrate()
  expect(useShell.getState().panelWidth).toBe(PANEL_WIDTH.default)
  expect(PANEL_WIDTH.default).toBeLessThan(280)
  saved(300)
  await useShell.persist.rehydrate()
  expect(useShell.getState().panelWidth).toBe(300)
  localStorage.removeItem('theorem-ui:shell')
})

test("a panel left at the version 8 default of 248 takes the cabinet spec's 210", async () => {
  const saved = (panelWidth: number) =>
    localStorage.setItem(
      'theorem-ui:shell',
      JSON.stringify({ state: { panelWidth }, version: 8 }),
    )
  saved(248)
  await useShell.persist.rehydrate()
  expect(useShell.getState().panelWidth).toBe(210)
  expect(PANEL_WIDTH.min).toBeLessThan(PANEL_WIDTH.default)
  saved(260)
  await useShell.persist.rehydrate()
  expect(useShell.getState().panelWidth).toBe(260)
  localStorage.removeItem('theorem-ui:shell')
})
