// SOURCING: ui/dialog over Base UI Dialog for the list, date-fns for how long ago, and the
// module store's usePageHistory / useRestorePage over Theorem's page owner (/api/pages/v1),
// which keeps each revision of a page file. A revision is previewed in the page itself
// (page-view.tsx draws it with Puck's Render, as the page in use is drawn), not in the dialog.
// DESIGN.md's state grammar: each state says so, with the way out beside it.
import { formatDistanceToNowStrict } from 'date-fns'
import { History } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { usePageHistory } from '@/lib/modules/store'
import type { PageRevision, PageRevisionReason } from '@/lib/pages/contract'
import type { WorkspaceClient } from '@/lib/workspace/types'

/**
 * What a restore leaves alone. A page is its layout: which modules it shows,
 * where, and their settings. The records those modules show are kept by
 * their capabilities, never in a page, so no version of a page holds them.
 */
export const RECORDS_NOT_AFFECTED =
  'Records are not affected: a version is the page’s layout and settings. The records its modules show stay as they are now.'

const REASON: Record<PageRevisionReason, string> = {
  saved: 'Saved',
  patched: 'Edited',
  restored: 'Restored',
  captured: 'Kept from the vault file',
}

const when = (ms: number) => ({
  ago: `${formatDistanceToNowStrict(ms)} ago`,
  at: new Date(ms).toLocaleString(),
})

/** The History button and its list of the page's saved versions. */
export function PageHistory({
  client,
  path,
  current,
  onPreview,
}: {
  client: WorkspaceClient
  path: string
  /** The revision on screen. */
  current: string
  onPreview: (revision: PageRevision) => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button
        variant="ghost"
        size="xs"
        onClick={() => setOpen(true)}
        title="Earlier versions of this page"
      >
        <History />
        History
      </Button>
      {open && (
        <HistoryDialog
          client={client}
          path={path}
          current={current}
          onClose={() => setOpen(false)}
          onPreview={(revision) => {
            setOpen(false)
            onPreview(revision)
          }}
        />
      )}
    </>
  )
}

/** One saved version: its number, why and when it was kept, and a preview unless it is on screen. */
function VersionItem({
  revision,
  isCurrent,
  onPreview,
}: {
  revision: PageRevision
  isCurrent: boolean
  onPreview: (revision: PageRevision) => void
}) {
  const time = when(revision.savedAtMs)
  return (
    <li className="flex items-center gap-2 border-b border-separator py-2 text-sm last:border-b-0">
      <div className="min-w-0 flex-1">
        <div className="font-medium">
          Version {revision.seq}
          {isCurrent && (
            <span className="ms-2 text-xs font-normal text-ink-muted">
              On screen
            </span>
          )}
        </div>
        <div className="text-xs text-ink-muted">
          {REASON[revision.reason]} ·{' '}
          <time
            dateTime={new Date(revision.savedAtMs).toISOString()}
            title={time.at}
          >
            {time.ago}
          </time>
        </div>
      </div>
      {!isCurrent && (
        <Button variant="ghost" size="xs" onClick={() => onPreview(revision)}>
          Preview
        </Button>
      )}
    </li>
  )
}

function HistoryDialog({
  client,
  path,
  current,
  onClose,
  onPreview,
}: {
  client: WorkspaceClient
  path: string
  current: string
  onClose: () => void
  onPreview: (revision: PageRevision) => void
}) {
  const history = usePageHistory(client, path)
  // The newest entry for the revision on screen is the current one; a
  // restore of an older layout has the same content hash as that layout.
  const currentSeq = history.revisions.find((r) => r.revision === current)?.seq
  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="font-heading text-lg font-semibold">
            Page history
          </DialogTitle>
          <DialogDescription>
            Every save of this page is kept. Preview one to see it in place;
            restoring it saves it as a new version, and this one stays here.
          </DialogDescription>
        </DialogHeader>
        <p className="text-sm text-ink">{RECORDS_NOT_AFFECTED}</p>
        {history.isPending ? (
          <p role="status" className="text-sm text-ink-muted">
            Reading the history…
          </p>
        ) : history.error ? (
          <p role="alert" className="text-sm text-error-ink">
            The history did not open: {history.error.message}
          </p>
        ) : history.revisions.length === 0 ? (
          <p className="text-sm text-ink-muted">
            No versions are kept for this page yet. The next save starts its
            history.
          </p>
        ) : (
          <ol
            aria-label="Versions"
            className="flex max-h-80 flex-col overflow-y-auto"
          >
            {history.revisions.map((revision) => (
              <VersionItem
                key={revision.seq}
                revision={revision}
                isCurrent={revision.seq === currentSeq}
                onPreview={onPreview}
              />
            ))}
          </ol>
        )}
        {history.more && (
          <Button
            variant="ghost"
            size="sm"
            disabled={history.loadingMore}
            onClick={history.showMore}
          >
            {history.loadingMore ? 'Reading…' : 'Show older versions'}
          </Button>
        )}
      </DialogContent>
    </Dialog>
  )
}

/**
 * The bar over a previewed version: what it is, what restoring does and does
 * not change, and the ways out.
 */
export function RevisionPreviewBar({
  revision,
  blocked,
  restoring,
  failed,
  conflict,
  onRestore,
  onBack,
  onTakeTheirs,
}: {
  revision: PageRevision
  /** Why it cannot be restored now, if it cannot. */
  blocked?: string
  restoring: boolean
  failed?: string
  /** The page changed in the vault since it was opened. */
  conflict: boolean
  onRestore: () => void
  onBack: () => void
  onTakeTheirs: () => void
}) {
  const time = when(revision.savedAtMs)
  return (
    <div
      role="region"
      aria-label="Previewing an earlier version"
      className="flex flex-col gap-1 border-b border-separator bg-sheet px-4 py-2 text-xs"
    >
      <p className="text-ink">
        You are looking at version {revision.seq},{' '}
        {REASON[revision.reason].toLowerCase()}{' '}
        <time title={time.at}>{time.ago}</time>. Restoring it saves its layout
        as a new version; the current one stays in the history.
      </p>
      <p className="text-ink-muted">{RECORDS_NOT_AFFECTED}</p>
      <div className="flex flex-wrap items-center gap-2">
        {conflict ? (
          <>
            <span role="alert" className="text-error-ink">
              This page changed in the vault since you opened it. Use the
              vault’s version, then restore again.
            </span>
            <Button variant="ghost" size="xs" onClick={onTakeTheirs}>
              Use the vault’s
            </Button>
          </>
        ) : (
          <Button
            variant="outline"
            size="xs"
            disabled={!!blocked || restoring}
            onClick={onRestore}
          >
            {restoring ? 'Restoring…' : 'Restore this version'}
          </Button>
        )}
        <Button variant="ghost" size="xs" onClick={onBack}>
          Back to the current version
        </Button>
        {blocked && <span className="text-ink-muted">{blocked}</span>}
        {failed && (
          <span role="alert" className="text-error-ink">
            It was not restored: {failed}
          </span>
        )}
      </div>
    </div>
  )
}
