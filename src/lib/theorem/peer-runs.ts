// SOURCING: SPEC-THEOREM-PEER-AGENTS-1.0 (concurrent runs in one conversation: a thread's `activeRuns` as `threads.get` reports them, each run read through the SDK's `chat.runs.events` and stopped through `chat.runs.cancel`, never merged into one reply); lib/theorem/delegations' run-event folding (a specialist's run is read the same way), lib/theorem/roster's thread parsing, zustand for what this browser has read of each run
//
// A conversation with several participants has several runs at once. The
// thread's own singular `liveRun` says nothing then, so each run the thread
// lists as active is followed on its own: its own cursor, its own parts, its
// own end. Nothing here joins two runs' output, orders one behind another or
// names a run the combined answer; a run belongs to the participant that holds
// it, and one run's end or failure leaves the others as they were.
import { create } from 'zustand'
import {
  TERMINAL_RUN_EVENTS,
  describeRunFailure,
  mutate,
  theorem,
} from './client'
import type { Theorem } from './client'
import { addRunEvent } from './delegations'
import type { RunParts } from './delegations'
import { theoremJson } from './passthrough'
import { parseThreadRoster } from './roster'
import type { Participant, ParticipantRun } from './roster'

/** What this browser has read of one participant's run. */
export type PeerRun = RunParts & {
  threadId: string
  runId: string
  /** The participant that holds the run: who its output is by. */
  participantId: string
  /**
   * The last sequence applied. The next read resumes after it, so a dropped
   * stream is picked up where it left off rather than replayed. It is this
   * browser's own position: the cursor a thread lists for the run is how far
   * Theorem has taken it, and is not a hydrated snapshot of what it said.
   */
  cursor: number
  /** The run's public failure, once it has ended in one. */
  failure?: string
  /** The saved reply's id, once the run has persisted it. */
  messageId?: string
  /** Why reading stopped before the run ended. */
  error?: string
}

/** A participant whose run did not start for the last send, and why. */
export type StartProblem = { participantId: string; message: string }

type PeerRunsState = {
  /** The runs each thread last listed as active, by thread id. */
  active: Readonly<Record<string, readonly ParticipantRun[]>>
  /** Every run this browser has read, by run id, in the order it met them. */
  runs: Readonly<Record<string, PeerRun>>
  /** Who did not start for a thread's last send. The message itself went in. */
  problems: Readonly<Record<string, readonly StartProblem[]>>
}

export const usePeerRuns = create<PeerRunsState>()(() => ({
  active: {},
  runs: {},
  problems: {},
}))

const sameRuns = (a: readonly ParticipantRun[], b: readonly ParticipantRun[]) =>
  a.length === b.length &&
  a.every(
    (run, index) =>
      run.runId === b[index]!.runId &&
      run.participantId === b[index]!.participantId &&
      run.cursor === b[index]!.cursor,
  )

/** Records the run, with its holder, the first time a thread names it. */
function met(
  runs: PeerRunsState['runs'],
  threadId: string,
  run: ParticipantRun,
): PeerRunsState['runs'] {
  if (runs[run.runId]) return runs
  return {
    ...runs,
    [run.runId]: {
      threadId,
      runId: run.runId,
      participantId: run.participantId,
      cursor: 0,
      parts: new Map(),
    },
  }
}

/**
 * Takes a thread as Theorem reports it: the runs it lists as active become
 * runs to follow. A thread that carries no `activeRuns` — a conversation with
 * one agent, or a Theorem that predates rosters — lists none.
 */
