// SOURCING: the pieces the record preview and the record page share — Twenty's record side panel for the anatomy (an editable title over label and value rows); the schema register's inline editors (components/records/fields); coss ui Switch; the app's Dialog and Button; the composer's reference store (components/chat/composer-references) and the shell's open conversation (components/shell/shell-state) for "Ask Theorem"; lucide-react marks
import { useNavigate } from '@tanstack/react-router'
import { Pencil, Sparkles, Trash2 } from 'lucide-react'
import { useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  useComposerReferences,
  focusComposer,
} from '@/components/chat/composer-references'
import { Switch } from '@/components/coss/switch'
import type { FieldSpec, ObjectType } from '@/components/records/contract'
import { FieldEditor, FieldTypeIcon } from '@/components/records/fields'
import {
  displayHint,
  fieldByKey,
  identifierField,
  isEmptyValue,
  recordTitle,
} from '@/components/records/model'
import { useShell } from '@/components/shell/shell-state'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { describeError, withoutCode } from '@/lib/theorem/client'
import { cn } from '@/lib/utils'
import { RecordAccessError, RevisionConflictError } from './api'
import type { CrmRecord } from './api'
import {
  CrmEditorPopover,
  CrmFieldValue,
  EditMark,
  RecordMark,
  YouBadge,
  editStyle,
} from './cells'
import { useCrmScope } from './context'
import {
  CONTEXT_USE_FIELD,
  builtInName,
  changeValue,
  describeCrmError,
  hasContextUse,
  isPrivate,
  shownFields,
} from './model'
import {
  editorRead,
  useBindSelfPerson,
  useFieldEdit,
  useUnsavedEdits,
} from './queries'
import type { CrmWrites, EditorRead, FieldEdit } from './queries'
import { recordReference } from './reference'

/** A refusal or failure in words the person can act on. */
export const crmErrorText = (error: unknown, type: ObjectType | undefined) =>
  describeCrmError(error, type, (e) => withoutCode(describeError(e)))

const quiet =
  'rounded-md px-1.5 py-0.5 text-xs font-medium text-ink underline-offset-2 hover:bg-hover hover:underline focus-visible:outline-2 focus-visible:outline-focus'

// Edits that are not saved

function UnsavedEdit({
  type,
  record,
  edit,
  writes,
  named,
}: {
  type: ObjectType
  record: CrmRecord | undefined
  edit: FieldEdit
  writes: CrmWrites
  /** Name the record, where edits of several records are listed together. */
  named: boolean
}) {
  const { titleOf } = useCrmScope()
  const [reloadError, setReloadError] = useState<unknown>(null)
  const field = fieldByKey(type, edit.fieldKey)
  const label =
    edit.fieldKey === CONTEXT_USE_FIELD
      ? 'Private to me'
      : (field?.label ?? edit.fieldKey)
  const entered =
    edit.fieldKey === CONTEXT_USE_FIELD
      ? edit.value === 'private'
        ? 'on'
        : 'off'
      : changeValue(field, edit.value, titleOf)
  const saved =
    record && edit.fieldKey !== CONTEXT_USE_FIELD
      ? changeValue(field, record.values[edit.fieldKey], titleOf)
      : undefined
  const refused = edit.error instanceof RecordAccessError
  return (
    <li className="flex flex-wrap items-center gap-x-2 gap-y-1 py-1">
      <p className="min-w-0 flex-1 basis-56 text-xs leading-5 text-ink">
        {named && record && (
          <span className="font-medium">{recordTitle(type, record)}: </span>
        )}
        Your change to {label} (“{entered}”) is not saved.{' '}
        {edit.status === 'conflict'
          ? `${crmErrorText(edit.error, type)} Reload it to see what changed; your change is kept here.`
          : edit.status === 'held'
            ? `It was reloaded at revision ${record?.version ?? edit.readRevision}${saved !== undefined ? `, where ${label} is “${saved}”` : ''}.`
            : crmErrorText(edit.error, type)}
        {reloadError !== null &&
          ` Reloading failed: ${crmErrorText(reloadError, type)}`}
      </p>
      <span className="flex shrink-0 items-center gap-1">
        {edit.status === 'conflict' && (
          <button
            type="button"
            className={quiet}
            onClick={() => {
              setReloadError(null)
              writes.reload(edit.recordId).catch(setReloadError)
            }}
          >
            Reload
          </button>
        )}
        {edit.status === 'held' && (
          <button
            type="button"
            className={quiet}
            onClick={() => void writes.apply(edit)}
          >
            Save my change
          </button>
        )}
        {edit.status === 'failed' && !refused && (
          <button
            type="button"
            className={quiet}
            onClick={() => void writes.apply(edit)}
          >
            Try again
          </button>
        )}
        <button
          type="button"
          className={cn(quiet, 'text-ink-muted')}
          onClick={() => writes.discard(edit)}
        >
          Discard
        </button>
      </span>
    </li>
  )
}

