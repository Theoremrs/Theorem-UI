// SOURCING: Twenty's "Update records" side panel (Mobbin flow "Updating records", frame 4 of 7) for the anatomy: the table stays in view with its rows still marked, a 420 px panel names how many records it will change, lists the type's fields as label and value rows, and ends in Cancel and Apply; the row grammar and editors the record preview uses (./record-fields, ./cells, components/records/fields); the single-record write that names a revision (./queries `patchWhere`), queued once per record when Apply is pressed so each leaves its own history entry and its own answer; the app's Button; lucide-react marks
import { X } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { KeyboardEvent } from 'react'
import type { FieldSpec, ObjectType } from '@/components/records/contract'
import { FieldEditor, FieldTypeIcon } from '@/components/records/fields'
import {
  displayHint,
  identifierField,
  isEmptyValue,
  recordTitle,
} from '@/components/records/model'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { RevisionConflictError } from './api'
import type { CrmRecord } from './api'
import { CrmEditorPopover, CrmFieldValue, editStyle } from './cells'
import { sameValue, shownFields } from './model'
import type { CrmWrites } from './queries'
import { crmErrorText } from './record-fields'
import { PREVIEW_WIDTH } from './record-preview'

/** What happened to one record of a bulk update. */
export type BulkOutcome = { id: string; title: string } & (
  | { result: 'updated'; from: number; to: number }
  /** It already held every value asked for, so nothing was sent. */
  | { result: 'unchanged' }
  | { result: 'refused'; reason: string; conflict: boolean }
)

/** The fields of `changes` whose value this record does not already hold. */
const differing = (record: CrmRecord, changes: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(changes).filter(
      ([key, value]) => !sameValue(record.values[key], value),
    ),
  )

/**
 * Apply the same values to a fixed list of records, one write each. Every
 * write is queued when this starts, so each record's queue holds the bulk
 * write ahead of any edit made after Apply: a later edit is never written
 * over, and an edit still saving when Apply was pressed is seen before the
 * bulk value is chosen. Which fields still differ is decided inside the
 * record's queue, not from the copy read earlier. A record that changed
 * since it was read is refused and reported, not written over. Every record
 * gets its own outcome, in the order of the list.
 */
export async function runBulkUpdate(
  type: ObjectType,
  targets: readonly CrmRecord[],
  changes: Record<string, unknown>,
  patchWhere: CrmWrites['patchWhere'],
  onStep?: (done: number) => void,
): Promise<BulkOutcome[]> {
  const queued = targets.map((record) => {
    const result = patchWhere(record.id, record.version, (current) =>
      differing(current ?? record, changes),
    )
    // Settled here, so a refusal is never left unhandled while an earlier
    // record is awaited.
    return result.then(
      (saved) => ({ saved }) as const,
      (error: unknown) => ({ error }) as const,
    )
  })
  const outcomes: BulkOutcome[] = []
  for (const [index, record] of targets.entries()) {
    const head = { id: record.id, title: recordTitle(type, record) }
    const answer = await queued[index]!
    if ('error' in answer)
      outcomes.push({
        ...head,
        result: 'refused',
        reason: crmErrorText(answer.error, type),
        conflict: answer.error instanceof RevisionConflictError,
      })
    else if (!answer.saved) outcomes.push({ ...head, result: 'unchanged' })
    else
      outcomes.push({
        ...head,
        result: 'updated',
        from: record.version,
        to: answer.saved.version,
      })
    onStep?.(outcomes.length)
  }
  return outcomes
}

const NUMBER = new Intl.NumberFormat('en-US')

const records = (count: number, type: ObjectType) =>
  `${NUMBER.format(count)} ${(count === 1
    ? type.label_singular
    : type.label_plural
  ).toLowerCase()}`

type Phase =
  | { step: 'choosing' }
  | { step: 'applying'; targets: readonly CrmRecord[]; done: number }
  | { step: 'done'; outcomes: BulkOutcome[] }

/**
 * Change the same fields on every selected record. Nothing is written until
 * Apply; Apply writes to exactly the records marked at that moment, and the
 * panel then says what happened to each.
 */
