// SOURCING: the notes workspace (dockview panes, notes-workspace.tsx), OpenNote and NoNoteOpen (open-note.tsx), @tanstack/react-router (the open note is the route's documentId)
import { useParams } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { NotesWorkspace } from './notes-workspace'
import { NoNoteOpen, OpenNote } from './open-note'

/**
 * Notes mode's main view. On the desktop it is a workspace of panes, each an
 * open note, that you split, drag and close; on a phone, the open note.
 * Either way a note is the route's, or there is a way to start one.
 */
export function NotesView({
  docked = false,
  actions,
}: {
  docked?: boolean
  /** The shell's panel controls, for the workspace's top-right pane. */
  actions?: ReactNode
}) {
  const { documentId } = useParams({ strict: false })
  if (docked) return <NotesWorkspace actions={actions} />
  return documentId ? (
    <OpenNote key={documentId} documentId={documentId} />
  ) : (
    <NoNoteOpen />
  )
}
