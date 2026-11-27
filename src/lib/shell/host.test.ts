// SOURCING: bun:test over describeHost (HOST-02) and the narrow-layout helpers (HOST-03).
import { expect, test } from 'bun:test'
import type { DockviewApi } from 'dockview-react'
import { describeHost } from './host'
import { missingAfterRestore, stackPanels } from './narrow-layout'

test('the host matrix declares its targets, storage, intents, commands and what it does not support', () => {
  const host = describeHost()
  expect(host.schema).toBe('theorem.host/1')
  expect(host.presentationTargets.map((one) => one.id)).toEqual(
    expect.arrayContaining(['dock', 'stacked', 'page', 'shell']),
  )
  expect(
    host.layoutEngines.find((one) => one.id === 'dockview')?.singleDriver,
  ).toEqual(['thread', 'ide', 'terminal'])
  expect(host.storageBindings.length).toBeGreaterThan(0)
  expect(host.openingIntents.map((one) => one.intent)).toContain(
    'focus-existing',
  )
  expect(host.contributionKinds).toContain('shell')
  expect(host.unsupportedTargets.map((one) => one.id)).toEqual(
    expect.arrayContaining(['native-presentation', 'dockview-enterprise']),
  )
  expect(() => JSON.stringify(host)).not.toThrow()
})

test('platform commands are read from the registry, not copied', async () => {
  const { registerPanelCommands } = await import('./panel-commands')
  const remove = registerPanelCommands(() => undefined)
  expect(describeHost().platformCommands).toContain('theorem.panel.open')
  remove()
  expect(describeHost().platformCommands).not.toContain('theorem.panel.open')
})

test('panels opened while stacked are the ones a restored layout lacks', () => {
  const live = [
    { id: 'thread', component: 'thread', title: 't', params: {} },
    {
      id: 'note-panel:1',
      component: 'note',
      title: 'n',
      params: { documentId: '1' },
    },
  ]
  expect(
    missingAfterRestore(live, new Set(['thread'])).map((one) => one.id),
  ).toEqual(['note-panel:1'])
})

test('stacking moves every panel into the anchor group and closes nothing', () => {
  const moved: string[] = []
  const home = { id: 'g1' }
  const make = (id: string, group: { id: string }) => ({
    id,
    group,
    api: { moveTo: () => moved.push(id) },
  })
  const panels = [
    make('thread', home),
    make('a', { id: 'g2' }),
    make('b', { id: 'g3' }),
  ]
  const api = {
    panels,
    groups: [home],
    getPanel: (id: string) => panels.find((one) => one.id === id),
    hasMaximizedGroup: () => false,
  } as unknown as DockviewApi
  expect(stackPanels(api, 'thread')).toEqual(['a', 'b'])
  expect(moved).toEqual(['a', 'b'])
})