export function BulkUpdatePanel({
  type,
  selected,
  writes,
  onMark,
  onClose,
}: {
  type: ObjectType
  /** The marked records, as the table has them now. */
  selected: readonly CrmRecord[]
  writes: CrmWrites
  /** Mark exactly these records in the table: the ones an update refused. */
  onMark: (ids: readonly string[]) => void
  onClose: () => void
}) {
  const [changes, setChanges] = useState<Record<string, unknown>>({})
  const [phase, setPhase] = useState<Phase>({ step: 'choosing' })
  const fields = useMemo(() => {
    const identifier = identifierField(type)
    return shownFields(type).filter(
      (field) => field.key !== identifier?.key && editStyle(field) !== 'none',
    )
  }, [type])

  const changed = Object.keys(changes).length
  // While choosing, the count follows the marks in the table; from Apply on
  // it is the list that was bound then.
  const targets = phase.step === 'applying' ? phase.targets : selected
  const affected = useMemo(
    () =>
      targets.filter(
        (record) => Object.keys(differing(record, changes)).length > 0,
      ).length,
    [targets, changes],
  )
  const busy = phase.step === 'applying'

  const close = () => {
    if (busy) return
    // What was updated is done with; what was refused stays marked.
    if (phase.step === 'done')
      onMark(
        phase.outcomes
          .filter((outcome) => outcome.result === 'refused')
          .map((outcome) => outcome.id),
      )
    onClose()
  }
  // Escape closes the panel, unless an editor inside it took the key.
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Escape' || event.defaultPrevented) return
    const target = event.target as HTMLElement | null
    if (target?.closest('input, textarea, select, [contenteditable="true"]'))
      return
    close()
  }

  const apply = async () => {
    // The list is bound here: marks made after this do not join it.
    const bound = [...selected]
    setPhase({ step: 'applying', targets: bound, done: 0 })
    const outcomes = await runBulkUpdate(
      type,
      bound,
      changes,
      writes.patchWhere,
      (done) => setPhase({ step: 'applying', targets: bound, done }),
    )
    setPhase({ step: 'done', outcomes })
  }

  /** Read the refused records again and go back to choosing, with them marked. */
  const review = async (ids: readonly string[]) => {
    await Promise.all(ids.map((id) => writes.reload(id).catch(() => undefined)))
    onMark(ids)
    setPhase({ step: 'choosing' })
  }

  const title =
    phase.step === 'done'
      ? 'Update finished'
      : `Update ${records(targets.length, type)}`

  return (
    <aside
      onKeyDown={onKeyDown}
      aria-label={title}
      data-crm-region="bulk-update"
      className="flex h-full shrink-0 flex-col border-s border-separator bg-background"
      style={{ width: PREVIEW_WIDTH }}
    >
      <header className="flex h-11 shrink-0 items-center gap-1 border-b border-separator ps-4 pe-2">
        <h2 className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink tabular-nums">
          {title}
        </h2>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Close"
          disabled={busy}
          onClick={close}
        >
          <X aria-hidden />
        </Button>
      </header>

      {phase.step === 'done' ? (
        <Report
          type={type}
          outcomes={phase.outcomes}
          onReview={(ids) => void review(ids)}
        />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          <p className="px-4 pt-3 pb-2 text-xs leading-5 text-ink-muted">
            {targets.length === 0
              ? `No ${type.label_plural.toLowerCase()} are marked. Mark rows in the table to change them together.`
              : 'Set a field to change it on every marked record. A field you leave alone is not touched.'}
          </p>
          <div
            role="list"
            aria-label="Fields to change"
            className="flex flex-col px-2 pb-2"
          >
            {fields.map((field) => (
              <ChangeRow
                key={field.key}
                type={type}
                field={field}
                set={field.key in changes}
                value={changes[field.key]}
                targets={targets}
                disabled={busy}
                onSet={(value) =>
                  setChanges((held) => ({ ...held, [field.key]: value }))
                }
                onClear={() =>
                  setChanges(({ [field.key]: _, ...rest }) => rest)
                }
              />
            ))}
          </div>
        </div>
      )}

      <footer className="flex h-12 shrink-0 items-center gap-2 border-t border-separator px-3">
        <span
          role="status"
          className="min-w-0 flex-1 truncate text-xs text-ink-muted tabular-nums"
        >
          {phase.step === 'applying'
            ? `Updating ${NUMBER.format(Math.min(phase.done + 1, targets.length))} of ${NUMBER.format(targets.length)}`
            : phase.step === 'choosing' && changed > 0 && targets.length > 0
              ? `Changes ${NUMBER.format(affected)} of ${NUMBER.format(targets.length)}`
              : ''}
        </span>
        {phase.step === 'done' ? (
          <Button size="sm" onClick={close}>
            Done
          </Button>
        ) : (
          <>
            <Button size="sm" variant="ghost" disabled={busy} onClick={close}>
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={busy || changed === 0 || targets.length === 0}
              onClick={() => void apply()}
            >
              Apply
            </Button>
          </>
        )}
      </footer>
    </aside>
  )
}

