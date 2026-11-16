// SOURCING: Base UI Menu through coss ui (Move to, Trash and Restore, the way the project switcher picks one of several), ui/button, @tanstack/react-router (a promoted note opens at its own route), the note library's mutations (Theorem Documents v2: retire, restore, promote), the note folders (Theorem's document collections)
import { Menu } from '@base-ui/react/menu'
import { useNavigate } from '@tanstack/react-router'
import { Folder } from 'lucide-react'
import { Icon } from '@/components/icons'
import {
  Menu as PaneMenu,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from '@/components/coss/menu'
import { menuItem, menuPopup } from '@/components/shell/sidebar'
import { Button, buttonVariants } from '@/components/ui/button'
import { describeError } from '@/lib/theorem/client'
import { useMoveNote, useNoteFolders } from '@/lib/theorem/note-folders'
import {
  noteEntry,
  useNoteLifecycle,
  usePromoteNote,
} from '@/lib/theorem/note-library'
import type { Note } from '@/lib/theorem/notes'

const TOP_LEVEL = ''

/**
 * A pane's menu in the notes workspace, behind the chevron beside its
 * title: where the note is filed, the Trash, and closing the pane. Agent
 * memory is never trashed through the document product, so its menu only
 * closes. A failed change says so beside the title.
 */
export function NoteMenu({
  note,
  onClose,
  onTrashed,
}: {
  note: Note
  onClose: () => void
  /** The note went to the Trash; its pane closes. */
  onTrashed: () => void
}) {
  const lifecycle = useNoteLifecycle()
  const folders = useNoteFolders()
  const move = useMoveNote()
  const owned = noteEntry(note).source !== 'encoded'
  const action = note.retired ? 'restore' : 'retire'
  const filing = owned && !note.retired ? folders.data : undefined
  const current = filing?.folderOf.get(note.documentId) ?? TOP_LEVEL
  const error = lifecycle.error ?? move.error
  return (
    <>
      <PaneMenu>
        <MenuTrigger
          aria-label={`${note.title || 'Note'} options`}
          className="flex size-6 shrink-0 items-center justify-center rounded-full text-ink-muted outline-none hover:bg-hover hover:text-ink focus-visible:outline-2 focus-visible:outline-focus data-popup-open:bg-hover data-popup-open:text-ink"
        >
          <Icon.ChevronDown className="size-3.5" />
        </MenuTrigger>
        <MenuPopup side="bottom" align="start" className="min-w-48">
          {filing && filing.folders.length > 0 && (
            <MenuSub>
              <MenuSubTrigger disabled={move.isPending}>
                <Folder aria-hidden="true" />
                Move to
              </MenuSubTrigger>
              <MenuSubPopup className="min-w-44">
                <MenuRadioGroup
                  value={current}
                  onValueChange={(value: string) => {
                    if (value === current) return
                    move.mutate({
                      documentId: note.documentId,
                      to: value === TOP_LEVEL ? null : value,
                    })
                  }}
                >
                  <MenuRadioItem value={TOP_LEVEL}>No folder</MenuRadioItem>
                  {filing.folders.map((folder) => (
                    <MenuRadioItem
                      key={folder.collectionId}
                      value={folder.collectionId}
                    >
                      {folder.name}
                    </MenuRadioItem>
                  ))}
                </MenuRadioGroup>
              </MenuSubPopup>
            </MenuSub>
          )}
          {owned && (
            <MenuItem
              disabled={lifecycle.isPending}
              onClick={() =>
                lifecycle.mutate(
                  { action, documentId: note.documentId },
                  {
                    onSuccess: () => {
                      if (action === 'retire') onTrashed()
                    },
                  },
                )
              }
            >
              {note.retired ? <Icon.Undo /> : <Icon.Delete />}
              {note.retired ? 'Restore' : 'Move to Trash'}
            </MenuItem>
          )}
          {owned && <MenuSeparator />}
          <MenuItem onClick={onClose}>
            <Icon.Close />
            Close pane
          </MenuItem>
        </MenuPopup>
      </PaneMenu>
      {error && (
        <span role="alert" className="max-w-48 truncate text-xs text-error-ink">
          {describeError(error, 'document')}
        </span>
      )}
    </>
  )
}

/** Trash or Restore. Agent memory is never trashed through the document product. */
export function NoteActions({ note }: { note: Note }) {
  const navigate = useNavigate()
  const lifecycle = useNoteLifecycle()
  if (noteEntry(note).source === 'encoded') return null
  const action = note.retired ? 'restore' : 'retire'
  return (
    <>
      {!note.retired && <MoveToFolder documentId={note.documentId} />}
      {lifecycle.error && (
        <span role="alert" className="truncate text-xs text-error-ink">
          {describeError(lifecycle.error, 'document')}
        </span>
      )}
      <Button
        variant="ghost"
        size="xs"
        disabled={lifecycle.isPending}
        onClick={() =>
          lifecycle.mutate(
            { action, documentId: note.documentId },
            {
              onSuccess: () => {
                if (action === 'retire') void navigate({ to: '/notes' })
              },
            },
          )
        }
      >
        {note.retired ? (
          <>
            <Icon.Undo />
            Restore
          </>
        ) : (
          <>
            <Icon.Delete />
            Move to Trash
          </>
        )}
      </Button>
    </>
  )
}

/** Move the open note into a folder or out to the top level, without dragging. */
function MoveToFolder({ documentId }: { documentId: string }) {
  const folders = useNoteFolders()
  const move = useMoveNote()
  if (!folders.data?.folders.length) return null
  const { folderOf } = folders.data
  const current = folderOf.get(documentId) ?? TOP_LEVEL
  const options = [
    { value: TOP_LEVEL, name: 'No folder' },
    ...folders.data.folders.map((folder) => ({
      value: folder.collectionId,
      name: folder.name,
    })),
  ]
  return (
    <>
      {move.error && (
        <span role="alert" className="truncate text-xs text-error-ink">
          {describeError(move.error, 'document')}
        </span>
      )}
      <Menu.Root>
        <Menu.Trigger
          className={buttonVariants({ variant: 'ghost', size: 'xs' })}
          disabled={move.isPending}
        >
          <Folder aria-hidden="true" />
          Move to
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner
            side="bottom"
            align="end"
            sideOffset={4}
            className="z-50"
          >
            <Menu.Popup className={`min-w-44 ${menuPopup}`}>
              <Menu.RadioGroup
                value={current}
                onValueChange={(value) => {
                  if (value === current) return
                  move.mutate({
                    documentId,
                    to: value === TOP_LEVEL ? null : String(value),
                  })
                }}
              >
                {options.map((option) => (
                  <Menu.RadioItem
                    key={option.value || 'top-level'}
                    value={option.value}
                    closeOnClick
                    className={`${menuItem} data-checked:font-medium`}
                  >
                    <span className="min-w-0 flex-1 truncate">
                      {option.name}
                    </span>
                    <Menu.RadioItemIndicator>
                      <Icon.Check className="size-3.5" />
                    </Menu.RadioItemIndicator>
                  </Menu.RadioItem>
                ))}
              </Menu.RadioGroup>
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
    </>
  )
}

/**
 * Whether Notes mode says more than the editor's own read-only notice: the
 * note is in the Trash, or an agent wrote it and it can be made editable.
 */
export const hasOwnNotice = (note: Note) =>
  note.retired || Boolean(noteEntry(note).promotion)

export function ReadOnlyNotice({ note }: { note: Note }) {
  const navigate = useNavigate()
  const promote = usePromoteNote()
  const { promotion } = noteEntry(note)
  if (note.retired || !promotion)
    return <span>In the Trash. Restore it to edit it.</span>
  return (
    <>
      <span className="me-auto">
        An agent wrote this from its memory. Make an editable copy to change it.
      </span>
      {promote.error && (
        <span role="alert" className="text-error-ink">
          {describeError(promote.error, 'document')}
        </span>
      )}
      <Button
        variant="outline"
        size="xs"
        disabled={promote.isPending}
        onClick={() =>
          promote.mutate(
            { ...promotion, title: note.title },
            {
              onSuccess: ({ promotedDocument }) =>
                void navigate({
                  to: '/notes/$documentId',
                  params: { documentId: promotedDocument.documentId },
                }),
            },
          )
        }
      >
        Make editable
      </Button>
    </>
  )
}
