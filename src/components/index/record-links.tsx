// SOURCING: Theorem's record filing (GET /api/documents/v2/documents/:id/record-filings, POST record-filings/:receipt/corrections, POST record-filing-corrections/:id/undo through ./queries), the inspector's Filing section for the row anatomy and its "read the undo from the record" rule, coss Combobox (input inside the popup, as the composer's model picker) over the CRM's records of the linked type, the CRM's type marks and navigation
import { useMemo, useState } from 'react'
import {
  Combobox,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxTrigger,
} from '@/components/coss/combobox'
import { useCrmNavigate } from '@/components/crm/navigation'
import { useCrmRecords } from '@/components/crm/queries'
import { NamedTypeIcon } from '@/components/crm/type-icons'
import { Button } from '@/components/ui/button'
import type { ObjectType } from '@/components/records/contract'
import { recordItemId, recordTitle } from '@/components/records/model'
import { useDataModel } from '@/components/records/queries'
import { describeError } from '@/lib/theorem/client'
import type {
  RecordFilingCorrection,
  RecordFilingHistory,
  RecordFilingReceipt,
} from './contract'
import {
  useCorrectRecordFiling,
  useRecordFilings,
  useUndoRecordFiling,
} from './queries'

const heading = 'text-xs font-medium tracking-wide text-ink-faint uppercase'

/** Why Theorem linked the document to the record, in one sentence. */
export function linkReason(receipt: RecordFilingReceipt) {
  const attribution = receipt.attribution
  switch (attribution.kind) {
    case 'identifier':
      return `${receipt.title}'s ${attribution.field.replaceAll('_', ' ')} appears in it.`
    case 'name_mention':
      return attribution.where === 'title'
        ? 'Named in the title.'
        : 'Named in the text.'
    case 'correction':
      return attribution.actor.kind === 'human'
        ? 'Linked here by a person.'
        : `Linked here by ${attribution.actor.kind === 'agent' ? 'an agent' : 'Theorem'}.`
    case 'made':
      return 'Theorem drafted it for this record when you approved it.'
  }
}

/** A record's title by item id, from the receipts the document has carried. */
/** Whether a reply carries the lists the section reads. */
function readable(
  history: RecordFilingHistory | undefined,
): history is RecordFilingHistory {
  return (
    !!history &&
    Array.isArray(history.links) &&
    Array.isArray(history.receipts) &&
    Array.isArray(history.corrections)
  )
}

function titles(history: RecordFilingHistory) {
  const byItem = new Map<string, { title: string; generation: number }>()
  for (const receipt of history.receipts) {
    const held = byItem.get(receipt.recordItemId)
    if (!held || receipt.generation > held.generation)
      byItem.set(receipt.recordItemId, {
        title: receipt.title,
        generation: receipt.generation,
      })
  }
  return (itemId: string | null | undefined) =>
    itemId
      ? (byItem.get(itemId)?.title ?? itemId.slice(itemId.indexOf('/') + 1))
      : ''
}

/**
 * The correction the person can still take back: the latest one, unless it is
 * itself an undo or was undone. Read from Theorem, so it survives a reload.
 */
export function undoableCorrection(history: RecordFilingHistory) {
  const latest = history.corrections.reduce<RecordFilingCorrection | undefined>(
    (best, correction) =>
      !best || correction.generation > best.generation ? correction : best,
    undefined,
  )
  return latest && !latest.undo && !latest.undone ? latest : undefined
}

type Choice = { itemId: string; title: string }

