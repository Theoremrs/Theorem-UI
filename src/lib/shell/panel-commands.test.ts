// SOURCING: bun:test over the panel commands, against a small stand-in for
// Dockview's DockviewApi (the real one needs a laid-out DOM). It checks the
// logic this module owns: single-driver offers, ids for a second view of a
// resource, cycling, moving and closing, and registration of theorem.panel.*.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import type { DockviewApi } from 'dockview-react'
import { executeCommand } from '@/lib/commands/registry'
import { registerContribution } from '@/lib/contributions/registry'
import {
  closePanel,
  cyclePanel,
  isSingleDriver,
  movePanel,
  nextPanelId,
  openPanel,
  registerPanelCommands,
  usePanelOffer,
} from './panel-commands'

interface FakePanel {
  id: string
  title: string
  params: Record<string, unknown>
  view: { contentComponent: string }
  group: { id: string }
  api: { setActive: () => void; moveTo: (to: unknown) => void }
}

function fakeDock(
  layout: Array<
    [group: string, panels: Array<[id: string, component: string]>]
  >,
) {
  const events: string[] = []
  const moves: unknown[] = []
  let active: FakePanel | undefined
  const panels: FakePanel[] = []
  const groups = layout.map(([id, list]) => {
    const group = { id, panels: [] as FakePanel[] }
    for (const [panelId, component] of list) {
      const panel: FakePanel = {
        id: panelId,
        title: panelId,
        params: {},
        view: { contentComponent: component },
        group,
        api: {
          setActive: () => {
            active = panel
            events.push(`active:${panelId}`)
          },
          moveTo: (to) => moves.push({ id: panelId, to }),
        },
      }
      group.panels.push(panel)
      panels.push(panel)
    }
    return group
  })
  const api = {
    get panels() {
      return panels
    },
    groups,
    get activePanel() {
      return active
    },
    getPanel: (id: string) => panels.find((one) => one.id === id),
    addPanel: (options: { id: string; component: string; params?: object }) => {
      const group = groups[0]!
      const panel: FakePanel = {
        id: options.id,
        title: options.id,
        params: (options.params ?? {}) as Record<string, unknown>,
        view: { contentComponent: options.component },
        group,
        api: {
          setActive: () => {
            active = panel
          },
          moveTo: () => {},
        },
      }
      group.panels.push(panel)
      panels.push(panel)
      events.push(`added:${options.id}`)
      return panel
    },
    removePanel: (panel: FakePanel) => {
      panels.splice(panels.indexOf(panel), 1)
      events.push(`removed:${panel.id}`)
    },
    addFloatingGroup: (panel: FakePanel) => events.push(`float:${panel.id}`),
  }
  return { api: api as unknown as DockviewApi, events, moves }
}

const removes: Array<() => void> = []
beforeEach(() => {
  for (const component of ['thread', 'note', 'artifact'])
    removes.push(
      registerContribution({
        kind: 'panel',
        id: `theorem.panel.${component}`,
        label: component,
        meta: {
          component,
          ...(component === 'thread' && { singleDriver: true }),
        },
      }),
    )
  usePanelOffer.getState().dismiss()
})
afterEach(() => {
  while (removes.length) removes.pop()!()
})

test('the conversation, the IDE and the terminal are single-driver', () => {
  expect(isSingleDriver('thread')).toBe(true)
  expect(isSingleDriver('ide')).toBe(true)
  expect(isSingleDriver('terminal')).toBe(true)
  expect(isSingleDriver('note')).toBe(false)
})

test('a second conversation focuses the first and offers to move it, starting nothing', () => {
  const { api, events } = fakeDock([
    ['g1', [['thread', 'thread']]],
    ['g2', [['note-panel:n1', 'note']]],
  ])
  api.getPanel('note-panel:n1')!.api.setActive()
  const result = openPanel(api, { component: 'thread' })
  expect(result).toEqual({ status: 'exists', panelId: 'thread', offered: true })
  expect(events.some((event) => event.startsWith('added:'))).toBe(false)
  expect(usePanelOffer.getState().offer).toMatchObject({
    panelId: 'thread',
    from: 'note-panel:n1',
  })
})

