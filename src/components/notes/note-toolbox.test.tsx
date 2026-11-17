// SOURCING: bun:test with the workspace render harness (test/workspace), as
// note-context.test.tsx renders NoteEditor; the pane-keyed registry and its
// toolbox (note-tools.ts, note-toolbox.tsx).
import { afterEach, expect, test } from 'bun:test'
import { act } from 'react'
import { cleanup, render, waitFor } from '../../../test/workspace'
import { noteKey } from '@/lib/theorem/notes'
import type { Note } from '@/lib/theorem/notes'
import { NoteEditor } from './note-editor'
import { NoteToolbox } from './note-toolbox'
import { useNoteTools } from './note-tools'

afterEach(cleanup)

const note: Note = {
  documentId: 'note-toolbox-pane',
  title: 'Note',
  markdown: 'Saved.',
  savedMarkdown: 'Saved.',
  revision: { position: 17, contentDigest: 'digest' },
  canonical: undefined,
  editable: true,
  origin: {
    kind: 'user_authored',
    actorId: 'person:test',
    originSurface: 'test',
  },
  retired: false,
}

const click = (element: Element) =>
  act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })

test("a pane's toolbox acts in its own editor, not another view of the same note", async () => {
  const key = `note:${note.documentId}`
  const pane = await render(<NoteEditor note={note} toolsKey={key} />)
  pane.queryClient.setQueryData(noteKey(note.documentId), note)
  await waitFor(() => pane.container.querySelector('.ProseMirror'))
  // The same note opens beside the workspace: the dock, or a canvas card.
  const other = await render(<NoteEditor note={note} />)
  other.queryClient.setQueryData(noteKey(note.documentId), note)
  await waitFor(() => other.container.querySelector('.ProseMirror'))

  expect(useNoteTools.getState().tools[key]).toBeDefined()
  expect(useNoteTools.getState().tools[note.documentId]).toBeUndefined()

  const pill = await render(<NoteToolbox toolsKey={key} />)
  const toolbox = await waitFor(() =>
    pill.container.querySelector('[data-note-toolbox]'),
  )
  await click(toolbox.querySelector('button[aria-label="Add a table"]')!)
  await waitFor(() => pane.container.querySelector('table'))
  expect(other.container.querySelector('table')).toBeNull()

  // Closing the other view leaves the pane's tools; closing the pane takes them.
  await act(async () => other.root.unmount())
  expect(useNoteTools.getState().tools[key]).toBeDefined()
  await act(async () => pane.root.unmount())
  expect(useNoteTools.getState().tools[key]).toBeUndefined()
})
