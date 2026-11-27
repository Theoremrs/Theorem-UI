// SOURCING: lib/shell/safe-mode, @tanstack/react-router's Link, and the
// command registry's key bindings. A fixed, host-owned way to the recovery
// page from anywhere, mounted by the root so no shell can remove it
// (EXEC-05): the first tab stop, visible when focused, and a banner while
// safe mode is on.
import { Link } from '@tanstack/react-router'
import { leaveSafeMode, useSafeMode } from '@/lib/shell/safe-mode'

export function RecoveryControl() {
  const safe = useSafeMode((state) => state.active)
  if (safe)
    return (
      <div
        role="region"
        aria-label="Safe mode"
        className="fixed inset-x-0 top-0 z-[100] flex flex-wrap items-center justify-center gap-3 bg-warning/20 px-3 py-1.5 text-sm text-ink"
      >
        <span>Safe mode: user extensions are off.</span>
        <Link to="/recovery" className="underline underline-offset-2">
          Recovery
        </Link>
        <button
          type="button"
          className="underline underline-offset-2"
          onClick={() => leaveSafeMode()}
        >
          Leave safe mode
        </button>
      </div>
    )
  return (
    <Link
      to="/recovery"
      className="sr-only focus-visible:not-sr-only focus-visible:fixed focus-visible:left-3 focus-visible:top-3 focus-visible:z-[100] focus-visible:rounded-lg focus-visible:bg-background focus-visible:px-3 focus-visible:py-2 focus-visible:text-sm focus-visible:text-ink focus-visible:shadow-sheet focus-visible:outline-2 focus-visible:outline-focus"
    >
      Recovery
    </Link>
  )
}
