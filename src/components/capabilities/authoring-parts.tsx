// SOURCING: the labelled row, native select and status line the authoring dialog already drew (moved
// here from authoring.tsx so each authoring tab shares one copy) and the coss ui Checkbox tick the
// agent-access and field tabs share, styled with pages/resource-field's fieldControl and the
// DESIGN.md state grammar tokens (bg-raised for pending and saved, bg-error-container for failed).
import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/coss/checkbox'
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

/** A checkbox named for assistive tech, with its words beside it rather than around it. */
export function Tick({
  label,
  text,
  checked,
  onChange,
}: {
  label: string
  text: string
  checked: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <span className="flex items-center gap-1.5 text-xs text-ink">
      <Checkbox
        aria-label={label}
        checked={checked}
        onCheckedChange={(next) => onChange(next === true)}
      />
      <span>{text}</span>
    </span>
  )
}

export type Status = {
  kind: 'pending' | 'saved' | 'failed'
  message: string
  retry?: () => void
}

/** One control's line: what it is doing, and the refusal that stopped it. */
export function StatusLine({ status }: { status: Status | undefined }) {
  if (!status) return null
  return (
    <div
      role={status.kind === 'failed' ? 'alert' : 'status'}
      className={
        status.kind === 'failed'
          ? 'flex items-center gap-2 rounded-md bg-error-container px-2 py-1.5 text-xs text-error-ink'
          : 'flex items-center gap-2 rounded-md bg-raised px-2 py-1.5 text-xs text-ink-muted'
      }
    >
      <span className="min-w-0 flex-1">{status.message}</span>
      {status.retry && (
        <Button size="xs" variant="outline" onClick={status.retry}>
          Read it again
        </Button>
      )}
    </div>
  )
}

/** A note the person should read before acting: what a control does and does not change. */
export function Note({ children }: { children: ReactNode }) {
  return <p className="text-xs text-ink-faint">{children}</p>
}

/**
 * What an authoring control hands the dialog: the ops to send, in one patch,
 * and the words for the saved line. It returns the saved definition id or false if refused.
 */
export type Submit = (
  ops: PatchOp[],
  what: string,
  base?: string,
) => Promise<string | false>
