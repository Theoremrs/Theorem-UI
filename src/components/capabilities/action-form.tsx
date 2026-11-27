// SOURCING: the native input and select styling pages/resource-field.tsx uses for a settings field
// (its `fieldControl` classes), over an action's declared inputs from lib/capabilities/contract. The
// form holds text and parses it through lib/capabilities/model's `actionValues`, so what reaches the
// route is one of the types the executor's vocabulary accepts, and a value that does not parse is
// refused at the field that holds it rather than sent and guessed at.
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import type { ActionSpec, InputField } from '@/lib/capabilities/contract'
import { actionValues, valueText } from '@/lib/capabilities/model'
import { fieldControl } from '@/components/pages/resource-field'

/** What a reference input picks from, by collection key. */
export type PickerOptions = (
  collectionKey: string,
) => Array<{ id: string; label: string }>

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
        ? value.slice(0, 16)
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

  const submit = () => {
    const parsed = actionValues(action, texts)
    if (!parsed.ok) return setErrors(parsed.errors)
    setErrors({})
    onSubmit(parsed.values)
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
            onChange={(text) =>
              setTexts((held) => ({ ...held, [field.key]: text }))
            }
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