test('opening something already open focuses it; duplicate asks for a second view', () => {
  const { api } = fakeDock([
    [
      'g1',
      [
        ['thread', 'thread'],
        ['note-panel:n1', 'note'],
      ],
    ],
  ])
  expect(
    openPanel(api, { component: 'note', id: 'note-panel:n1' }),
  ).toMatchObject({
    status: 'exists',
    offered: false,
  })
  const second = openPanel(api, {
    component: 'note',
    id: 'note-panel:n1',
    duplicate: true,
    params: { documentId: 'n1' },
  })
  expect(second).toEqual({ status: 'opened', panelId: 'note-panel:n1~2' })
  expect(api.getPanel('note-panel:n1~2')!.params).toEqual({ documentId: 'n1' })
  expect(nextPanelId(api, 'note-panel:n1')).toBe('note-panel:n1~3')
})

test('a component no contribution names is refused', () => {
  const { api } = fakeDock([['g1', [['thread', 'thread']]]])
  expect(openPanel(api, { component: 'mystery' })).toEqual({
    status: 'unknown-component',
    component: 'mystery',
  })
})

test('next and previous cycle through the panels and wrap', () => {
  const { api } = fakeDock([
    [
      'g1',
      [
        ['thread', 'thread'],
        ['a', 'artifact'],
      ],
    ],
    ['g2', [['b', 'note']]],
  ])
  api.getPanel('thread')!.api.setActive()
  expect(cyclePanel(api, 1)).toMatchObject({ panelId: 'a' })
  expect(cyclePanel(api, 1)).toMatchObject({ panelId: 'b' })
  expect(cyclePanel(api, 1)).toMatchObject({ panelId: 'thread' })
  expect(cyclePanel(api, -1)).toMatchObject({ panelId: 'b' })
})

test('the conversation does not close; another panel does', () => {
  const { api } = fakeDock([
    [
      'g1',
      [
        ['thread', 'thread'],
        ['a', 'artifact'],
      ],
    ],
  ])
  expect(closePanel(api, 'thread')).toMatchObject({ status: 'none' })
  expect(closePanel(api, 'a')).toEqual({ status: 'closed', panelId: 'a' })
  expect(api.getPanel('a')).toBeUndefined()
})

test('move without a place goes into the next group; a direction splits beside a panel', () => {
  const { api, moves } = fakeDock([
    ['g1', [['thread', 'thread']]],
    ['g2', [['a', 'artifact']]],
  ])
  expect(movePanel(api, { id: 'thread' })).toEqual({
    status: 'moved',
    panelId: 'thread',
  })
  expect(moves[0]).toEqual({ id: 'thread', to: { group: api.groups[1] } })
  movePanel(api, { id: 'thread', to: 'right', reference: 'a' })
  expect(moves[1]).toEqual({
    id: 'thread',
    to: { group: api.groups[1], position: 'right' },
  })
  expect(movePanel(api, { id: 'nope' })).toMatchObject({ status: 'none' })
})

test('a lone panel has nowhere to move to and says so', () => {
  const { api } = fakeDock([['g1', [['thread', 'thread']]]])
  expect(movePanel(api, { id: 'thread' })).toMatchObject({ status: 'none' })
})

test('the commands register under theorem.panel.* with key bindings and follow the mounted dock', async () => {
  const { api } = fakeDock([
    [
      'g1',
      [
        ['thread', 'thread'],
        ['a', 'artifact'],
      ],
    ],
  ])
  const mounted = { current: undefined as DockviewApi | undefined }
  const remove = registerPanelCommands(() => mounted.current)
  const context = { focus: 'none', path: '/' } as const
  const before = await executeCommand(
    'theorem.panel.next',
    undefined,
    context,
    'palette',
  )
  // With no dock mounted the commands do not apply.
  expect(before).toMatchObject({ ok: false, reason: 'not-applicable' })
  mounted.current = api
  const after = await executeCommand(
    'theorem.panel.next',
    undefined,
    context,
    'keybinding',
  )
  expect(after).toMatchObject({ ok: true, value: { status: 'focused' } })
  const opened = await executeCommand(
    'theorem.panel.open',
    { component: 'note', params: { documentId: 'z' } },
    context,
    'code',
  )
  expect(opened).toMatchObject({ ok: true, value: { status: 'opened' } })
  const invalid = await executeCommand(
    'theorem.panel.focus',
    {},
    context,
    'code',
  )
  expect(invalid).toMatchObject({ ok: false, reason: 'invalid-args' })
  remove()
  expect(
    await executeCommand('theorem.panel.next', undefined, context, 'code'),
  ).toMatchObject({ ok: false, reason: 'unknown' })
})
