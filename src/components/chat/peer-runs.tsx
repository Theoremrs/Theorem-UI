// SOURCING: lib/theorem/peer-runs (each participant's run, read on its own), lib/theorem/roster (who is seated), assistant-ui ReadonlyThreadProvider with ThreadPrimitive.ViewportProvider and ThreadPrimitive.Messages (a run renders as a read-only thread inside the conversation's runtime, as the delegation panel's specialist run does), the thread's AssistantMessageContent, ui/button
import {
  MessagePrimitive,
  ReadonlyThreadProvider,
  ThreadPrimitive,
  useAuiState,
} from '@assistant-ui/react'
import { useEffect, useMemo } from 'react'
import type { FC } from 'react'
import { AssistantMessageContent } from '@/components/assistant-ui/elements/thread.aui'
import { ShimmerLabel } from '@/components/assistant-ui/elements/surfaces'
import { Icon } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { describeError } from '@/lib/theorem/client'
import { runMessage } from '@/lib/theorem/delegations'
import {
  followPeerRun,
  presenceOf,
  runsOfThread,
  runsToShow,
  stopParticipant,
  usePeerRuns,
} from '@/lib/theorem/peer-runs'
import type { PeerRun, Presence, StartProblem } from '@/lib/theorem/peer-runs'
import { rereadConversationRoster, useRoster } from '@/lib/theorem/roster'
import type { Participant, ParticipantRun } from '@/lib/theorem/roster'
import { toastManager } from '@/components/coss/toast'

const NONE: readonly never[] = []

const STATE_WORD: Record<Presence['state'], string> = {
  working: 'Working',
  idle: 'Idle',
  stopped: 'Stopped',
  failed: 'Failed',
}

const PeerMessage: FC = () => (
  <MessagePrimitive.Root className="py-1">
    <AssistantMessageContent />
  </MessagePrimitive.Root>
)

/**
 * One participant's run, read on its own and drawn under its holder's name.
 * Mounting follows the run from this browser's cursor; leaving the page stops
 * reading and keeps what was read.
 */
const PeerRunSection: FC<{
  run: PeerRun
  label: string
  onStop: (participantId: string) => void
}> = ({ run, label, onStop }) => {
  const { runId } = run
  useEffect(() => {
    const reading = new AbortController()
    void followPeerRun(runId, reading.signal)
    return () => reading.abort()
  }, [runId])
  const message = useMemo(() => runMessage(runId, run), [runId, run])
  const working = run.ended === undefined
  return (
    <section
      data-slot="theorem-peer-run"
      data-run-id={runId}
      data-participant-id={run.participantId}
      aria-label={`${label}'s run`}
      className="flex flex-col gap-1"
    >
      <header className="flex items-center gap-2 text-xs text-ink-muted">
        <span className="font-medium">{label}</span>
        {working && (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            aria-label={`Stop ${label}`}
            onClick={() => onStop(run.participantId)}
          >
            <Icon.Stop />
            Stop
          </Button>
        )}
      </header>
      {message ? (
        <ReadonlyThreadProvider messages={[message]}>
          <ThreadPrimitive.ViewportProvider>
            <ThreadPrimitive.Messages>
              {() => <PeerMessage />}
            </ThreadPrimitive.Messages>
          </ThreadPrimitive.ViewportProvider>
        </ReadonlyThreadProvider>
      ) : (
        working && (
          <ShimmerLabel className="block text-xs text-ink-faint">
            {label} is starting
          </ShimmerLabel>
        )
      )}
      {run.failure && (
        <p role="alert" className="text-xs text-error-ink">
          {run.failure}
        </p>
      )}
      {run.error && !run.ended && (
        <p role="alert" className="text-xs text-error-ink">
          {run.error}
        </p>
      )}
    </section>
  )
}

/**
 * Who is in the room and what each is doing, then each run under its own
 * holder. The runs are never joined: two participants answering at once are
 * two replies, each growing in its own place.
 */
export const PeerRunBoard: FC<{
  participants: readonly Participant[]
  active: readonly ParticipantRun[]
  /** Every run read for the thread: what presence is told from. */
  read: readonly PeerRun[]
  /** The runs to draw. */
  runs: readonly PeerRun[]
  /** Who did not start for the last send. */
  problems?: readonly StartProblem[]
  /** Stops one participant: its runs, and its waking on its own. */
  onStop: (participantId: string) => void
}> = ({ participants, active, read, runs, problems = [], onStop }) => {
  const presence = presenceOf(participants, active, read)
  const labelOf = (participantId: string) =>
    participants.find((part) => part.participantId === participantId)?.label ??
    participantId
  // A room of one with no run of its own is the ordinary conversation.
  if (presence.length < 2 && runs.length === 0 && problems.length === 0)
    return null
  return (
    <div
      data-slot="theorem-peer-runs"
      className="-mt-8 mb-14 ms-9 flex flex-col gap-4"
    >
      {presence.length > 0 && (
        <ul
          aria-label="Participants"
          className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-muted"
        >
          {presence.map((entry) => (
            <li
              key={entry.participantId}
              data-participant-id={entry.participantId}
              data-state={entry.state}
            >
              {entry.label}{' '}
              <span className="text-ink-faint">{STATE_WORD[entry.state]}</span>
            </li>
          ))}
        </ul>
      )}
      {problems.map((problem) => (
        <p
          key={problem.participantId}
          role="alert"
          className="text-xs text-error-ink"
        >
          {labelOf(problem.participantId)} did not start: {problem.message}
        </p>
      ))}
      {runs.map((run) => (
        <PeerRunSection
          key={run.runId}
          run={run}
          label={labelOf(run.participantId)}
          onStop={onStop}
        />
      ))}
    </div>
  )
}

/**
 * Below the conversation: the participants' presence and the runs they hold
 * right now. A conversation with one agent shows nothing here.
 */
export const PeerRunStreams: FC = () => {
  const conversation = useAuiState((s) => s.threadListItem.id)
  const threadId = useAuiState((s) => s.threadListItem.remoteId) ?? undefined
  const participants =
    useRoster((s) => s.byConversation[conversation]?.roster.participants) ??
    NONE
  const active =
    usePeerRuns((s) => (threadId ? s.active[threadId] : undefined)) ?? NONE
  const problems = usePeerRuns((s) =>
    threadId ? s.problems[threadId] : undefined,
  )
  const known = usePeerRuns((s) => s.runs)
  const messages = useAuiState((s) => s.thread.messages)
  const read = useMemo(
    () => (threadId ? runsOfThread(known, threadId) : []),
    [known, threadId],
  )
  const runs = useMemo(() => {
    const runIds = new Set<string>()
    for (const message of messages) {
      const runId = message.metadata.custom.theoremRunId
      if (typeof runId === 'string') runIds.add(runId)
    }
    return runsToShow(read, {
      messageIds: new Set(messages.map((message) => message.id)),
      runIds,
    })
  }, [read, messages])
  const stop = (participantId: string) => {
    if (!threadId) return
    const label =
      participants.find((part) => part.participantId === participantId)
        ?.label ?? 'the participant'
    void stopParticipant(threadId, participantId)
      // Stopping changes the participant's status, which the room reads again.
      .then(() => rereadConversationRoster(conversation, threadId))
      .catch((error: unknown) =>
        toastManager.add({
          type: 'error',
          title: `Could not stop ${label}`,
          description: describeError(error),
        }),
      )
  }
  return (
    <PeerRunBoard
      participants={participants}
      active={active}
      read={read}
      runs={runs}
      problems={problems}
      onStop={stop}
    />
  )
}
