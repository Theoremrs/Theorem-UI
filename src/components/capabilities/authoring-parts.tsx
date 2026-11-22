// SOURCING: the labelled row, native select and status line the authoring dialog already drew (moved
// here from authoring.tsx so each authoring tab shares one copy), styled with pages/resource-field's
// fieldControl and the DESIGN.md state grammar tokens (bg-raised for pending and saved,
// bg-error-container for failed).
import type { ReactNode } from 'react'
import { fieldControl } from '@/components/pages/resource-field'
import type { PatchOp } from '@/lib/capabilities/contract'

export function Row({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: ReactNode
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium text-ink-muted">{label}</span>
      {children}
      {hint && <span className="text-xs text-ink-faint">{hint}</span>}
    </label>
  )
}

export function Choice({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string
  value: string
  options: Array<{ value: string; label: string }>
  onChange: (value: string) => void
  disabled?: boolean
}) {
  return (
    <select
      aria-label={label}
      className={fieldControl}
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  )
}

export type Status = { kind: 'pending' | 'saved' | 'failed'; message: string }

/** One control's line: what it is doing, and the refusal that stopped it. */
export function StatusLine({ status }: { status: Status | undefined }) {
  if (!status) return null
  return (
    <p
      role={status.kind === 'failed' ? 'alert' : 'status'}
      className={
        status.kind === 'failed'
          ? 'rounded-md bg-error-container px-2 py-1.5 text-xs text-error-ink'
          : 'rounded-md bg-raised px-2 py-1.5 text-xs text-ink-muted'
      }
    >
      {status.message}
    </p>
  )
}

/** A note the person should read before acting: what a control does and does not change. */
export function Note({ children }: { children: ReactNode }) {
  return <p className="text-xs text-ink-faint">{children}</p>
}

/**
 * What an authoring control hands the dialog: the ops to send, in one patch,
 * and the words for the saved line. It answers whether the patch was taken.
 */
export type Submit = (ops: PatchOp[], what: string) => Promise<boolean>
