// SOURCING: the state grammar the app already uses for a list or board (components/work's Notice and
// loading skeletons): pending, saved and failed on a write, selection outlined, focus rings on every
// control. Both capability modules read the instance the same way, so they refuse and load the same
// way too.
import { Icon } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { isReloadConflict, refusalMessage } from '@/lib/capabilities/api'
import { codes } from '@/lib/capabilities/contract'
import type { InvocationReceipt } from '@/lib/capabilities/contract'

/** One line of what happened to a write, and what the person can do next. */
export type Status = {
  kind: 'pending' | 'saved' | 'failed'
  message: string
  /** A conflict the person answers by reading the current state again. */
  reload?: boolean
  /** A call the journal holds but has not finished: its receipt can be read back. */
  receipt?: { instanceId: string; recordId: string }
}

/** A refused call or read, as the line the person reads: a stale read offers Reload. */
export const refusedStatus = (error: unknown, subject: string): Status => ({
  kind: 'failed',
  message: refusalMessage(error, subject),
  reload: isReloadConflict(error),
})

/**
 * What a receipt means, as the one line the person reads. `count` is how many
 * records one call ran over, when it ran over a selection.
 */
export function receiptStatus(
  receipt: InvocationReceipt,
  count?: number,
): Status {
  if (receipt.status === 'dispatched')
    return {
      kind: 'pending',
      message: `${receipt.actionKey} is journaled and has not finished, so whether it took effect is not yet known.`,
      receipt: { instanceId: receipt.instanceId, recordId: receipt.recordId },
    }
  const { outcome } = receipt
  if (outcome.outcome === 'completed') {
    const at = outcome.affected
      .map((affected) => `r${affected.revision}`)
      .join(', ')
    const over = count === undefined ? '' : ` on ${count} records`
    return {
      kind: 'saved',
      message: `${receipt.actionKey} saved${over}${at ? ` · ${at}` : ''}.`,
    }
  }
  // A call over several records fails whole: its message names the first
  // record that refused, and no record was written.
  return {
    kind: 'failed',
    message: `${count === undefined ? '' : 'No record was changed. '}${outcome.code}: ${outcome.message}`,
    reload: outcome.code === codes.REVISION_CONFLICT,
  }
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
