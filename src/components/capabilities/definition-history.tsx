// SOURCING: the history route's paged read (queries' useCapabilityHistory over lib/capabilities/api),
// the authoring dialog's parts and the app's Button; dates in the records' own en-US form
// (components/records/fields). The plan's definition history: which definition the instance was
// pinned to, when, by whom and why, with re-pin to an earlier one. It shows definition history only;
// records keep their own, and a re-pin never moves them.
import { Button } from '@/components/ui/button'
import { refusalMessage } from '@/lib/capabilities/api'
import type {
  DefinitionHistoryEntry,
  DefinitionHistoryReason,
} from '@/lib/capabilities/contract'
import { Note } from './authoring-parts'
import { useCapabilityHistory } from './queries'

const WHEN = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
})

const REASONS: Record<DefinitionHistoryReason, string> = {
  created: 'Created',
  authored: 'Authored',
  repinned: 'Re-pinned',
  instantiated: 'Created from template',
}

/** What one pin changed, in the words the entry carries. */
function changed(entry: DefinitionHistoryEntry) {
  if (entry.reason === 'instantiated')
    return `${REASONS.instantiated} ${entry.ops[0] ?? ''}`.trim()
  if (entry.reason === 'authored' && entry.ops.length)
    return `${REASONS.authored}: ${entry.ops.join(', ')}`
  return REASONS[entry.reason]
}

export function DefinitionHistoryPanel({
  instanceId,
  busy,
  onRepin,
}: {
  instanceId: string
  busy: boolean
  onRepin: (definitionId: string) => void
}) {
  const history = useCapabilityHistory(instanceId)
  const pages = history.data?.pages ?? []
  const entries = pages.flatMap((page) => page.entries)
  const current = pages[0]?.currentDefinitionId

  return (
    <div className="flex flex-col gap-2">
      <Note>
        Each time this instance was pinned to a definition, newest first.
        Re-pinning changes which views and actions it uses. Records are not
        changed: every record, including any created since, stays as it is.
      </Note>
      {history.isPending ? (
        <Note>Reading the history…</Note>
      ) : history.isError ? (
        <div role="alert" className="flex flex-col items-start gap-1.5">
          <p className="text-xs text-error-ink">
            {refusalMessage(history.error, 'The history')}
          </p>
          <Button
            size="xs"
            variant="outline"
            onClick={() => void history.refetch()}
          >
            Try again
          </Button>
        </div>
      ) : entries.length === 0 ? (
        <Note>
          No history is recorded for this instance yet. One created before
          history was kept has none until its next change, and none is invented
          for it.
        </Note>
      ) : (
        <ol aria-label="Definition history" className="flex flex-col gap-1">
          {entries.map((entry) => {
            const inUse = entry.definitionId === current
            return (
              <li
                key={entry.seq}
                className="flex items-start gap-2 rounded-md border border-separator px-2 py-1.5"
              >
                <span className="w-8 shrink-0 text-xs text-ink-faint">
                  #{entry.seq}
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="text-xs text-ink">{changed(entry)}</span>
                  <code className="truncate font-mono text-xs text-ink-muted">
                    {entry.definitionId}
                  </code>
                  <span className="text-xs text-ink-faint">
                    {entry.principal} · {WHEN.format(new Date(entry.atMs))}
                  </span>
                </span>
                {inUse ? (
                  <span className="shrink-0 rounded-md bg-raised px-1.5 py-0.5 text-xs text-ink-muted">
                    In use
                  </span>
                ) : (
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={busy}
                    aria-label={`Re-pin entry ${entry.seq}`}
                    title={`Use ${entry.definitionId} again; records are not changed`}
                    onClick={() => onRepin(entry.definitionId)}
                  >
                    Re-pin
                  </Button>
                )}
              </li>
            )
          })}
        </ol>
      )}
      {history.hasNextPage && (
        <Button
          size="xs"
          variant="outline"
          className="self-start"
          disabled={history.isFetchingNextPage}
          onClick={() => void history.fetchNextPage()}
        >
          {history.isFetchingNextPage ? 'Loading…' : 'Show older entries'}
        </Button>
      )}
    </div>
  )
}
