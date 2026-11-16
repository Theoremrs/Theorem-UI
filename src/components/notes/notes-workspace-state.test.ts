// SOURCING: bun:test over a headless dockview-core DockviewComponent, the
// engine under the notes workspace's DockviewReact, so the panes are real groups.
import { afterEach, expect, test } from 'bun:test'
import { DockviewComponent } from 'dockview-core'
import type { DockviewApi } from 'dockview-core'
import {
  documentOfPane,
  notePaneId,
  openBeside,
  openInFocus,
  useNotesWorkspace,
} from './notes-workspace-state'

const opened: Array<DockviewComponent> = []
afterEach(() => {
  for (const component of opened.splice(0)) component.dispose()
  useNotesWorkspace.setState({ api: undefined })
  document.body.innerHTML = ''
})

function workspace(): DockviewApi {
  const element = document.createElement('div')
  document.body.append(element)
  const part = () => ({ element: document.createElement('div'), init: () => undefined })
  const component = new DockviewComponent(element, {
    createComponent: part,
    createTabComponent: part,
  })
  component.layout(1200, 800)
  opened.push(component)
  return component.api
}

/** Each pane's notes, in the order dockview lists the groups. */
const panes = (api: DockviewApi) =>
  api.groups.map((group) => group.panels.map((panel) => documentOfPane(panel.id)))

test('the first note opens as the only pane, and has focus', () => {
  const api = workspace()
  openInFocus(api, 'doc-a')
  expect(panes(api)).toEqual([['doc-a']])
  expect(api.activePanel?.id).toBe(notePaneId('doc-a'))
})

test('the list opens a note in place of the focused pane’s note, leaving the other panes be', () => {
  const api = workspace()
  openInFocus(api, 'doc-a')
  openBeside(api, 'doc-b')
  openInFocus(api, 'doc-c')
  expect(panes(api)).toEqual([['doc-a'], ['doc-c']])
  expect(api.activePanel?.id).toBe(notePaneId('doc-c'))
})

test('a note already open is focused where it is, not opened twice', () => {
  const api = workspace()
  openInFocus(api, 'doc-a')
  openBeside(api, 'doc-b')
  openInFocus(api, 'doc-a')
  expect(panes(api)).toEqual([['doc-a'], ['doc-b']])
  expect(api.activePanel?.id).toBe(notePaneId('doc-a'))
  openBeside(api, 'doc-b')
  expect(api.groups).toHaveLength(2)
  expect(api.activePanel?.id).toBe(notePaneId('doc-b'))
})

test('open to the side adds a pane to the right of the focused one', () => {
  const api = workspace()
  openInFocus(api, 'doc-a')
  openBeside(api, 'doc-b')
  const { root, orientation } = api.toJSON().grid
  expect(orientation).toBe('HORIZONTAL')
  expect(Array.isArray(root.data) && root.data.map((leaf) => leaf.data)).toEqual([
    expect.objectContaining({ views: [notePaneId('doc-a')] }),
    expect.objectContaining({ views: [notePaneId('doc-b')] }),
  ])
})

test('the store opens beside only while the workspace is on screen, and closes a note’s pane', () => {
  expect(useNotesWorkspace.getState().openBeside('doc-a')).toBe(false)
  const api = workspace()
  useNotesWorkspace.setState({ api })
  openInFocus(api, 'doc-a')
  expect(useNotesWorkspace.getState().openBeside('doc-b')).toBe(true)
  expect(panes(api)).toEqual([['doc-a'], ['doc-b']])
  useNotesWorkspace.getState().close('doc-a')
  expect(panes(api)).toEqual([['doc-b']])
})
