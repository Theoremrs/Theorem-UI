// Real Dockview engine: resizing must move existing groups, never recreate drafts.
import { afterEach, expect, test } from 'bun:test'
import { DockviewComponent } from 'dockview-core'
import { adaptDock } from './responsive-dock'
import { waitFor } from '../../../test/workspace'

const cleanups: Array<() => void> = []
afterEach(() => {
  cleanups
    .splice(0)
    .reverse()
    .forEach((fn) => fn())
  document.body.innerHTML = ''
  document.documentElement.style.fontSize = ''
})
const frame = () =>
  new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  )
function setup({ stacked = false, width = 400 } = {}) {
  document.documentElement.style.fontSize = '16px'
  const host = document.createElement('div')
  document.body.append(host)
  const component = new DockviewComponent(host, {
    createComponent: () => ({
      element: document.createElement('div'),
      init: () => undefined,
    }),
  })
  component.layout(1200, 800)
  const api = component.api
  const thread = api.addPanel({
    id: 'thread',
    component: 'thread',
    renderer: 'always',
  })
  const inspector = api.addPanel({
    id: 'outline',
    component: 'outline',
    initialWidth: width,
    minimumWidth: 340,
    position: { referencePanel: 'thread', direction: 'right' },
  })
  const graph = stacked
    ? api.addPanel({
        id: 'graph',
        component: 'graph',
        initialHeight: 300,
        minimumWidth: 200,
        position: { referencePanel: 'outline', direction: 'below' },
      })
    : undefined
  const adapter = adaptDock(api, host)
  cleanups.push(
    () => component.dispose(),
    () => adapter.dispose(),
  )
  return { api, component, thread, inspector, graph, adapter }
}

/** Nothing floats over the conversation, whatever the dock's width. */
const floats = (api: ReturnType<typeof setup>['api']) =>
  api.groups.filter((group) => group.api.location.type !== 'grid')

test('a column opened too wide gives the conversation its reading width and stays docked', async () => {
  const { api, thread, inspector } = setup({ width: 700 })
  await waitFor(() => thread.api.width >= 560)
  expect(floats(api)).toEqual([])
  expect(inspector.group === thread.group).toBe(false)
  expect(inspector.group.api.width).toBeGreaterThanOrEqual(340)
  expect(thread.api.width + inspector.group.api.width).toBe(1200)
})

test('a dock too narrow for a column stacks its panels behind the conversation and gives the same panel its column back when room returns', async () => {
  const { api, component, thread, inspector } = setup()
  await frame()
  const column = inspector.group.id
  thread.api.setActive()
  component.layout(800, 800)
  await waitFor(() => inspector.group === thread.group)
  expect(floats(api)).toEqual([])
  expect(api.groups).toHaveLength(1)
  expect(thread.group.activePanel?.id).toBe('thread')
  expect(api.getPanel('outline') === inspector).toBe(true)
  component.layout(320, 800)
  await frame()
  expect(api.minimumWidth).toBeLessThanOrEqual(320)
  component.layout(1400, 800)
  await waitFor(() => inspector.group !== thread.group)
  expect(floats(api)).toEqual([])
  expect(inspector.group.id).toBe(column)
  expect(api.getPanel('outline') === inspector).toBe(true)
  expect(Math.abs(inspector.group.api.width - 400)).toBeLessThanOrEqual(1)
  expect(thread.api.width).toBeGreaterThanOrEqual(560)
  expect(thread.group.panels.map((panel) => panel.id)).toEqual(['thread'])
})

test('the column in use stays in front when it stacks', async () => {
  const { component, thread, inspector } = setup()
  await frame()
  inspector.api.setActive()
  component.layout(800, 800)
  await waitFor(() => inspector.group === thread.group)
  expect(thread.group.activePanel?.id).toBe('outline')
})

test('a panel closed while it is stacked is not resurrected by widening the window', async () => {
  const { api, component, thread, inspector } = setup()
  component.layout(800, 800)
  await waitFor(() => inspector.group === thread.group)
  api.removePanel(inspector)
  component.layout(1400, 800)
  await frame()
  expect(api.getPanel('outline')).toBeUndefined()
  expect(api.panels).toHaveLength(1)
  expect(api.groups).toHaveLength(1)
})