/**
 * The edits Theorem has not saved: refused, or made against a record that
 * moved on. Each keeps what was entered until it is saved or discarded.
 */
export function UnsavedEdits({
  type,
  recordId,
  recordOf,
  writes,
  className,
}: {
  type: ObjectType
  /** One record's edits; without it, every edit to this type's records. */
  recordId?: string
  recordOf: (id: string) => CrmRecord | undefined
  writes: CrmWrites
  className?: string
}) {
  const edits = useUnsavedEdits(recordId).filter(
    (edit) => edit.objectTypeId === type.object_type_id,
  )
  if (!edits.length) return null
  return (
    <section
      role="alert"
      aria-label="Changes that are not saved"
      className={cn(
        'border-y border-separator bg-error-container/40 px-3 py-1',
        className,
      )}
    >
      <ul className="divide-y divide-separator">
        {edits.map((edit) => (
          <UnsavedEdit
            key={`${edit.recordId}:${edit.fieldKey}`}
            type={type}
            record={recordOf(edit.recordId)}
            edit={edit}
            writes={writes}
            named={recordId === undefined}
          />
        ))}
      </ul>
    </section>
  )
}

// Title

/** A record's name, large; it edits in place. Enter or leaving saves, Escape cancels. */
export function TitleField({
  type,
  record,
  writes,
  writable,
  className,
}: {
  type: ObjectType
  record: CrmRecord
  writes: CrmWrites
  writable: boolean
  className?: string
}) {
  const identifier = identifierField(type)
  const edit = useFieldEdit(record.id, identifier?.key ?? '')
  const [draft, setDraft] = useState<string | null>(null)
  // What the record was when the title was opened for editing.
  const read = useRef<EditorRead | null>(null)
  const left = useRef(false)
  const title =
    edit && typeof edit.value === 'string'
      ? edit.value
      : recordTitle(type, record)
  const canEdit = writable && identifier !== undefined && !identifier.system
  const commit = () => {
    if (left.current || draft === null || !identifier) return
    const text = draft.trim()
    setDraft(null)
    // A record keeps a name: an emptied title is not sent.
    if (text)
      void writes.saveFrom(
        record,
        identifier,
        text,
        read.current ?? editorRead(record, identifier, edit),
      )
  }
  if (draft !== null)
    return (
      <input
        autoFocus
        value={draft}
        aria-label={identifier?.label ?? 'Name'}
        onFocus={() => {
          left.current = false
        }}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            commit()
          } else if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            left.current = true
            setDraft(null)
          }
        }}
        className={cn(
          'w-full min-w-0 rounded-md bg-background px-1 text-ink outline-2 outline-focus',
          className,
        )}
      />
    )
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      {canEdit ? (
        <button
          type="button"
          title={`Rename ${title}`}
          onClick={() => {
            read.current = editorRead(record, identifier, edit)
            setDraft(title === 'Untitled' ? '' : title)
          }}
          className={cn(
            'min-w-0 truncate rounded-md px-1 text-start text-ink hover:bg-hover focus-visible:outline-2 focus-visible:outline-focus',
            className,
          )}
        >
          {title}
        </button>
      ) : (
        <span className={cn('min-w-0 truncate px-1 text-ink', className)}>
          {title}
        </span>
      )}
      <EditMark edit={edit} />
    </span>
  )
}

