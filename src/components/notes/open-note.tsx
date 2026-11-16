// SOURCING: NotePanel (the Milkdown note at full size), ui/button, @tanstack/react-router (a new note opens at its route), the note library's mutations (Theorem Documents v2: create), the note's actions and notices (note-actions.tsx)
import { useNavigate } from '@tanstack/react-router'
import { Icon } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { describeError } from '@/lib/theorem/client'
import { useNewNote } from '@/lib/theorem/note-library'
import { useNote } from '@/lib/theorem/notes'
import { hasOwnNotice, NoteActions, ReadOnlyNotice } from './note-actions'
import { NotePanel } from './note-panel'

export function NoNoteOpen() {
  const navigate = useNavigate()
  const create = useNewNote()
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <p className="font-heading text-[20px] font-medium">Notes</p>
      <p className="max-w-md text-sm text-ink-muted">
        Notes are Theorem documents. What you write here, and what agents encode
        from their memory, is kept in the graph.
      </p>
      <Button
        variant="outline"
        size="sm"
        disabled={create.isPending}
        onClick={() =>
          create.mutate(undefined, {
            onSuccess: (note) =>
              void navigate({
                to: '/notes/$documentId',
                params: { documentId: note.documentId },
              }),
          })
        }
      >
        <Icon.NewNote />
        New note
      </Button>
      {create.error && (
        <p role="alert" className="text-sm text-error-ink">
          {describeError(create.error, 'document')}
        </p>
      )}
    </div>
  )
}

/** One open note: on a phone with its own header, in a workspace pane as a page under the pane's pills. */
export function OpenNote({
  documentId,
  chrome = 'header',
}: {
  documentId: string
  chrome?: 'header' | 'page'
}) {
  const note = useNote(documentId)
  return (
    <NotePanel
      documentId={documentId}
      chrome={chrome}
      actions={
        chrome === 'header' && note.data && <NoteActions note={note.data} />
      }
      readOnlyNotice={
        note.data && hasOwnNotice(note.data) ? (
          <ReadOnlyNotice note={note.data} />
        ) : undefined
      }
    />
  )
}