function shape(
  node: ReturnType<ReturnType<typeof setup>['api']['toJSON']>['grid']['root'],
): unknown {
  return Array.isArray(node.data) ? node.data.map(shape) : node.data.views
}

test('stacked inspectors recover their preferred split, size and mounted panels', async () => {
  const { api, component, thread, inspector, graph } = setup({ stacked: true })
  await frame()
  const upper = inspector.group
  const lower = graph!.group
  const before = {
    width: upper.api.width,
    top: upper.api.height,
    bottom: lower.api.height,
  }
  const expected = shape(api.toJSON().grid.root)
  component.layout(320, 800)
  await waitFor(() =>
    [inspector, graph!].every((panel) => panel.group === thread.group),
  )
  expect(floats(api)).toEqual([])
  component.layout(1200, 800)
  await waitFor(() =>
    [inspector, graph!].every((panel) => panel.group !== thread.group),
  )
  expect(shape(api.toJSON().grid.root)).toEqual(expected)
  expect(api.getPanel('outline') === inspector).toBe(true)
  expect(api.getPanel('graph') === graph).toBe(true)
  expect(inspector.group.id).toBe(upper.id)
  expect(graph!.group.id).toBe(lower.id)
  expect(
    Math.abs(inspector.group.api.width - before.width),
  ).toBeLessThanOrEqual(1)
  expect(Math.abs(graph!.group.api.width - before.width)).toBeLessThanOrEqual(1)
  expect(Math.abs(inspector.group.api.height - before.top)).toBeLessThanOrEqual(
    1,
  )
  expect(Math.abs(graph!.group.api.height - before.bottom)).toBeLessThanOrEqual(
    1,
  )
})

test('only the columns the conversation needs room from stack', async () => {
  const { component, thread, inspector, graph } = setup({ stacked: true })
  await frame()
  // The conversation's 560 and the outline's 340 leave the graph its 200.
  component.layout(800, 800)
  await waitFor(() => inspector.group === thread.group)
  await frame()
  expect(graph!.group === thread.group).toBe(false)
  expect(thread.api.width).toBeGreaterThanOrEqual(560)
})

test('saves while stacked keep each column in place, with closures and additions, and never the temporary tabs', async () => {
  const { api, component, thread, inspector, graph, adapter } = setup({
    stacked: true,
  })
  await frame()
  const wide = adapter.layoutForSave()!
  component.layout(320, 800)
  await waitFor(() =>
    [inspector, graph!].every((panel) => panel.group === thread.group),
  )
  expect(shape(adapter.layoutForSave()!.grid.root)).toEqual(
    shape(wide.grid.root),
  )
  // A column opened while the dock is narrow stacks too, and saves as a column.
  const extra = api.addPanel({
    id: 'links',
    component: 'links',
    minimumWidth: 340,
    position: { referencePanel: 'thread', direction: 'right' },
  })
  await waitFor(() => extra.group === thread.group)
  api.removePanel(inspector)
  await frame()
  const saved = adapter.layoutForSave()!
  expect(Object.keys(saved.panels).sort()).toEqual(['graph', 'links', 'thread'])
  const grid = JSON.stringify(shape(saved.grid.root))
  expect(grid).not.toContain('outline')
  expect(grid).toContain('links')
  expect(shape(saved.grid.root)).toContainEqual(['thread'])
  expect(saved.floatingGroups).toBeUndefined()
  expect(saved.grid.width).toBe(wide.grid.width)
  expect(api.getPanel('links') === extra).toBe(true)
  const reloaded = new DockviewComponent(document.createElement('div'), {
    createComponent: () => ({
      element: document.createElement('div'),
      init: () => undefined,
    }),
  })
  cleanups.push(() => reloaded.dispose())
  reloaded.layout(1200, 800)
  reloaded.api.fromJSON(saved)
  expect(reloaded.api.getPanel('outline')).toBeUndefined()
  const links = reloaded.api.getPanel('links')!
  expect(links.api.location.type).toBe('grid')
  expect(links.group === reloaded.api.getPanel('thread')!.group).toBe(false)
})
