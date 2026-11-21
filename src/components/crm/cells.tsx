// SOURCING: the ported Twenty primitives (./twenty: Chip, Avatar, Tag) for a record's chip and an option's tag; the schema register's field display and editors (components/records/fields: FieldDisplay, FieldEditor, FieldEditorPopover, OptionList) for every kind but relations, which here resolve over the records the CRM loaded through the record verbs; coss ui Popover; lucide-react marks
import { CircleAlert, EyeOff, Lock } from 'lucide-react'
import { useImperativeHandle, useRef, useState } from 'react'
import type { Ref } from 'react'
import { Popover, PopoverPopup } from '@/components/coss/popover'
import type { FieldSpec, ObjectType } from '@/components/records/contract'
import {
  FieldDisplay,
  FieldEditorPopover,
  KIND,
  OptionList,
} from '@/components/records/fields'
import type { Move } from '@/components/records/fields'
import {
  displayHint,
  isEmptyValue,
  recordTitle,
} from '@/components/records/model'
import { cn } from '@/lib/utils'
import type { CrmRecord } from './api'
import { useCrmScope } from './context'
import { MadeValue, madeKind } from './made-links'
import { builtInName, initials, isPrivate } from './model'
import type { FieldEdit } from './queries'
import { Avatar } from './twenty/avatar'
import type { AvatarSize } from './twenty/avatar'
import { Chip } from './twenty/chip'
import { Tag, tagToneAt } from './twenty/tag'
import { TypeIcon } from './type-icons'

// A record's mark and chip

/**
 * What stands before a record's name: a round avatar with initials for a
 * person, a square one for an organization, the type's mark for the rest.
 */
export function RecordMark({
  type,
  record,
  title,
  size = 'md',
}: {
  type: ObjectType
  record?: CrmRecord
  title?: string
  size?: AvatarSize
}) {
  const name = title ?? recordTitle(type, record)
  const kind = builtInName(type)
  const large = size === 'lg' || size === 'xl' || size === 'xxl'
  if (kind === 'person' || kind === 'organization')
    return (
      <Avatar
        // A small avatar has room for one letter; a large one for two.
        name={large && kind === 'person' ? initials(name) : name}
        colorSeed={record?.id ?? name}
        size={size}
        shape={kind === 'person' ? 'circle' : 'rounded-square'}
        className={cn(
          large && kind === 'person' && 'text-[11px]',
          size === 'xl' && kind === 'person' && 'text-[13px]',
        )}
      />
    )
  return (
    <Avatar
      size={size}
      icon={<TypeIcon type={type} className={large ? 'size-4' : 'size-3.5'} />}
    />
  )
}

/** A lock that says "Private" to a screen reader as well as to the eye. */
export function PrivateMark({ className }: { className?: string }) {
  return (
    <span
      role="img"
      aria-label="Private: Theorem does not use this record"
      title="Private: Theorem does not use this record"
      className={cn('inline-flex shrink-0 text-ink-muted', className)}
    >
      <Lock aria-hidden className="size-3" strokeWidth={2} />
    </span>
  )
}

/** "You", on the person record that is the signed-in person. */
export function YouBadge() {
  return (
    <Tag tone="teal" weight="medium" className="h-4 px-1.5 text-[11px]">
      You
    </Tag>
  )
}

/** A record as a chip: its mark, its name, and whether it is private or you. */
export function RecordChip({
  type,
  record,
  onOpen,
  variant = 'ghost',
  weight,
  className,
  tabIndex,
}: {
  type: ObjectType
  record: CrmRecord
  onOpen?: () => void
  tabIndex?: number
  variant?: 'ghost' | 'soft' | 'outline'
  weight?: 'regular' | 'medium'
  className?: string
}) {
  const { selfId } = useCrmScope()
  const title = recordTitle(type, record)
  const marks = (isPrivate(record) || record.id === selfId) && (
    <span className="flex shrink-0 items-center gap-1">
      {record.id === selfId && <YouBadge />}
      {isPrivate(record) && <PrivateMark />}
    </span>
  )
  return (
    <Chip
      variant={variant}
      weight={weight}
      title={title}
      aria-label={onOpen ? `Open ${title}` : undefined}
      onClick={onOpen ? () => onOpen() : undefined}
      startElement={<RecordMark type={type} record={record} title={title} />}
      endElement={marks || undefined}
      className={className}
      tabIndex={tabIndex}
    >
      {title}
    </Chip>
  )
}

// Relations

/**
 * The records a relation field points at, as chips. A record that is not in
 * hand says why: still loading, not available to this sign-in, or gone.
 */