export function noteThread(thread: unknown): void {
  const { threadId, selectedBranchId } = (thread ?? {}) as {
    threadId?: unknown
    selectedBranchId?: unknown
  }
  if (typeof threadId !== 'string' || !threadId) return
  // A run on another branch is not part of the conversation on screen. One
  // that names no branch predates branch-scoped runs and is kept.
  const activeRuns = parseThreadRoster(thread).activeRuns.filter(
    (run) =>
      !run.branchId ||
      typeof selectedBranchId !== 'string' ||
      run.branchId === selectedBranchId,
  )
  usePeerRuns.setState((state) => {
    const before = state.active[threadId] ?? []
    const runs = activeRuns.reduce(
      (known, run) => met(known, threadId, run),
      state.runs,
    )
    if (runs === state.runs && sameRuns(before, activeRuns)) return state
    return { active: { ...state.active, [threadId]: activeRuns }, runs }
  })
}

/**
 * Takes the runs a send started, which the next thread read will list too:
 * the person sees each begin without waiting for that read. A participant that
 * did not start is kept apart, with Theorem's word for why.
 */
export function noteStarted(
  threadId: string,
  started: readonly ParticipantRun[],
  problems: readonly StartProblem[],
): void {
  usePeerRuns.setState((state) => {
    const listed = state.active[threadId] ?? []
    const merged = [
      ...listed,
      ...started.filter(
        (run) => !listed.some((had) => had.runId === run.runId),
      ),
    ]
    return {
      active: { ...state.active, [threadId]: merged },
      runs: started.reduce(
        (known, run) => met(known, threadId, run),
        state.runs,
      ),
      problems: { ...state.problems, [threadId]: problems },
    }
  })
}

/** One event applied to a run. Replays are harmless: parts are keyed by id. */
export function foldPeerEvent(run: PeerRun, event: Theorem.RunEvent): PeerRun {
  // An event at or before the cursor was applied already; a replay must not
  // put an older version of a part over a newer one.
  if (run.cursor > 0 && event.seq <= run.cursor) return run
  const next: PeerRun = {
    ...run,
    ...addRunEvent(run, event),
    cursor: Math.max(run.cursor, event.seq),
  }
  if (event.sourceEventType === 'RUN.FAILED')
    next.failure = describeRunFailure(event.payload)
  if (
    event.sourceEventType === 'CHAT.MESSAGE.PERSISTED' &&
    event.payload.role === 'assistant' &&
    typeof event.payload.messageId === 'string'
  )
    next.messageId = event.payload.messageId
  return next
}

function update(runId: string, change: (run: PeerRun) => PeerRun) {
  usePeerRuns.setState((state) => {
    const run = state.runs[runId]
    if (!run) return state
    const next = change(run)
    return next === run ? state : { runs: { ...state.runs, [runId]: next } }
  })
}

/** Opens a run's event stream after a sequence. */
export type OpenRunEvents = (
  runId: string,
  after: number,
  signal: AbortSignal,
) => Promise<AsyncIterable<Theorem.RunEvent>>

const openRunEvents: OpenRunEvents = (runId, after, signal) =>
  theorem().chat.runs.events(
    { runId, after_seq: after },
    { abortSignal: signal },
  )

/** Reopen attempts for a stream that dropped before the run ended. */
const RESUME_ATTEMPTS = 8
const RESUME_BACKOFF_MS = 250

export type FollowOptions = {
  open?: OpenRunEvents
  /** The wait before reopening after a dropped stream, by attempt. */
  backoffMs?: (attempt: number) => number
}

const following = new Map<string, { signal: AbortSignal }>()

/**
 * Reads one run to its end, applying each event to that run alone. It starts
 * after the cursor this browser already holds (nothing, the first time, so the
 * run replays from its start), and a stream that ends or fails before the run
 * does is reopened after the last event applied. Following the same run twice
 * at once is one read; an abort leaves what was read in place for the next
 * read to continue from.
 */