/** Pick another record of the same type to link the document to instead. */
function ChangeRecord({
  type,
  exclude,
  disabled,
  onPick,
}: {
  type: ObjectType
  exclude: ReadonlySet<string>
  disabled: boolean
  onPick: (itemId: string) => void
}) {
  const [open, setOpen] = useState(false)
  const records = useCrmRecords(type, { enabled: open })
  const choices = useMemo<Choice[]>(
    () =>
      (records.data?.records ?? [])
        .map((record) => ({
          itemId: recordItemId(type, record.id),
          title: recordTitle(type, record) || record.id,
        }))
        .filter((choice) => !exclude.has(choice.itemId)),
    [records.data, type, exclude],
  )
  return (
    <Combobox<Choice>
      items={choices}
      value={null}
      open={open}
      onOpenChange={setOpen}
      onValueChange={(choice) => {
        if (choice) onPick(choice.itemId)
      }}
      itemToStringLabel={(choice) => choice.title}
      itemToStringValue={(choice) => `${choice.title} ${choice.itemId}`}
      isItemEqualToValue={(a, b) => a.itemId === b.itemId}
    >
      <ComboboxTrigger
        render={<Button variant="ghost" size="xs" />}
        disabled={disabled}
      >
        Change…
      </ComboboxTrigger>
      <ComboboxPopup side="bottom" align="start" className="w-72">
        <div className="border-b border-separator p-1.5">
          <ComboboxInput
            size="sm"
            showTrigger={false}
            placeholder={`Find a ${type.label_singular.toLowerCase()}`}
            aria-label={`Find a ${type.label_singular.toLowerCase()}`}
          />
        </div>
        {records.error ? (
          <p role="alert" className="px-3 py-2 text-sm text-error-ink">
            {describeError(records.error)}
          </p>
        ) : records.isPending ? (
          <p className="px-3 py-2 text-sm text-ink-muted">Loading…</p>
        ) : (
          <ComboboxEmpty className="hidden px-3 py-4 text-sm text-ink-muted not-empty:block">
            No {type.label_singular.toLowerCase()} matches.
          </ComboboxEmpty>
        )}
        <ComboboxList className="max-h-64 overflow-y-auto p-1">
          {(choice: Choice) => (
            <ComboboxItem key={choice.itemId} value={choice} className="py-1.5">
              <span className="min-w-0 flex-1 truncate">{choice.title}</span>
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxPopup>
    </Combobox>
  )
}

/**
 * The saved records a document is about. Theorem links them when the document
 * is filed and keeps a receipt for each; nothing about the record changes. The
 * person says "not about" or picks the right record, and can undo either.
 * Nothing shows until there is a link or a correction to take back.
 */
export function RecordLinks({ documentId }: { documentId: string }) {
  const history = useRecordFilings(documentId)
  const model = useDataModel()
  const correct = useCorrectRecordFiling()
  const undo = useUndoRecordFiling()
  const { openRecordNamed } = useCrmNavigate()

  if (history.isPending) return null
  // A reply without its lists is as unreadable as no reply: it must not take
  // the rest of the inspector down with it.
  if (!readable(history.data))
    return (
      <section aria-label="About" className="flex flex-col gap-2">
        <h3 className={heading}>About</h3>
        <p role="alert" className="text-sm text-ink-muted">
          What this document is about could not be read.
        </p>
      </section>
    )
  const data = history.data
  const links = [...data.links].sort((a, b) => a.generation - b.generation)
  const undoable = undoableCorrection(data)
  if (!links.length && !undoable) return null

  const titleOf = titles(data)
  const linked = new Set(links.map((link) => link.recordItemId))
  const typeNamed = (nameSingular: string) =>
    model.data?.objectTypes.find(
      (type) =>
        !type.retired &&
        type.name_singular.toLowerCase() === nameSingular.toLowerCase(),
    )
  const busy = correct.isPending || undo.isPending
  const error = correct.error ?? undo.error

  return (
    <section aria-label="About" className="flex flex-col gap-2">
      <h3 className={heading}>About</h3>
      {links.length > 0 && (
        <ul className="flex flex-col gap-1">
          {links.map((link) => {
            const type = typeNamed(link.nameSingular)
            return (
              <li
                key={link.receiptId}
                className="flex flex-col gap-1 rounded-lg border border-separator px-3 py-2"
              >
                <div className="flex min-w-0 items-center gap-2">
                  <NamedTypeIcon
                    nameSingular={link.nameSingular}
                    className="size-3.5 shrink-0 text-ink-muted"
                  />
                  <button
                    type="button"
                    className="min-w-0 truncate text-start text-sm font-medium outline-none hover:underline focus-visible:underline"
                    onClick={() =>
                      openRecordNamed(link.nameSingular, link.recordId)
                    }
                  >
                    {link.title || link.recordId}
                  </button>
                  <span className="shrink-0 text-[11px] text-ink-faint">
                    {type?.label_singular ?? link.nameSingular}
                  </span>
                </div>
                <p className="text-xs leading-5 text-ink-muted">
                  {linkReason(link)}
                  {link.lowConfidence &&
                    ' Theorem was not sure: another record has a name like this.'}
                </p>
                <div className="flex flex-wrap gap-1">
                  <Button
                    variant="ghost"
                    size="xs"
                    disabled={busy}
                    onClick={() =>
                      correct.mutate({
                        receiptId: link.receiptId,
                        recordItemId: null,
                      })
                    }
                  >
                    Not about {link.title || link.recordId}
                  </Button>
                  {type && (
                    <ChangeRecord
                      type={type}
                      exclude={linked}
                      disabled={busy}
                      onPick={(itemId) =>
                        correct.mutate({
                          receiptId: link.receiptId,
                          recordItemId: itemId,
                        })
                      }
                    />
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}
      {undoable && (
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => undo.mutate(undoable.correctionId)}
          >
            {undoable.toRecordItemId
              ? `Undo change to ${titleOf(undoable.toRecordItemId)}`
              : `Undo "Not about ${titleOf(undoable.fromRecordItemId)}"`}
          </Button>
        </div>
      )}
      {error ? (
        <p role="alert" className="text-xs text-error-ink">
          {describeError(error)}
        </p>
      ) : null}
    </section>
  )
}