export function RelationValue({
  field,
  ids,
  onOpen,
  tabIndex,
}: {
  field: FieldSpec
  ids: string[]
  onOpen?: (type: ObjectType, id: string) => void
  tabIndex?: number
}) {
  const { targetOf, recordById, statusOf } = useCrmScope()
  const target = targetOf(field)
  if (!ids.length) return null
  if (!target)
    return (
      <Missing
        label={`${ids.length} linked`}
        why="The type this field points at is not declared here."
      />
    )
  const status = statusOf(target)
  return (
    <span className="flex min-w-0 items-center gap-1 overflow-hidden">
      {ids.map((id) => {
        const record = recordById(id)
        if (record)
          return (
            <RecordChip
              key={id}
              type={target}
              record={record}
              variant="soft"
              tabIndex={tabIndex}
              onOpen={onOpen ? () => onOpen(target, id) : undefined}
            />
          )
        if (status === 'pending')
          return (
            <Chip
              key={id}
              variant="soft"
              color="secondary"
              aria-label="Loading"
            >
              Loading
            </Chip>
          )
        if (status === 'denied')
          return (
            <Missing
              key={id}
              hidden
              label="Not available"
              why={`${target.label_plural} are not available to this sign-in.`}
            />
          )
        return (
          <Missing
            key={id}
            label={id}
            why={
              status === 'failed'
                ? `${target.label_plural} could not be loaded, so this is shown by its id.`
                : `This ${target.label_singular.toLowerCase()} is not among the loaded records. It may have been deleted.`
            }
          />
        )
      })}
    </span>
  )
}

function Missing({
  label,
  why,
  hidden = false,
}: {
  label: string
  why: string
  hidden?: boolean
}) {
  const Mark = hidden ? EyeOff : CircleAlert
  return (
    <Chip
      variant="outline"
      color="secondary"
      title={why}
      aria-label={`${label}. ${why}`}
      startElement={<Mark aria-hidden className="size-3 shrink-0" />}
    >
      {label}
    </Chip>
  )
}

const idsOf = (value: unknown): string[] =>
  typeof value === 'string' && value
    ? [value]
    : Array.isArray(value)
      ? value.filter((id): id is string => typeof id === 'string' && !!id)
      : []

// Values

/**
 * A field's value as a cell or a property row shows it. `value` is passed on
 * its own so an edit that is not saved yet can be shown in place of the saved
 * one, marked as such by the caller.
 */
export function CrmFieldValue({
  type,
  record,
  field,
  value,
  onOpenRelated,
  onToggle,
  tabIndex,
}: {
  type: ObjectType
  record: CrmRecord
  field: FieldSpec
  value: unknown
  onOpenRelated?: (type: ObjectType, id: string) => void
  onToggle?: (value: unknown) => void
  /** For the chips of a relation: -1 inside a grid cell. */
  tabIndex?: number
}) {
  const kind = field.field_type.kind
  if (kind === 'relation')
    return (
      <RelationValue
        field={field}
        ids={idsOf(value)}
        onOpen={onOpenRelated}
        tabIndex={tabIndex}
      />
    )
  if (isEmptyValue(value) && kind !== 'boolean') return null
  const made = madeKind(type, field)
  if (made && typeof value === 'string')
    return <MadeValue kind={made} id={value} />
  if (
    field.field_type.kind === 'enum' ||
    field.field_type.kind === 'enum_many'
  ) {
    const variants = field.field_type.variants
    const values = Array.isArray(value) ? value.map(String) : [String(value)]
    return (
      <span className="flex min-w-0 items-center gap-1 overflow-hidden">
        {values.map((option) => (
          <Tag key={option} tone={tagToneAt(variants.indexOf(option))}>
            {optionLabel(option)}
          </Tag>
        ))}
      </span>
    )
  }
  return (
    <FieldDisplay
      row={{ ...record, values: { ...record.values, [field.key]: value } }}
      field={field}
      hint={displayHint(type, field.key)}
      onToggle={onToggle}
    />
  )
}