// Properties

function PropertyRow({
  type,
  record,
  field,
  writes,
  writable,
  whole,
  onOpenRelated,
}: {
  type: ObjectType
  record: CrmRecord
  field: FieldSpec
  writes: CrmWrites
  writable: boolean
  whole: boolean
  onOpenRelated: (type: ObjectType, id: string) => void
}) {
  const edit = useFieldEdit(record.id, field.key)
  // What the record was when this row's editor opened; null while it is shut.
  const [opened, setOpened] = useState<EditorRead | null>(null)
  const editing = opened !== null
  const setEditing = (open: boolean) =>
    setOpened(open ? editorRead(record, field, edit) : null)
  // The row, as an element the editor's popover is placed against.
  const [anchor, setAnchor] = useState<HTMLDivElement | null>(null)
  const value = edit ? edit.value : record.values[field.key]
  const style = editStyle(field)
  const canEdit = writable && style !== 'none' && edit?.status !== 'saving'
  const opens = canEdit && (style === 'inline' || style === 'popover')
  const commit = (next: unknown) => {
    setEditing(false)
    void writes.saveFrom(
      record,
      field,
      next,
      opened ?? editorRead(record, field, edit),
    )
  }
  const empty = isEmptyValue(value) && field.field_type.kind !== 'boolean'
  // Plain writing, shown in full where there is a page to read it on. A cell
  // and the preview keep one line; a link or a rating keeps its own drawing.
  const kind = field.field_type.kind
  const written =
    whole &&
    typeof value === 'string' &&
    (kind === 'long_text' ||
      (kind === 'text' && !displayHint(type, field.key)?.display))
  return (
    <div role="listitem" className="group/row flex min-h-8 items-start gap-2">
      <div
        className="flex h-8 w-[108px] shrink-0 items-center gap-1.5 text-xs text-ink-muted"
        title={field.description}
      >
        <FieldTypeIcon kind={field.field_type.kind} />
        <span className="truncate">{field.label}</span>
      </div>
      <div
        ref={setAnchor}
        className={cn(
          'flex min-h-8 min-w-0 flex-1 gap-1.5 rounded-md px-1.5 text-sm text-ink',
          written && !editing ? 'items-start' : 'items-center',
          opens && !editing && 'cursor-text hover:bg-hover',
          editing &&
            style === 'inline' &&
            'bg-background outline-2 outline-focus',
        )}
        onClick={opens && !editing ? () => setEditing(true) : undefined}
      >
        {editing && style === 'inline' ? (
          <FieldEditor
            field={field}
            hint={displayHint(type, field.key)}
            value={value}
            row={record}
            onCommit={commit}
            onDiscard={() => setEditing(false)}
          />
        ) : (
          <>
            <span className="flex min-w-0 flex-1 items-center overflow-hidden">
              {empty ? (
                <span className="text-ink-faint">
                  {opens ? 'Empty' : 'Not set'}
                </span>
              ) : written ? (
                <span className="min-w-0 py-1.5 leading-5 break-words whitespace-pre-wrap">
                  {value}
                </span>
              ) : (
                <CrmFieldValue
                  type={type}
                  record={record}
                  field={field}
                  value={value}
                  onOpenRelated={onOpenRelated}
                  onToggle={canEdit && style === 'toggle' ? commit : undefined}
                />
              )}
            </span>
            <EditMark edit={edit} />
            {opens && (
              <button
                type="button"
                aria-label={`Edit ${field.label}`}
                onClick={(event) => {
                  event.stopPropagation()
                  setEditing(true)
                }}
                className={cn(
                  'flex size-5 shrink-0 items-center justify-center rounded-sm text-ink-faint opacity-0 group-hover/row:opacity-100 hover:bg-hover hover:text-ink focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-focus',
                  written && 'mt-1.5',
                )}
              >
                <Pencil aria-hidden className="size-3" />
              </button>
            )}
          </>
        )}
      </div>
      {editing && style === 'popover' && (
        <CrmEditorPopover
          type={type}
          record={record}
          field={field}
          value={value}
          anchor={anchor}
          onCommit={commit}
          onDiscard={() => setEditing(false)}
        />
      )}
    </div>
  )
}

