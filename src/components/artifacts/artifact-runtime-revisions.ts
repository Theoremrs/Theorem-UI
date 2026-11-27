// SOURCING: none — the wording of a running artifact's revision state and of
// what is saved, over what the runtime reports (artifact-runtime.ts) and the
// App document's own save state (lib/theorem/apps AppSnapshot).
//
// AR-10: a streaming source draft, the committed source revision and the
// revision the runtime is running are three things. The running one is always
// named as itself: an older result still running is never labelled with the
// newer revision's name, and an update that needs a restart says so here.
// AR-11: saving the content, checkpointing the runtime and saving how it is
// viewed are three receipts; one never stands in for another.
import type { RuntimeSurface } from './artifact-runtime'

/** What a running artifact reports about its revisions and saves. */
export type RuntimeRevisions = {
  /** The revision of the source the document store has acknowledged. */
  committed?: string
  /** The revision the running output was started from. */
  running?: string
  /**
   * The running output was built from the committed revision's source. A
   * save that changes only declared state advances `committed` without a new
   * source, so nothing waits on a restart then.
   */
  runsCommittedSource?: boolean
  /** The committed revision is being prepared to run (an App's build). */
  building?: boolean
  /** The committed revision could not be prepared; the running one stays. */
  failed?: boolean
  /** Nothing runs: the person stopped it. */
  stopped?: boolean
  /** A source edit open in the runtime's editor, not saved. */
  editing?: boolean
  /** The revision running before the last restart, while the restart is news. */
  restartedFrom?: string
  /** The content's own save state. */
  content?: { pending: boolean; error?: string }
}

/** A source draft the view knows of: the agent still writing the next revision. */
export type SourceDraft = {
  /** The revision it will be, when the part says. */
  position?: string
}

export type RevisionStatus = {
  text: string
  tone: 'quiet' | 'attention' | 'negative'
  /** The committed revision runs only after a restart that has not happened. */
  restartNeeded: boolean
}

/** Lifecycles of a part whose source is committed. Any other is a draft still arriving. */
const COMMITTED = new Set([
  'ready',
  'complete',
  'completed',
  'committed',
  'final',
])

export function isDraftLifecycle(lifecycle: string): boolean {
  return !COMMITTED.has(lifecycle)
}

/**
 * The line a view shows about what is running. `name` turns a revision
 * position into the name the person sees (a version number in this thread);
 * positions it cannot name read as "an earlier version" or "a new version".
 */
export function revisionStatus(
  revisions: RuntimeRevisions,
  draft: SourceDraft | undefined,
  name: (position: string) => string | undefined = (position) =>
    `revision ${position}`,
): RevisionStatus {
  const { committed, running, building, failed, stopped, editing } = revisions
  const runningName = running
    ? (name(running) ?? 'an earlier version')
    : undefined
  const committedName = committed
    ? (name(committed) ?? 'a new version')
    : 'a new version'
  const still = runningName ? ` · still running ${runningName}` : ''
  if (stopped) return { text: 'Stopped', tone: 'quiet', restartNeeded: false }
  // A draft stops being one once the document store has committed it.
  if (draft && (draft.position === undefined || draft.position !== committed)) {
    const drafted = draft.position ? name(draft.position) : undefined
    return {
      text: `Writing ${drafted ?? 'a new version'}${still}`,
      tone: 'attention',
      restartNeeded: false,
    }
  }
  if (editing)
    return {
      text: `Source edit not saved${still}`,
      tone: 'attention',
      restartNeeded: false,
    }
  if (!running)
    return {
      text: failed
        ? `Couldn't start ${committedName}`
        : `Starting ${committedName}…`,
      tone: failed ? 'negative' : 'quiet',
      restartNeeded: false,
    }
  if (
    committed !== undefined &&
    committed !== running &&
    !revisions.runsCommittedSource
  ) {
    if (failed)
      return {
        text: `Couldn't build ${committedName}${still}`,
        tone: 'negative',
        restartNeeded: false,
      }
    if (building)
      return {
        text: `Building saved ${committedName}${still}`,
        tone: 'attention',
        restartNeeded: false,
      }
    return {
      text: `Saved ${committedName} · restart to run it${still}`,
      tone: 'attention',
      restartNeeded: true,
    }
  }
  if (revisions.restartedFrom !== undefined) {
    const before = name(revisions.restartedFrom) ?? 'the earlier version'
    return {
      text: `Running ${runningName} · restarted from ${before} to apply it`,
      tone: 'quiet',
      restartNeeded: false,
    }
  }
  return { text: `Running ${runningName}`, tone: 'quiet', restartNeeded: false }
}

export type Receipt = {
  label: string
  state: 'saved' | 'saving' | 'failed' | 'none' | 'device'
  text: string
}

/**
 * The three separate saves a running artifact has (AR-11): its content in
 * the document store, its runtime's own state, and how this view shows it.
 * `checkpoints` says whether the renderer can checkpoint its runtime; no
 * renderer in this build can, and the receipt says so plainly.
 */
export function persistenceReceipts(
  revisions: RuntimeRevisions,
  surface: RuntimeSurface,
  name: (position: string) => string | undefined = (position) =>
    `revision ${position}`,
  checkpoints = false,
): Array<Receipt> {
  const { content, committed } = revisions
  const contentReceipt: Receipt = content?.error
    ? { label: 'Content', state: 'failed', text: `Not saved: ${content.error}` }
    : content?.pending
      ? {
          label: 'Content',
          state: 'saving',
          text: 'Saving the App’s declared state…',
        }
      : committed !== undefined
        ? {
            label: 'Content',
            state: 'saved',
            text: `Saved. The document store acknowledged ${name(committed) ?? 'this version'}.`,
          }
        : { label: 'Content', state: 'none', text: 'Not read yet.' }
  const runtimeReceipt: Receipt = checkpoints
    ? { label: 'Running state', state: 'saved', text: 'Checkpointed.' }
    : {
        label: 'Running state',
        state: 'none',
        text: 'Not checkpointed. What the App holds in memory lives only in this running copy and is lost if it restarts.',
      }
  const viewReceipt: Receipt =
    surface === 'docked'
      ? {
          label: 'This view',
          state: 'device',
          text: 'The panel’s place in the layout is saved on this device. That does not save the App’s running state.',
        }
      : surface === 'expanded'
        ? {
            label: 'This view',
            state: 'none',
            text: 'Expanded for now; not saved.',
          }
        : {
            label: 'This view',
            state: 'none',
            text: 'Shown where it was opened; nothing about this view is saved.',
          }
  return [contentReceipt, runtimeReceipt, viewReceipt]
}