/** `set_aside` reads "Set aside"; the stored value is unchanged. */
export const optionLabel = (option: string) => {
  const words = option.replace(/_/g, ' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** How a field edits: in its cell, in a popover, by toggling, or not at all. */
export const editStyle = (field: FieldSpec) =>
  field.system
    ? 'none'
    : field.field_type.kind === 'relation'
      ? 'popover'
      : KIND[field.field_type.kind].edit

/**
 * Whether the drawn value changes where it is, without opening an editor: a
 * yes or no, and a number drawn as a rating, whose stars are clicked.
 */
export const changesInPlace = (type: ObjectType, field: FieldSpec) =>
  editStyle(field) === 'toggle' ||
  (editStyle(field) !== 'none' &&
    displayHint(type, field.key)?.display === 'rating')

/** What an edit that is not saved says beside its value. */
export function EditMark({ edit }: { edit: FieldEdit | undefined }) {
  if (!edit) return null
  if (edit.status === 'saving')
    return (
      <span
        role="status"
        aria-label="Saving"
        title="Saving"
        className="ms-auto inline-block size-2.5 shrink-0 animate-spin rounded-full border border-ink-faint border-t-transparent motion-reduce:animate-none"
      />
    )
  return (
    <span
      role="img"
      aria-label="Not saved"
      title="Not saved"
      className="ms-auto inline-flex shrink-0 text-error-ink"
    >
      <CircleAlert aria-hidden className="size-3.5" />
    </span>
  )
}

// Editing

type EditorProps = {
  type: ObjectType
  record: CrmRecord
  field: FieldSpec
  value: unknown
  anchor: Element | null
  sideOffset?: number
  onCommit: (value: unknown, move?: Move) => void
  /** A save made by clicking away: focus stays where the person put it. */
  onCommitAway?: (value: unknown) => void
  onDiscard: () => void
}

function RelationPicker({
  field,
  value,
  onCommit,
  onDiscard,
  commitRef,
}: Pick<EditorProps, 'field' | 'value' | 'onCommit' | 'onDiscard'> & {
  commitRef: Ref<(move?: Move) => void>
}) {
  const { targetOf, recordsOf, recordById, statusOf } = useCrmScope()
  const type = field.field_type
  const multiple = type.kind === 'relation' && type.cardinality === 'many'
  const target = targetOf(field)
  const [picked, setPicked] = useState<string[]>(idsOf(value))
  const commit = (move?: Move) =>
    onCommit(multiple ? picked : (picked[0] ?? null), move)
  useImperativeHandle(commitRef, () => commit)
  const status = target ? statusOf(target) : 'failed'
  if (!target || status !== 'ready')
    return (
      <p role="status" className="w-64 p-3 text-sm text-ink-muted">
        {!target
          ? 'The type this field points at is not declared here.'
          : status === 'pending'
            ? `Loading ${target.label_plural.toLowerCase()}`
            : status === 'denied'
              ? `${target.label_plural} are not available to this sign-in.`
              : `${target.label_plural} could not be loaded.`}
      </p>
    )
  return (
    <OptionList
      label={target.label_plural}
      options={recordsOf(target).map((record) => ({
        value: record.id,
        label: recordTitle(target, record),
      }))}
      selected={picked}
      multiple={multiple}
      emptyText={`No ${target.label_plural.toLowerCase()} match`}
      render={(id) => {
        const record = recordById(id)
        return record ? <RecordChip type={target} record={record} /> : id
      }}
      onPick={(id) => {
        if (!multiple) return onCommit(id)
        if (id === null) return setPicked([])
        setPicked((held) =>
          held.includes(id) ? held.filter((x) => x !== id) : [...held, id],
        )
      }}
      onDone={commit}
      onCancel={onDiscard}
    />
  )
}

/**
 * A field's editor in a popover over its cell or row. Clicking away saves
 * what it holds; Escape cancels and the value stays as it was.
 */
export function CrmEditorPopover({
  type,
  record,
  field,
  value,
  anchor,
  sideOffset,
  onCommit,
  onCommitAway = onCommit,
  onDiscard,
}: EditorProps) {
  const commit = useRef<(move?: Move) => void>(null)
  const away = useRef(false)
  if (field.field_type.kind !== 'relation')
    return (
      <FieldEditorPopover
        anchor={anchor}
        sideOffset={sideOffset}
        field={field}
        hint={displayHint(type, field.key)}
        value={value}
        row={record}
        onCommit={onCommit}
        onCommitAway={onCommitAway}
        onDiscard={onDiscard}
      />
    )
  return (
    <Popover
      open
      onOpenChange={(open, details) => {
        if (open) return
        if (details.reason === 'escape-key') return onDiscard()
        away.current = true
        commit.current?.()
        away.current = false
      }}
    >
      <PopoverPopup
        anchor={anchor}
        align="start"
        sideOffset={sideOffset}
        className="p-0"
      >
        <RelationPicker
          field={field}
          value={value}
          commitRef={commit}
          onCommit={(next, move) =>
            away.current ? onCommitAway(next) : onCommit(next, move)
          }
          onDiscard={onDiscard}
        />
      </PopoverPopup>
    </Popover>
  )
}