/** A record's fields as label and value rows; each edits where it stands. */
export function PropertyList({
  type,
  record,
  writes,
  writable,
  whole = false,
  onOpenRelated,
}: {
  type: ObjectType
  record: CrmRecord
  writes: CrmWrites
  writable: boolean
  /** Show writing in full, on as many lines as it takes. */
  whole?: boolean
  onOpenRelated: (type: ObjectType, id: string) => void
}) {
  const identifier = identifierField(type)
  const fields = shownFields(type).filter(
    (field) => field.key !== identifier?.key,
  )
  return (
    <div role="list" aria-label="Properties" className="flex flex-col">
      {fields.map((field) => (
        <PropertyRow
          key={field.key}
          type={type}
          record={record}
          field={field}
          writes={writes}
          writable={writable}
          whole={whole}
          onOpenRelated={onOpenRelated}
        />
      ))}
    </div>
  )
}

// Private to me

/** Keeps the whole record away from the assistant, or lets it back. */
export function PrivateToggle({
  type,
  record,
  writes,
  writable,
}: {
  type: ObjectType
  record: CrmRecord
  writes: CrmWrites
  writable: boolean
}) {
  const field = fieldByKey(type, CONTEXT_USE_FIELD)
  const edit = useFieldEdit(record.id, CONTEXT_USE_FIELD)
  if (!field || !hasContextUse(type)) return null
  const on = edit ? edit.value === 'private' : isPrivate(record)
  const id = `private-${record.id}`
  return (
    <div className="flex items-start gap-3">
      <div className="min-w-0 flex-1">
        <label htmlFor={id} className="text-sm font-medium text-ink">
          Private to me
        </label>
        <p id={`${id}-about`} className="text-xs leading-5 text-ink-muted">
          {on
            ? 'Theorem does not read or use this record when it answers.'
            : 'Theorem may use this record when it answers. Turn this on to keep it out.'}
        </p>
      </div>
      <EditMark edit={edit} />
      <Switch
        id={id}
        aria-describedby={`${id}-about`}
        checked={on}
        disabled={!writable || edit?.status === 'saving'}
        onCheckedChange={(checked) =>
          void writes.save(record, field, checked ? 'private' : 'available')
        }
        className="mt-0.5"
      />
    </div>
  )
}

// This is me

/** On a person: say that this record is the signed-in person, or see that it is. */
export function SelfControl({
  type,
  record,
}: {
  type: ObjectType
  record: CrmRecord
}) {
  const { life, selfId } = useCrmScope()
  const bind = useBindSelfPerson()
  if (builtInName(type) !== 'person') return null
  if (selfId === record.id)
    return (
      <p className="flex items-center gap-2 text-xs leading-5 text-ink-muted">
        <YouBadge />
        This record is you. Theorem reads “I” and “me” as this person.
      </p>
    )
  const unavailable = life?.self.state === 'unavailable'
  return (
    <div className="flex flex-col gap-1">
      <Button
        variant="outline"
        size="sm"
        className="self-start"
        disabled={unavailable || bind.isPending}
        onClick={() => bind.mutate(record.id)}
      >
        This is me
      </Button>
      <p
        role={bind.isError ? 'alert' : undefined}
        className="text-xs leading-5 text-ink-muted"
      >
        {bind.isError
          ? crmErrorText(bind.error, type)
          : unavailable
            ? 'This sign-in names a workspace but not a person, so no record can be marked as you.'
            : selfId
              ? 'Another person record is marked as you. Choosing this one replaces it.'
              : 'Marks this record as you, so Theorem knows who is asking.'}
      </p>
    </div>
  )
}

// Ask Theorem

