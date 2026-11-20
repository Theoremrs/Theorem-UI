// SOURCING: coss Combobox and Select for the existing About correction picker; @tanstack/react-pacer for debouncing; the CRM's bounded useCrmRecordSearch and access policy. Only the selected declared type is searched.
import { useDebouncedValue } from '@tanstack/react-pacer'
import { useMemo, useState } from 'react'
import {
  Combobox,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxTrigger,
} from '@/components/coss/combobox'
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from '@/components/coss/select'
import { accessFor } from '@/components/crm/model'
import { useLifeContext } from '@/components/crm/queries'
import { useCrmRecordSearch } from '@/components/crm/record-search'
import type { ObjectType } from '@/components/records/contract'
import { recordItemId, recordTitle } from '@/components/records/model'
import { Button } from '@/components/ui/button'

type Choice = { itemId: string; title: string }

/** Retarget an existing About link, including to another declared record type. */
export function RecordLinkPicker({
  initialType,
  types,
  exclude,
  disabled,
  onPick,
}: {
  initialType: ObjectType
  types: ObjectType[]
  exclude: ReadonlySet<string>
  disabled: boolean
  onPick: (itemId: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [typeId, setTypeId] = useState(initialType.object_type_id)
  const [query, setQuery] = useState('')
  const [settled] = useDebouncedValue(query.trim(), { wait: 200 })
  const settling = query.trim() !== settled
  // An existing link may name a live system type outside the CRM catalog.
  const pickerTypes = types.some(
    (item) => item.object_type_id === initialType.object_type_id,
  )
    ? types
    : [initialType, ...types]
  const type =
    pickerTypes.find((item) => item.object_type_id === typeId) ?? initialType
  const searchTypes = useMemo(() => [type], [type])
  const life = useLifeContext()
  const records = useCrmRecordSearch(
    searchTypes,
    settled,
    open && !disabled && !settling,
  )
  const status = records.statusOf(type)
  // Never leave a result from an earlier query selectable during the debounce.
  const choices = useMemo<Choice[]>(
    () =>
      open && !disabled && !settling && status === 'ready'
        ? records
            .recordsOf(type)
            .map((record) => ({
              itemId: recordItemId(type, record.id),
              title: recordTitle(type, record) || record.id,
            }))
            .filter((choice) => !exclude.has(choice.itemId))
        : [],
    [open, disabled, settling, status, records, type, exclude],
  )
  const typeItems = pickerTypes.map((item) => ({
    value: item.object_type_id,
    label: item.label_plural,
  }))

  return (
    <Combobox<Choice>
      items={choices}
      filter={null}
      value={null}
      inputValue={query}
      onInputValueChange={setQuery}
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) {
          setTypeId(initialType.object_type_id)
          setQuery('')
        }
      }}
      onValueChange={(choice) => {
        if (!choice || disabled || settling || status !== 'ready') return
        onPick(choice.itemId)
        setOpen(false)
      }}
      itemToStringLabel={(choice) => choice.title}
      itemToStringValue={(choice) => choice.itemId}
      isItemEqualToValue={(a, b) => a.itemId === b.itemId}
    >
      <ComboboxTrigger
        render={<Button variant="ghost" size="xs" />}
        disabled={disabled}
        aria-label="Change linked record"
      >
        Change…
      </ComboboxTrigger>
      <ComboboxPopup
        side="bottom"
        align="start"
        className="w-80 max-w-[calc(100vw-2rem)]"
      >
        <div className="flex flex-col gap-2 border-b border-separator p-2">
          <Select
            items={typeItems}
            value={type.object_type_id}
            disabled={disabled}
            onValueChange={(value) => {
              if (typeof value === 'string') setTypeId(value)
            }}
          >
            <SelectTrigger size="sm" aria-label="Record type">
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              {pickerTypes.map((item) => (
                <SelectItem
                  key={item.object_type_id}
                  value={item.object_type_id}
                  disabled={!accessFor(life.data, item).read}
                >
                  {item.label_plural}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
          <ComboboxInput
            size="sm"
            showTrigger={false}
            disabled={disabled}
            placeholder={`Find a ${type.label_singular.toLowerCase()}`}
            aria-label={`Find a ${type.label_singular.toLowerCase()}`}
          />
        </div>
        {status === 'denied' ? (
          <p role="alert" className="px-3 py-2 text-sm text-error-ink">
            This sign-in cannot read these records. Choose another type.
          </p>
        ) : status === 'failed' && !settling ? (
          <div
            role="alert"
            className="flex items-center gap-2 px-3 py-2 text-sm text-error-ink"
          >
            <span>These records could not be searched.</span>
            <Button
              size="xs"
              variant="outline"
              disabled={disabled}
              onClick={records.retryFailed}
            >
              Try again
            </Button>
          </div>
        ) : disabled || settling || status === 'pending' ? (
          <p role="status" className="px-3 py-2 text-sm text-ink-muted">
            {disabled ? 'Saving…' : 'Searching…'}
          </p>
        ) : choices.length === 0 ? (
          <p role="status" className="px-3 py-2 text-sm text-ink-muted">
            No matching records returned. Try another name.
          </p>
        ) : null}
        <ComboboxList className="max-h-64 overflow-y-auto p-1">
          {(choice: Choice) => (
            <ComboboxItem key={choice.itemId} value={choice} className="py-1.5">
              <span className="min-w-0 flex-1 truncate">{choice.title}</span>
            </ComboboxItem>
          )}
        </ComboboxList>
        <p className="border-t border-separator px-3 py-2 text-xs text-ink-muted">
          Only some matches may be shown. Search by name to narrow them.
        </p>
      </ComboboxPopup>
    </Combobox>
  )
}