export async function followPeerRun(
  runId: string,
  signal: AbortSignal,
  {
    open = openRunEvents,
    backoffMs = (n) => Math.min(RESUME_BACKOFF_MS * 2 ** n, 2000),
  }: FollowOptions = {},
): Promise<void> {
  const reading = following.get(runId)
  if (reading && !reading.signal.aborted) return
  const self = { signal }
  following.set(runId, self)
  try {
    // Read again each time: the abort comes while a stream is being waited on.
    const stopped = () => signal.aborted
    let failures = 0
    for (;;) {
      const run = usePeerRuns.getState().runs[runId]
      if (!run || run.ended || stopped()) return
      let cause: unknown
      try {
        const stream = await open(runId, run.cursor, signal)
        for await (const event of stream) {
          failures = 0
          update(runId, (current) => foldPeerEvent(current, event))
          if (TERMINAL_RUN_EVENTS.has(event.sourceEventType)) return
        }
      } catch (error) {
        cause = error
      }
      // A stream that ends or fails before the run does is a disconnect.
      if (stopped()) return
      failures += 1
      if (failures >= RESUME_ATTEMPTS) {
        update(runId, (current) => ({
          ...current,
          error:
            cause instanceof Error
              ? cause.message
              : `The run ${runId} disconnected before it ended`,
        }))
        return
      }
      await new Promise((resolve) =>
        setTimeout(resolve, backoffMs(failures - 1)),
      )
    }
  } finally {
    if (following.get(runId) === self) following.delete(runId)
  }
}

/**
 * Stops one participant, by its own id: Theorem commits the stop, which keeps
 * the participant from waking on its own again, and then cancels the runs it
 * holds. No other participant is touched.
 */
export function stopParticipant(
  threadId: string,
  participantId: string,
): Promise<unknown> {
  return mutate((headers) =>
    theoremJson(
      `/api/chat/v1/threads/${encodeURIComponent(threadId)}/participants/stop`,
      { method: 'POST', headers, body: { participantId } },
    ),
  )
}

/* ------------------------------------------------------------------ presence */

/**
 * What a participant is doing, as far as the thread and its runs say. A
 * participant that is waiting on the person or blocked has no event this
 * browser reads yet, so neither is claimed; an idle one is never shown as
 * thinking.
 */
export type PresenceState = 'working' | 'idle' | 'stopped' | 'failed'

export type Presence = {
  participantId: string
  label: string
  state: PresenceState
  /** The run it is working on, while it is. */
  runId?: string
}

/**
 * Each seated participant's presence. A run counts as live while the thread
 * lists it and this browser has not read its end, so a stale list cannot keep
 * a finished participant working.
 */
export function presenceOf(
  participants: readonly Participant[],
  active: readonly ParticipantRun[],
  runs: readonly PeerRun[],
): Presence[] {
  const live = (participantId: string) =>
    active.find(
      (run) =>
        run.participantId === participantId &&
        !runs.find((read) => read.runId === run.runId)?.ended,
    )
  return participants
    .filter((part) => part.status !== 'removed')
    .map((part) => {
      const run = live(part.participantId)
      const last = runs.findLast(
        (read) => read.participantId === part.participantId,
      )
      const state: PresenceState = run
        ? 'working'
        : part.status === 'stopped'
          ? 'stopped'
          : last?.ended === 'RUN.FAILED'
            ? 'failed'
            : 'idle'
      return {
        participantId: part.participantId,
        label: part.label,
        state,
        ...(run ? { runId: run.runId } : {}),
      }
    })
}

/** The runs this browser has read for one thread, in the order it met them. */
export const runsOfThread = (
  runs: Readonly<Record<string, PeerRun>>,
  threadId: string,
): PeerRun[] => Object.values(runs).filter((run) => run.threadId === threadId)

/**
 * The runs to draw: those whose saved reply the open transcript does not have
 * yet. A settled run reads from history, and drawing it twice would put one
 * author's words in two places.
 */
export function runsToShow(
  runs: readonly PeerRun[],
  inTranscript: {
    messageIds: ReadonlySet<string>
    runIds: ReadonlySet<string>
  },
): PeerRun[] {
  return runs.filter(
    (run) =>
      !inTranscript.runIds.has(run.runId) &&
      !(run.messageId && inTranscript.messageIds.has(run.messageId)),
  )
}
