// SOURCING: SPEC-THEOREM-PEER-AGENTS-1.0's send to a room — the existing `POST /api/chat/v1/threads/:threadId/messages` carrying `expectedRosterRevision`, `audience`, and nothing that names a model — through window.fetch and lib/theorem/passthrough's `readTheoremJson` (so lib/theorem/send-recovery, which saves a one-run send for replay, never holds a send whose answer is several runs), lib/theorem/client's `mutate` (CSRF, idempotency key) and `bootstrap` (`peerMaxOutputTokens`), lib/theorem/roster (the room this browser holds); native Chat only, never /mcp
//
// A room of two or more seats sends one message to every participant, and
// Theorem answers with one outcome per participant. This module only asks and
// reports: the participant's model comes from the roster on Theorem's side, so
// a send that cannot go to the room fails with its reason rather than falling
// back to the one model a single-agent send would use.
import { TheoremError } from '@theoremharness/sdk'
import { bootstrap, describeError, hasStatus, mutate, theorem } from './client'
import { noteStarted } from './peer-runs'
import type { StartProblem } from './peer-runs'
import { readTheoremJson } from './passthrough'
import {
  parseThreadRoster,
  readConversationRoster,
  saveRoster,
  useRoster,
} from './roster'
import type { ParticipantRun } from './roster'

/** A send that did not go to the room, in words for the person. Nothing was sent. */
export class PeerSendRefused extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'PeerSendRefused'
  }
}

/** The room a send goes to. */
export type Room = {
  /** The roster revision this browser's room stands at, which Theorem checks. */
  revision: number
}

const NOT_SENT = 'Your message was not sent.'

/**
 * The conversation's room, once what this browser chose is written; undefined
 * for a conversation of one agent or none, which sends as it always has. A room
 * whose seats are not all written is refused rather than sent to a different
 * room than the one on screen.
 */
export async function settleRoom(
  conversation: string,
  remoteId: string,
): Promise<Room | undefined> {
  useRoster.getState().open(conversation, remoteId)
  // A thread's room is read once as the conversation opens; a send that beats
  // that read must not take the room for empty.
  await readConversationRoster(conversation, remoteId)
  if (useRoster.getState().reads[remoteId] !== 'read')
    throw new PeerSendRefused(
      `${NOT_SENT} The conversation's roster could not be checked. Try again.`,
    )
  const seatsOf = () =>
    (
      useRoster.getState().byConversation[conversation]?.roster.participants ??
      []
    ).filter((part) => part.status !== 'removed')
  if (seatsOf().length < 2) return undefined
  await saveRoster(conversation)
  const entry = useRoster.getState().byConversation[conversation]
  const seats = seatsOf()
  if (
    !entry ||
    seats.length < 2 ||
    entry.unsaved ||
    seats.some((part) => part.participantId.startsWith('local:'))
  )
    throw new PeerSendRefused(
      `${NOT_SENT} The room could not be saved first${entry?.error ? `: ${entry.error}` : '.'}`,
    )
  return { revision: entry.roster.revision }
}

/** The shared output-token limit this Theorem sends rooms under, if it has one. */
async function sharedLimit(): Promise<number> {
  const { peerMaxOutputTokens } = (await bootstrap()) as {
    peerMaxOutputTokens?: unknown
  }
  if (
    typeof peerMaxOutputTokens !== 'number' ||
    !Number.isFinite(peerMaxOutputTokens) ||
    peerMaxOutputTokens <= 0
  )
    throw new PeerSendRefused(
      `${NOT_SENT} This Theorem has no shared output limit set for rooms of several agents, so it will not start them. Remove a model from the room to send to one agent.`,
    )
  return peerMaxOutputTokens
}

/**
 * What a turn asks for that a room cannot do. A room runs each participant on
 * its own roster model, so a plan, a role, an ACP binding or a regime would
 * be asking one agent's way of working of all of them.
 */
const NOT_FOR_A_ROOM = ['plan', 'planning', 'regime', 'acpBinding', 'role']

/**
 * The turn's options with what only a single-agent send carries taken off:
 * the model (each participant's comes from the roster) and the page's
 * operations (a participant has no page to drive). Refuses what would change
 * the meaning of the send.
 */
export function roomTurnOptions(
  options: Record<string, unknown>,
): Record<string, unknown> {
  const unsupported = NOT_FOR_A_ROOM.filter(
    (key) => options[key] !== undefined && options[key] !== false,
  )
  if (unsupported.length)
    throw new PeerSendRefused(
      `${NOT_SENT} ${unsupported.includes('planning') || unsupported.includes('plan') ? 'Plan mode is' : 'This setting is'} for one agent at a time; turn it off or remove a model from the room.`,
    )
  const {
    model: _model,
    clientOperations: _ops,
    clientSurface: _surface,
    ...kept
  } = options
  return kept
}

