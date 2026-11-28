// SOURCING: the native input and select styling pages/resource-field.tsx uses for a settings field
// (its `fieldControl` classes), over an action's declared inputs from lib/capabilities/contract;
// date-fns formats a stored instant as the local wall time a datetime-local control holds. The form
// holds text and parses it through lib/capabilities/model's `actionValues`, so what reaches the
// route is one of the types the executor's vocabulary accepts, and a value that does not parse is
// refused at the field that holds it rather than sent and guessed at.
import { useMemo, useState } from 'react'
import { format, isValid, parseISO } from 'date-fns'
import { Button } from '@/components/ui/button'
import type {
  ActionSpec,
  CapabilityRecordRow,
  CollectionSchema,
  InputField,
} from '@/lib/capabilities/contract'
import {
  actionValues,
  inputsFor,
  referencedCollections,
  rowTitle,
  schemaFor,
  valueText,
} from '@/lib/capabilities/model'
import { fieldControl } from '@/components/pages/resource-field'
import { useCapabilityPickers } from './queries'

/** What a reference input picks from, by collection key. */
export type PickerOptions = (
  collectionKey: string,
) => Array<{ id: string; label: string }>

/**
 * A stored instant as the local wall time a datetime-local control shows:
 * `2026-11-20T10:30:00Z` reads as 05:30 in New York, not as 10:30 everywhere.
 */
export function localTimestampText(value: string): string {
  const at = parseISO(value)
  return isValid(at) ? format(at, "yyyy-MM-dd'T'HH:mm") : value
}

/** The text an input starts from: the value it stands for, in its wire form. */
function initialTexts(
  action: ActionSpec,
  defaults: Record<string, unknown> | undefined,
): Record<string, string> {
  const texts: Record<string, string> = {}
  for (const field of action.input) {
    const value = defaults?.[field.key]
    texts[field.key] =
      field.fieldType.kind === 'timestamp' && typeof value === 'string'
        ? localTimestampText(value)
        : valueText(value)
  }
  return texts
}

