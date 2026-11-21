import { Button } from '@/components/ui/button'
import type { LayoutStatus } from '@/lib/workbench/layout/status'

export function WorkspaceLayoutStatus({
  status,
  recover,
}: {
  status: LayoutStatus
  recover: (operation: 'load' | 'retrySave') => void
}) {
  let label: string
  let action: { label: string; operation: 'load' | 'retrySave' } | undefined
  switch (status.kind) {
    case 'pending':
      label =
        status.operation === 'restore' ? 'Restoring layout…' : 'Saving layout…'
      break
    case 'account':
      label = status.revision
        ? 'Layout saved to account'
        : 'Using the default layout'
      break
    case 'device':
      label = 'Using this device’s layout copy'
      action = { label: 'Retry restore', operation: 'load' }
      break
    case 'failed':
      label =
        status.operation === 'restore'
          ? 'Could not restore layout'
          : 'Layout changes could not be saved'
      action =
        status.recovery === 'save'
          ? { label: 'Retry save', operation: 'retrySave' }
          : {
              label:
                status.recovery === 'check'
                  ? 'Restore saved account layout'
                  : 'Retry restore',
              operation: 'load',
            }
      break
  }
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-2 border-b border-line px-2 py-0.5 text-xs text-ink-muted">
      <span role="status">{label}</span>
      {action && (
        <Button
          type="button"
          size="xs"
          variant="ghost"
          onClick={() => recover(action.operation)}
        >
          {action.label}
        </Button>
      )}
      {'diagnostic' in status && (
        <details>
          <summary className="cursor-pointer">Details</summary>
          <dl className="grid grid-cols-[auto_1fr] gap-x-2 break-all">
            {[
              ['Route', status.diagnostic.route],
              ['Workspace', status.diagnostic.workspaceId],
              ['Request', status.diagnostic.requestId],
              ['HTTP status', status.diagnostic.httpStatus],
              ['Content type', status.diagnostic.contentType],
              ['Problem code', status.diagnostic.problemCode],
              ['Correlation', status.diagnostic.correlationId],
            ].map(([field, value]) =>
              value ? (
                <DiagnosticField key={field} field={field} value={value} />
              ) : null,
            )}
          </dl>
        </details>
      )}
    </div>
  )
}

function DiagnosticField({
  field,
  value,
}: {
  field: string | number | undefined
  value: string | number
}) {
  return (
    <>
      <dt>{field}</dt>
      <dd>{value}</dd>
    </>
  )
}
