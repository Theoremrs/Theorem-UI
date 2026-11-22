// SOURCING: zustand (the notes workspace's dock, set while Notes mode shows it), dockview-core's DockviewApi (where each open note sits)
import type { DockviewApi, IDockviewPanel } from 'dockview-react'
import { create } from 'zustand'

/** A note's pane id in the notes workspace. */
export const NOTE_PANE = 'note:'
export const notePaneId = (documentId: string) => `${NOTE_PANE}${documentId}`
export const documentOfPane = (panelId: string) =>
  panelId.startsWith(NOTE_PANE) ? panelId.slice(NOTE_PANE.length) : undefined

/** Where the workspace's layout is kept on this device. */
export const LAYOUT_KEY = 'theorem-ui:notes-workspace'

const paneOptions = (documentId: string) => ({
  id: notePaneId(documentId),
  component: 'note',
  tabComponent: 'note',
  params: { documentId },
  title: 'Note',
  minimumWidth: 320,
})

/**
 * Opens a note in the pane that has focus, in place of the note it shows:
 * the list browses in the pane you are working in. A note already open
 * anywhere is focused where it is.
 */
export function openInFocus(api: DockviewApi, documentId: string) {
  const existing = api.getPanel(notePaneId(documentId))
  if (existing) {
    existing.api.setActive()
    return existing
  }
  const replaced: IDockviewPanel | undefined = api.activePanel ?? undefined
  const added = replaced
    ? api.addPanel({
        ...paneOptions(documentId),
        position: { referencePanel: replaced.id, direction: 'within' },
      })
    : api.addPanel(paneOptions(documentId))
  if (replaced) api.removePanel(replaced)
  added.api.setActive()
  return added
}

/** Opens a note in a new pane to the right of the one that has focus. */
export function openBeside(api: DockviewApi, documentId: string) {
  const existing = api.getPanel(notePaneId(documentId))
  if (existing) {
    existing.api.setActive()
    return existing
  }
  const reference = api.activeGroup
  const added = reference
    ? api.addPanel({
        ...paneOptions(documentId),
        position: { referenceGroup: reference, direction: 'right' },
      })
    : api.addPanel(paneOptions(documentId))
  added.api.setActive()
  return added
}

type NotesWorkspace = {
  /** Set while Notes mode shows the workspace. */
  api: DockviewApi | undefined
  /**
   * Opens a note in a new pane beside the focused one. False without the
   * workspace on screen (a phone), where the caller opens it the usual way.
   */
  openBeside: (documentId: string) => boolean
  /** Closes the note's pane, if it is open. */
  close: (documentId: string) => void
}

export const useNotesWorkspace = create<NotesWorkspace>()((_set, get) => ({
  api: undefined,
  openBeside: (documentId) => {
    const { api } = get()
    if (api) openBeside(api, documentId)
    return Boolean(api)
  },
  close: (documentId) => {
    const { api } = get()
    const panel = api?.getPanel(notePaneId(documentId))
    if (api && panel) api.removePanel(panel)
  },
}))
