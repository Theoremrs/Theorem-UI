// SOURCING: the state grammar the app already uses for a list or board (components/work's Notice and
// loading skeletons): pending, saved and failed on a write, selection outlined, focus rings on every
// control. Both capability modules read the instance the same way, so they refuse and load the same
// way too.
import { Icon } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { refusalMessage } from '@/lib/capabilities/api'

/** One line of what happened to a write, and what the person can do next. */
export type Status = {
  kind: 'pending' | 'saved' | 'failed'
  message: string
  /** A conflict the person answers by reading the current state again. */
  reload?: boolean
  /** A call the journal holds but has not finished: its receipt can be read back. */
  receipt?: { instanceId: string; recordId: string }
}

export function StatusLine({
  status,
  onClear,
  onReload,
  onCheck,
}: {
  status: Status | undefined
  onClear: () => void
  onReload: () => void
  onCheck: () => void
}) {
  if (!status) return null
  const failed = status.kind === 'failed'
  return (
    <div
      role={failed ? 'alert' : 'status'}
      className={
        failed
          ? 'flex items-center gap-2 border-b border-separator bg-error-container px-3 py-1.5 text-sm text-error-ink'
          : 'flex items-center gap-2 border-b border-separator bg-raised px-3 py-1.5 text-sm text-ink-muted'
      }
    >
      <span className="min-w-0 flex-1">{status.message}</span>
      {status.receipt && (
        <Button size="xs" variant="outline" onClick={onCheck}>
          Check its receipt
        </Button>
      )}
      {status.reload && (
        <Button size="xs" variant="outline" onClick={onReload}>
          <Icon.Reload className="size-3.5" />
          Reload
        </Button>
      )}
      <button
        type="button"
        aria-label="Dismiss"
        onClick={onClear}
        className="rounded p-0.5 hover:bg-hover"
      >
        <Icon.Close className="size-3.5" />
      </button>
    </div>
  )
}

/** What a read that has not answered looks like: the rows it will hold, as placeholders. */
export function Loading({ rows = 3 }: { rows?: number }) {
  return (
    <div className="flex flex-col gap-px p-2" aria-busy>
      {Array.from({ length: rows }, (_, at) => (
        <Skeleton key={at} className="h-9 w-full rounded-md" />
      ))}
    </div>
  )
}

/** What a caller whose grant stops short is told: the capability is there, its rows are not theirs. */
export function PermissionState({
  name,
  what,
}: {
  name: string
  what?: string
}) {
  return (
    <div role="status" className="flex flex-col gap-1 p-3 text-sm">
      <p className="text-ink">{name}</p>
      <p className="text-ink-muted">
        Your grant does not include{' '}
        {what ?? "reading this capability's records"}. Someone who can author it
        has to add read to your grant.
      </p>
    </div>
  )
}

/** A refusal that is not a permission state, with the way back. */
export function DescribeState({
  error,
  onRetry,
  what = 'This capability',
}: {
  error: unknown
  onRetry: () => void
  what?: string
}) {
  return (
    <div role="alert" className="flex flex-col items-start gap-2 p-3 text-sm">
      <span className="text-error-ink">{refusalMessage(error, what)}</span>
      <Button size="sm" variant="outline" onClick={onRetry}>
        Try again
      </Button>
    </div>
  )
}
