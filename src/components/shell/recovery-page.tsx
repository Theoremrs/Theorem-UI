// SOURCING: lib/shell/recovery (the host-owned actions and the hook other
// workstreams plug into), lib/shell/failures, lib/shell/layout-store and
// lib/shell/safe-mode, the ui Button, and @tanstack/react-router's Link. This
// page imports nothing a custom shell, module or handler can replace, so it
// renders when they are broken (EXEC-05 / A22).
import { Link } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useFailures } from '@/lib/shell/failures'
import { useLayoutStore } from '@/lib/shell/layout-store'
import {
  clearFailures,
  layoutRevision,
  recoveryActions,
  resetLayoutChecked,
  useRecoveryActions,
} from '@/lib/shell/recovery'
import type { RecoveryOutcome } from '@/lib/shell/recovery'
import { leaveSafeMode, useSafeMode } from '@/lib/shell/safe-mode'

function Outcome({ outcome }: { outcome: RecoveryOutcome | undefined }) {
  if (!outcome) return null
  return (
    <p
      role="status"
      className={
        outcome.ok ? 'text-sm text-ink-muted' : 'text-sm text-destructive'
      }
    >
      {outcome.message}
    </p>
  )
}

function ActionCard({
  label,
  description,
  onRun,
  children,
}: {
  label: string
  description: string
  onRun: () => RecoveryOutcome | Promise<RecoveryOutcome>
  children?: React.ReactNode
}) {
  const [outcome, setOutcome] = useState<RecoveryOutcome>()
  const [busy, setBusy] = useState(false)
  return (
    <li className="flex flex-col gap-2 rounded-lg border border-separator p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 flex-1 basis-64">
          <h3 className="font-medium">{label}</h3>
          <p className="text-sm text-ink-muted">{description}</p>
        </div>
        <Button
          variant="outline"
          disabled={busy}
          onClick={async () => {
            setBusy(true)
            try {
              setOutcome(await onRun())
            } catch (error) {
              setOutcome({
                ok: false,
                message: error instanceof Error ? error.message : String(error),
              })
            } finally {
              setBusy(false)
            }
          }}
        >
          {label}
        </Button>
      </div>
      <Outcome outcome={outcome} />
      {children}
    </li>
  )
}

/** Reset layout, checked against the revision this page last showed. */
function LayoutReset() {
  const revision = useLayoutStore((state) => state.revision)
  const preserved = useLayoutStore((state) => state.preserved)
  const [seen, setSeen] = useState(revision)
  const stale = seen !== revision
  return (
    <ActionCard
      label="Reset layout"
      description="Starts every project from the shipped layout. The arrangements you have are kept aside, never deleted."
      onRun={() => {
        const outcome = resetLayoutChecked(seen)
        if (!outcome.ok) setSeen(layoutRevision())
        return outcome
      }}
    >
      {stale && (
        <p role="status" className="text-sm text-ink-muted">
          A layout was saved since this page showed it. Press the button again
          to reset what is there now.
        </p>
      )}
      {preserved.length > 0 && (
        <p className="text-sm text-ink-muted">
          {preserved.length} earlier{' '}
          {preserved.length === 1 ? 'arrangement is' : 'arrangements are'} kept
          aside:{' '}
          {preserved
            .map(
              (one) =>
                `${one.reason} (${one.projectId}, ${new Date(one.at).toLocaleDateString()})`,
            )
            .join('; ')}
        </p>
      )}
    </ActionCard>
  )
}

function exportPreserved() {
  const blob = new Blob(
    [JSON.stringify(useLayoutStore.getState().preserved, null, 2)],
    { type: 'application/json' },
  )
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = 'theorem-preserved-layouts.json'
  anchor.click()
  URL.revokeObjectURL(url)
}

function Failures() {
  const failures = useFailures((state) => state.failures)
  return (
    <section
      aria-labelledby="recovery-failures"
      className="flex flex-col gap-3"
    >
      <div className="flex items-center justify-between gap-3">
        <h2 id="recovery-failures" className="text-lg font-medium">
          Recorded failures
        </h2>
        {failures.length > 0 && (
          <Button size="sm" variant="ghost" onClick={() => clearFailures()}>
            Clear the record
          </Button>
        )}
      </div>
      {failures.length === 0 ? (
        <p className="text-sm text-ink-muted">
          Nothing has failed since the record was last cleared.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {[...failures].reverse().map((failure) => (
            <li
              key={failure.id}
              className="rounded-lg border border-separator p-3 text-sm"
            >
              <p className="font-medium">
                {failure.area}
                {failure.contributionId ? `: ${failure.contributionId}` : ''}
                <span className="ms-2 font-normal text-ink-muted">
                  {new Date(failure.at).toLocaleString()}
                </span>
              </p>
              <p className="wrap-break-word">{failure.message}</p>
              {failure.stack && (
                <pre className="mt-1 max-h-32 overflow-auto text-xs text-ink-muted">
                  {failure.stack}
                </pre>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/**
 * The host-owned recovery page. While it is shown user extensions are off, so
 * nothing a person installed can sit between them and a working workspace.
 */
export function RecoveryPage() {
  const safe = useSafeMode((state) => state.active)
  useEffect(() => {
    // Shown with user extensions off, then restored to how the visit was.
    const before = useSafeMode.getState()
    useSafeMode.getState().enter('recovery-route')
    return () => {
      if (!before.active) useSafeMode.getState().leave()
    }
  }, [])
  const actions = recoveryActions(useRecoveryActions((state) => state.actions))
  return (
    <main className="mx-auto flex min-h-dvh max-w-2xl flex-col gap-6 bg-background px-4 py-8 text-ink">
      <header className="flex flex-col gap-2">
        <h1 className="font-heading text-2xl font-medium">Recovery</h1>
        <p className="text-ink-muted">
          This page is part of Theorem itself, so it works when a shell, a
          handler or a module you installed does not. User extensions are off
          while you are here. Nothing below deletes your data.
        </p>
        <nav
          aria-label="Leave recovery"
          className="flex flex-wrap gap-3 text-sm"
        >
          <Link to="/" className="text-link underline underline-offset-2">
            Open the workspace
          </Link>
          <a href="/?safe=1" className="text-link underline underline-offset-2">
            Open the workspace in safe mode
          </a>
          {safe && (
            <button
              type="button"
              className="text-link underline underline-offset-2"
              onClick={() => leaveSafeMode()}
            >
              Leave safe mode
            </button>
          )}
        </nav>
      </header>
      <section
        aria-labelledby="recovery-actions"
        className="flex flex-col gap-3"
      >
        <h2 id="recovery-actions" className="text-lg font-medium">
          Restore a working workspace
        </h2>
        <ul className="flex flex-col gap-3">
          {actions.map((action) => (
            <ActionCard
              key={action.id}
              label={action.label}
              description={action.description}
              onRun={action.run}
            />
          ))}
          <LayoutReset />
        </ul>
        <Button
          variant="ghost"
          size="sm"
          className="self-start"
          onClick={exportPreserved}
        >
          Export the layouts kept aside
        </Button>
      </section>
      <Failures />
    </main>
  )
}