/** One participant's outcome for a send. */
type Outcome = {
  participantId: string
  status: string
  run?: { runId?: unknown }
  problem?: { detail?: unknown; code?: unknown; title?: unknown }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object'

/**
 * What a send's answer says each participant did. Started runs are the ones to
 * follow; a failed start is that participant's alone. A participant that was
 * busy keeps the run it had and reads the message at its next boundary.
 */
export function parseOutcomes(answer: unknown): {
  started: ParticipantRun[]
  problems: StartProblem[]
} {
  const runs: unknown[] =
    isRecord(answer) && Array.isArray(answer.runs) ? answer.runs : []
  const started: ParticipantRun[] = []
  const problems: StartProblem[] = []
  for (const row of runs) {
    if (!isRecord(row) || typeof row.participantId !== 'string') continue
    const outcome = row as Outcome
    if (outcome.status === 'started' && typeof outcome.run?.runId === 'string')
      started.push({
        participantId: outcome.participantId,
        runId: outcome.run.runId,
        cursor: 0,
      })
    else if (outcome.status === 'failed') {
      const problem = outcome.problem
      const said = [problem?.detail, problem?.title, problem?.code].find(
        (value): value is string => typeof value === 'string' && value !== '',
      )
      problems.push({
        participantId: outcome.participantId,
        message: said ?? 'It did not start.',
      })
    }
  }
  return { started, problems }
}

/** A send whose outcome is not known, kept so its retry is the same send. */
const unsettled = new Map<
  string,
  { body: string; key: string; ifMatch: string }
>()

const REVISION_CONFLICT = 'chat_revision_conflict'
const isRevisionConflict = (error: unknown) =>
  hasStatus(error, 409) &&
  error instanceof TheoremError &&
  isRecord(error.body) &&
  error.body.code === REVISION_CONFLICT

export type RoomSend = {
  threadId: string
  text: string
  uploadIds?: readonly string[]
  /** The turn's options, as a single-agent send would carry them. */
  options: Record<string, unknown>
  room: Room
  signal: AbortSignal
}

/**
 * One message to every participant of the room. Theorem stores the message
 * once and starts a run for each participant that can start; the answer names
 * each. A conversation that moves while the send is on its way (a participant's
 * reply landing) is retried against its new revision, unless the room itself
 * moved, which is refused: it is not the room the person sent to.
 */
export async function sendToRoom(send: RoomSend): Promise<{
  messageId: string | undefined
  started: ParticipantRun[]
  problems: StartProblem[]
}> {
  await sharedLimit()
  const options = roomTurnOptions(send.options)
  const url = `${window.location.origin}/api/chat/v1/threads/${encodeURIComponent(send.threadId)}/messages`
  const attempt = async (retried: boolean): Promise<unknown> => {
    const snapshot = await theorem().chat.threads.get(
      { threadId: send.threadId },
      { abortSignal: send.signal },
    )
    const body = JSON.stringify({
      ...options,
      branchId: snapshot.thread.selectedBranchId,
      text: send.text,
      ...(send.uploadIds?.length ? { uploadIds: send.uploadIds } : {}),
      expectedRosterRevision: send.room.revision,
      audience: { kind: 'everyone' },
    })
    // The same send retried keeps its identity, so Theorem answers it once.
    const again = unsettled.get(send.threadId)
    const sent =
      again?.body === body
        ? again
        : {
            body,
            key: crypto.randomUUID(),
            ifMatch: String(snapshot.thread.revision),
          }
    unsettled.set(send.threadId, sent)
    try {
      const answer = await mutate(async (headers) =>
        readTheoremJson(
          await window.fetch(url, {
            method: 'POST',
            credentials: 'same-origin',
            signal: send.signal,
            headers: {
              Accept: 'application/json',
              'Content-Type': 'application/json',
              'X-CSRF-Token': headers['X-CSRF-Token'],
              'Idempotency-Key': sent.key,
              'If-Match': sent.ifMatch,
            },
            body,
          }),
        ),
      )
      unsettled.delete(send.threadId)
      return answer
    } catch (error) {
      // Only a send Theorem answered is over; one that got no answer may have
      // gone in, and its retry must be the same send.
      if (error instanceof TheoremError) unsettled.delete(send.threadId)
      if (!retried && isRevisionConflict(error)) {
        const now = parseThreadRoster(
          (await theorem().chat.threads.get({ threadId: send.threadId }))
            .thread,
        )
        if (now.revision === send.room.revision) return attempt(true)
        throw new PeerSendRefused(
          `${NOT_SENT} The room changed somewhere else. Reload this conversation to see it as it stands, then send again.`,
          { cause: error },
        )
      }
      throw error
    }
  }
  let answer: unknown
  try {
    answer = await attempt(false)
  } catch (error) {
    if (error instanceof PeerSendRefused || send.signal.aborted) throw error
    throw new PeerSendRefused(`${NOT_SENT} ${describeError(error)}`, {
      cause: error,
    })
  }
  const { started, problems } = parseOutcomes(answer)
  noteStarted(send.threadId, started, problems)
  const record =
    isRecord(answer) && isRecord(answer.record) ? answer.record : undefined
  return {
    messageId:
      typeof record?.messageId === 'string' ? record.messageId : undefined,
    started,
    problems,
  }
}