/** One field: left alone until it is given a value, then that value and how many records it changes. */
function ChangeRow({
  type,
  field,
  set,
  value,
  targets,
  disabled,
  onSet,
  onClear,
}: {
  type: ObjectType
  field: FieldSpec
  set: boolean
  value: unknown
  targets: readonly CrmRecord[]
  disabled: boolean
  onSet: (value: unknown) => void
  onClear: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [anchor, setAnchor] = useState<HTMLDivElement | null>(null)
  const style = editStyle(field)
  // The editors and the value drawing read a record; this one holds only
  // the value being chosen and is never saved.
  const draft = useMemo<CrmRecord>(
    () => ({
      id: '',
      version: 0,
      labels: [],
      relations: {},
      values: set ? { [field.key]: value } : {},
    }),
    [field.key, set, value],
  )
  const commit = (next: unknown) => {
    setEditing(false)
    onSet(next)
  }
  const open = () => {
    if (disabled) return
    // A switch has no editor to open: its first press turns it on.
    if (style === 'toggle') onSet(true)
    else setEditing(true)
  }
  const differs = set
    ? targets.filter((record) => !sameValue(record.values[field.key], value))
        .length
    : 0
  const empty = isEmptyValue(value) && field.field_type.kind !== 'boolean'
  return (
    <div role="listitem" className="flex min-h-8 items-start gap-2">
      <div
        className="flex h-8 w-[108px] shrink-0 items-center gap-1.5 text-xs text-ink-muted"
        title={field.description}
      >
        <FieldTypeIcon kind={field.field_type.kind} />
        <span className="truncate">{field.label}</span>
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <div
          ref={setAnchor}
          className={cn(
            'flex min-h-8 min-w-0 items-center gap-1.5 rounded-md px-1.5 text-sm text-ink',
            editing &&
              style === 'inline' &&
              'bg-background outline-2 outline-focus',
          )}
        >
          {editing && style === 'inline' ? (
            <FieldEditor
              field={field}
              hint={displayHint(type, field.key)}
              value={value}
              row={draft}
              onCommit={commit}
              onDiscard={() => setEditing(false)}
            />
          ) : set ? (
            <>
              {style === 'toggle' ? (
                <span className="flex min-w-0 flex-1 items-center overflow-hidden">
                  <CrmFieldValue
                    type={type}
                    record={draft}
                    field={field}
                    value={value}
                    onToggle={disabled ? undefined : onSet}
                  />
                </span>
              ) : (
                <button
                  type="button"
                  disabled={disabled}
                  aria-label={`Change the value for ${field.label}`}
                  onClick={open}
                  className="flex min-h-8 min-w-0 flex-1 items-center overflow-hidden rounded-sm text-start hover:bg-hover focus-visible:outline-2 focus-visible:outline-focus"
                >
                  {empty ? (
                    <span className="text-ink-muted">Empty</span>
                  ) : (
                    <CrmFieldValue
                      type={type}
                      record={draft}
                      field={field}
                      value={value}
                      tabIndex={-1}
                      plain
                    />
                  )}
                </button>
              )}
              <button
                type="button"
                disabled={disabled}
                aria-label={`Leave ${field.label} as it is`}
                onClick={onClear}
                className="flex size-5 shrink-0 items-center justify-center rounded-sm text-ink-muted hover:bg-hover hover:text-ink focus-visible:outline-2 focus-visible:outline-focus disabled:opacity-50"
              >
                <X aria-hidden className="size-3" />
              </button>
            </>
          ) : (
            <button
              type="button"
              disabled={disabled}
              aria-label={`Set ${field.label}`}
              onClick={open}
              className="flex min-h-8 min-w-0 flex-1 items-center rounded-sm text-start text-ink-faint hover:bg-hover hover:text-ink-muted focus-visible:outline-2 focus-visible:outline-focus"
            >
              Leave as it is
            </button>
          )}
        </div>
        {set && !editing && (
          <p className="px-1.5 pb-1 text-xs leading-4 text-ink-muted tabular-nums">
            {differs === 0
              ? 'Every marked record already has this'
              : `${empty ? 'Clears' : 'Changes'} ${NUMBER.format(differs)} of ${NUMBER.format(targets.length)}`}
          </p>
        )}
      </div>
      {editing && style === 'popover' && (
        <CrmEditorPopover
          type={type}
          record={draft}
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

/** What happened to each record, the refused ones first. */
function Report({
  type,
  outcomes,
  onReview,
}: {
  type: ObjectType
  outcomes: BulkOutcome[]
  onReview: (ids: readonly string[]) => void
}) {
  const count = (result: BulkOutcome['result']) =>
    outcomes.filter((outcome) => outcome.result === result).length
  const [updated, unchanged, refused] = [
    count('updated'),
    count('unchanged'),
    count('refused'),
  ]
  const ordered = [
    ...outcomes.filter((outcome) => outcome.result === 'refused'),
    ...outcomes.filter((outcome) => outcome.result !== 'refused'),
  ]
  const moved = outcomes.filter(
    (outcome) => outcome.result === 'refused' && outcome.conflict,
  )
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <p
        role={refused ? 'alert' : 'status'}
        className="px-4 pt-3 pb-2 text-[13px] leading-5 text-ink tabular-nums"
      >
        {[
          `${NUMBER.format(updated)} updated`,
          refused ? `${NUMBER.format(refused)} not updated` : '',
          unchanged
            ? `${NUMBER.format(unchanged)} already had these values`
            : '',
        ]
          .filter(Boolean)
          .join(', ')}
        .
      </p>
      {moved.length > 0 && (
        <div className="flex items-center gap-2 px-4 pb-2">
          <p className="min-w-0 flex-1 text-xs leading-5 text-ink-muted">
            {moved.length === 1
              ? 'One record changed after this table read it, so it was left alone.'
              : `${NUMBER.format(moved.length)} records changed after this table read them, so they were left alone.`}
          </p>
          <Button
            size="xs"
            variant="outline"
            onClick={() => onReview(moved.map((outcome) => outcome.id))}
          >
            Read again
          </Button>
        </div>
      )}
      <ul
        aria-label={`Result for each ${type.label_singular.toLowerCase()}`}
        className="flex flex-col border-t border-separator"
      >
        {ordered.map((outcome) => (
          <li
            key={outcome.id}
            className="flex flex-col border-b border-separator px-4 py-1.5"
          >
            <span className="flex items-baseline gap-2">
              <span className="min-w-0 flex-1 truncate text-[13px] leading-5 text-ink">
                {outcome.title}
              </span>
              <span
                className={cn(
                  'shrink-0 text-xs leading-5 tabular-nums',
                  outcome.result === 'refused'
                    ? 'font-medium text-error-ink'
                    : 'text-ink-muted',
                )}
              >
                {outcome.result === 'updated'
                  ? `Updated · revision ${outcome.from} to ${outcome.to}`
                  : outcome.result === 'unchanged'
                    ? 'No change needed'
                    : 'Not updated'}
              </span>
            </span>
            {outcome.result === 'refused' && (
              <span className="text-xs leading-5 text-ink-muted">
                {outcome.reason}
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}