function Control({
  field,
  text,
  onChange,
  options,
  invalid,
  autoFocus,
}: {
  field: InputField
  text: string
  onChange: (text: string) => void
  options: PickerOptions
  invalid: boolean
  autoFocus?: boolean
}) {
  const type = field.fieldType
  const label = `${field.key}${field.required ? '' : ' (optional)'}`
  const aria = { 'aria-label': label } as const
  const refuse = invalid ? 'true' : undefined
  switch (type.kind) {
    case 'number':
    case 'integer':
      return (
        <input
          {...aria}
          aria-invalid={refuse}
          autoFocus={autoFocus}
          className={fieldControl}
          type="number"
          step={type.kind === 'integer' ? '1' : 'any'}
          value={text}
          onChange={(event) => onChange(event.target.value)}
        />
      )
    case 'date':
      return (
        <input
          {...aria}
          aria-invalid={refuse}
          className={fieldControl}
          type="date"
          value={text}
          onChange={(event) => onChange(event.target.value)}
        />
      )
    case 'timestamp':
      return (
        <input
          {...aria}
          aria-invalid={refuse}
          className={fieldControl}
          type="datetime-local"
          value={text}
          onChange={(event) => onChange(event.target.value)}
        />
      )
    case 'boolean':
      return (
        <select
          {...aria}
          aria-invalid={refuse}
          className={fieldControl}
          value={text}
          onChange={(event) => onChange(event.target.value)}
        >
          <option value="">(empty)</option>
          <option value="true">true</option>
          <option value="false">false</option>
        </select>
      )
    case 'enum':
      return (
        <select
          {...aria}
          aria-invalid={refuse}
          className={fieldControl}
          value={text}
          onChange={(event) => onChange(event.target.value)}
        >
          <option value="">(empty)</option>
          {type.variants.map((variant) => (
            <option key={variant} value={variant}>
              {variant}
            </option>
          ))}
          {text && !type.variants.includes(text) && (
            <option value={text}>{text}</option>
          )}
        </select>
      )
    case 'reference': {
      const picked = options(type.collectionKey)
      return (
        <select
          {...aria}
          aria-invalid={refuse}
          className={fieldControl}
          value={text}
          onChange={(event) => onChange(event.target.value)}
        >
          <option value="">(none)</option>
          {picked.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
          {text && !picked.some((option) => option.id === text) && (
            <option value={text}>{text}</option>
          )}
        </select>
      )
    }
    case 'text':
      return (
        <input
          {...aria}
          aria-invalid={refuse}
          autoFocus={autoFocus}
          className={fieldControl}
          type="text"
          value={text}
          onChange={(event) => onChange(event.target.value)}
        />
      )
  }
}

/**
 * One action's inputs, as a form. Submitting parses them; a form that has
 * nothing to ask for submits straight away, so an action with no inputs is one
 * click.
 */
export function ActionForm({
  action,
  defaults,
  options = () => [],
  submitLabel = 'Save',
  busy = false,
  onSubmit,
  onCancel,
}: {
  action: ActionSpec
  defaults?: Record<string, unknown>
  options?: PickerOptions
  submitLabel?: string
  busy?: boolean
  onSubmit: (values: Record<string, unknown>) => void
  onCancel?: () => void
}) {
  const [texts, setTexts] = useState(() => initialTexts(action, defaults))
  const [errors, setErrors] = useState<Record<string, string>>({})
  // The inputs the person changed. An untouched timestamp goes back as the
  // instant it was, not as the minute-precision local text its control shows.
  const [touched, setTouched] = useState<ReadonlySet<string>>(() => new Set())

  const submit = () => {
    const parsed = actionValues(action, texts)
    if (!parsed.ok) return setErrors(parsed.errors)
    setErrors({})
    const values = { ...parsed.values }
    for (const field of action.input) {
      const held = defaults?.[field.key]
      if (
        field.fieldType.kind === 'timestamp' &&
        !touched.has(field.key) &&
        typeof held === 'string'
      )
        values[field.key] = held
    }
    onSubmit(values)
  }

  const change = (key: string, text: string) => {
    setTexts((held) => ({ ...held, [key]: text }))
    setTouched((held) => (held.has(key) ? held : new Set(held).add(key)))
    // The field's own refusal goes as it is edited; the others stay until the
    // next submit answers them.
    setErrors((held) => {
      if (!(key in held)) return held
      const rest = { ...held }
      delete rest[key]
      return rest
    })
  }

  if (!action.input.length)
    return (
      <div className="flex items-center gap-2">
        <Button size="xs" variant="outline" disabled={busy} onClick={submit}>
          {submitLabel}
        </Button>
        {onCancel && (
          <Button size="xs" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
    )

  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault()
        submit()
      }}
    >
      {action.input.map((field) => (
        <label key={field.key} className="flex flex-col gap-1 text-xs">
          <span className="text-ink-muted">
            {field.key}
            {field.required ? '' : ' (optional)'}
          </span>
          <Control
            field={field}
            text={texts[field.key] ?? ''}
            options={options}
            invalid={errors[field.key] !== undefined}
            autoFocus={field === action.input[0]}
            onChange={(text) => change(field.key, text)}
          />
          {errors[field.key] && (
            <span role="alert" className="text-error-ink">
              {errors[field.key]}
            </span>
          )}
        </label>
      ))}
      <div className="flex items-center gap-2">
        <Button
          size="xs"
          type="submit"
          disabled={busy}
          aria-busy={busy}
          onClick={(event) => {
            // The form's submit handles Enter; a click answers it here once, so
            // one intent is one call either way.
            event.preventDefault()
            submit()
          }}
        >
          {busy ? 'Saving…' : submitLabel}
        </Button>
        {onCancel && (
          <Button size="xs" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  )
}

/**
 * One action's form over a record, with a picker over each collection its
 * inputs reference. Reference choices load a page at a time, labelled the way
 * a row is labelled everywhere else. The form starts from the record's values,
 * read under the input names the action's effects give them.
 */
export function ActionCall({
  instanceId,
  action,
  row,
  schemas,
  submitLabel,
  busy,
  onSubmit,
  onCancel,
}: {
  instanceId: string
  action: ActionSpec
  row?: CapabilityRecordRow
  schemas: CollectionSchema[]
  submitLabel: string
  busy: boolean
  onSubmit: (values: Record<string, unknown>) => void
  onCancel?: () => void
}) {
  const keys = useMemo(() => referencedCollections(action), [action])
  const pickers = useCapabilityPickers(instanceId, keys)
  const options: PickerOptions = (collectionKey) =>
    (pickers.data?.[collectionKey] ?? []).map((target) => ({
      id: target.id,
      label: rowTitle(schemaFor(schemas, collectionKey)?.fields ?? [], target),
    }))
  const defaults = useMemo(
    () => (row ? inputsFor(action, row.fields) : undefined),
    [action, row],
  )
  return (
    <>
      <ActionForm
        action={action}
        defaults={defaults}
        options={options}
        submitLabel={submitLabel}
        busy={busy}
        onSubmit={onSubmit}
        onCancel={onCancel}
      />
      <ReferencePageControls query={pickers} />
    </>
  )
}

export function ReferencePageControls({
  query,
}: {
  query: ReturnType<typeof useCapabilityPickers>
}) {
  if (!query.hasNextPage && !query.isError) return null
  return (
    <div className="flex flex-wrap items-center gap-2">
      {query.isError && (
        <span role="alert" className="text-xs text-error-ink">
          Reference choices could not be loaded.
        </span>
      )}
      <Button
        type="button"
        size="xs"
        variant="outline"
        disabled={query.isFetching}
        onClick={() =>
          void (query.hasNextPage ? query.fetchNextPage() : query.refetch())
        }
      >
        {query.isError
          ? 'Retry reference choices'
          : 'Load more reference choices'}
      </Button>
    </div>
  )
}