/** Puts the record in the next message's context and opens the conversation. */
export function AskTheoremButton({
  type,
  record,
  size = 'sm',
}: {
  type: ObjectType
  record: CrmRecord
  size?: 'sm' | 'xs'
}) {
  const navigate = useNavigate()
  // The conversation that was open, as the rail's chat destination opens it.
  // Read from the shell's state, not through shell/modes, which draws the CRM.
  const openChat = () => {
    const threadId = useShell.getState().chatThreadId
    return threadId
      ? navigate({ to: '/c/$threadId', params: { threadId } })
      : navigate({ to: '/' })
  }
  return (
    <Button
      variant="outline"
      size={size}
      onClick={() => {
        useComposerReferences
          .getState()
          .add(
            recordReference(
              type.name_singular,
              record.id,
              recordTitle(type, record),
            ),
          )
        void openChat().then(() => requestAnimationFrame(() => focusComposer()))
      }}
    >
      <Sparkles aria-hidden />
      Ask Theorem
    </Button>
  )
}

// Delete

/** Delete, after a confirmation, at the revision the person was looking at. */
export function DeleteControl({
  type,
  record,
  writes,
  writable,
  onDeleted,
  children,
}: {
  type: ObjectType
  record: CrmRecord
  writes: CrmWrites
  writable: boolean
  onDeleted: () => void
  children?: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  const title = recordTitle(type, record)
  const noun = type.label_singular.toLowerCase()
  const conflict = error instanceof RevisionConflictError
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        disabled={!writable}
        className="text-error-ink hover:text-error-ink"
        onClick={() => {
          setError(null)
          setOpen(true)
        }}
      >
        <Trash2 aria-hidden />
        {children ?? 'Delete'}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {title}?</DialogTitle>
            <DialogDescription>
              This {noun} is removed from Theorem, at saved revision{' '}
              {record.version}. It cannot be brought back here.
            </DialogDescription>
          </DialogHeader>
          {error !== null && (
            <p role="alert" className="text-sm text-error-ink">
              {conflict
                ? `This ${noun} changed since you opened it, so it was not deleted. Reload it and look again before deleting.`
                : `Not deleted. ${crmErrorText(error, type)}`}
            </p>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            {conflict ? (
              <Button
                variant="outline"
                onClick={() => {
                  writes
                    .reload(record.id)
                    .then(() => setError(null))
                    .catch(setError)
                }}
              >
                Reload
              </Button>
            ) : (
              <Button
                variant="destructive"
                disabled={busy}
                onClick={() => {
                  setBusy(true)
                  writes
                    .remove(record)
                    .then(() => {
                      setOpen(false)
                      onDeleted()
                    })
                    .catch(setError)
                    .finally(() => setBusy(false))
                }}
              >
                Delete {noun}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

// Header pieces

/** "Saved revision 7": the revision an edit made now would name. */
export function RevisionLine({ record }: { record: CrmRecord }) {
  return (
    <p className="text-xs text-ink-muted tabular-nums">
      Saved revision {record.version}
    </p>
  )
}

/** A record's mark and editable name, as the preview and the page head it. */
export function RecordHeading({
  type,
  record,
  writes,
  writable,
  size,
}: {
  type: ObjectType
  record: CrmRecord
  writes: CrmWrites
  writable: boolean
  size: 'preview' | 'page'
}) {
  const { selfId } = useCrmScope()
  return (
    <div className="flex min-w-0 items-start gap-2">
      <span className="mt-0.5 flex shrink-0">
        <RecordMark
          type={type}
          record={record}
          size={size === 'page' ? 'xl' : 'lg'}
        />
      </span>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
        <TitleField
          type={type}
          record={record}
          writes={writes}
          writable={writable}
          className={cn(
            // A long name wraps; it is the record's heading, not a cell.
            'font-heading font-medium whitespace-normal [overflow-wrap:anywhere]',
            size === 'page' ? 'text-[20px] leading-7' : 'text-[18px] leading-6',
          )}
        />
        {record.id === selfId && <YouBadge />}
      </div>
    </div>
  )
}

/** Says, once, that this sign-in may look but not change. */
export function ReadOnlyNote({ type }: { type: ObjectType }) {
  return (
    <p role="note" className="text-xs leading-5 text-ink-muted">
      This sign-in can read {type.label_plural} but not change them.
    </p>
  )
}
