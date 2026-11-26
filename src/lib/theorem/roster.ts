// SOURCING: SPEC-THEOREM-PEER-AGENTS-1.0's roster wire — a chat thread's `participants`, `rosterRevision` and `activeRuns`, and `PUT /api/chat/v1/threads/:threadId/participants` — read through the SDK's `chat.threads.get` and written through lib/theorem/client's `mutate` (CSRF, idempotency key) with lib/theorem/passthrough's `theoremJson`, because the vendored SDK has no roster client yet; zustand (the conversation's roster, kept as lib/theorem/generation keeps the conversation's response override, and for the same reason: it belongs to the conversation, not to the account); @assistant-ui/react for which conversation the composer has open.
import { create } from 'zustand'
import { useAuiState } from '@assistant-ui/react'
import { useEffect, useMemo } from 'react'
import { describeError, hasStatus, mutate, theorem } from './client'
import { isNotServed, theoremJson } from './passthrough'

const BASE = '/api/chat/v1'

/** One model, as the roster wire carries it. */
export type ModelRef = { provider: string; model: string }

/**
 * Theorem's catalog reference for one model, `<provider>/<model>`, split at the
 * first slash. The roster owns the pair because its wire carries the split form;
 * `resolvedModel` in lib/theorem/models is this same rule under the name the
 * rest of the chat uses.
 */
export function modelRef(ref: string): ModelRef {
  const slash = ref.indexOf('/')
  return { provider: ref.slice(0, slash), model: ref.slice(slash + 1) }
}

/** The catalog reference a `{ provider, model }` pair came from. */
export const refOf = (model: ModelRef): string =>
  `${model.provider}/${model.model}`

export type ParticipantStatus = 'active' | 'stopped' | 'removed'

/**
 * One agent in the conversation: an identity bound to one model, which the
 * person may re-bind to another model without moving the seat.
 *
 * `participantId` is stable within the thread and minted by Theorem as the
 * roster is admitted. A seat this browser added before that carries a local id
 * (see `minted`), which no request ever sends, so Theorem mints the real one.
 */
export type Participant = {
  participantId: string
  /** The principal this participant's turns are authored by. */
  actorId: string
  model: ModelRef
  /** The model's display name at admission. */
  label: string
  status: ParticipantStatus
  addedAtMs: number
}

/** A run one participant is doing right now, as the thread reports it. */
export type ParticipantRun = {
  participantId: string
  runId: string
  cursor: number
}

/** A conversation's roster: who is in the room, and what revision it stands at. */
export type Roster = {
  /** The revision to send back as `expectedRosterRevision`. */
  revision: number
  participants: readonly Participant[]
  activeRuns: readonly ParticipantRun[]
}

export const EMPTY_ROSTER: Roster = {
  revision: 0,
  participants: [],
  activeRuns: [],
}

/** A seat Theorem has not admitted. Never sent: leaving it out asks Theorem to mint the id. */
const LOCAL = 'local:'
const minted = (participantId: string) => participantId.startsWith(LOCAL)
const mint = () => `${LOCAL}${crypto.randomUUID()}`
/** The authorship principal Theorem names for a participant id. */
const actorOf = (participantId: string) => `agent:${participantId}`

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : undefined

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value ? value : undefined

const count = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

const STATUSES: readonly string[] = ['active', 'stopped', 'removed']

/**
 * One `participants` row. A row Theorem did not identify, or did not bind to a
 * model, is dropped: a seat nobody can be addressed by is not a participant.
 */
export function parseParticipant(raw: unknown): Participant | undefined {
  const row = record(raw)
  const participantId = text(row?.participantId)
  const model = record(row?.model)
  const provider = text(model?.provider)
  const id = text(model?.model)
  if (!participantId || provider === undefined || id === undefined)
    return undefined
  const status = text(row?.status)
  return {
    participantId,
    actorId: text(row?.actorId) ?? actorOf(participantId),
    model: { provider, model: id },
    label: text(row?.label) ?? id.split('/').at(-1) ?? id,
    // A row that does not say is a seat in use.
    status:
      status && STATUSES.includes(status)
        ? (status as ParticipantStatus)
        : 'active',
    addedAtMs: count(row?.addedAtMs) ?? 0,
  }
}

const parseRun = (raw: unknown): ParticipantRun | undefined => {
  const row = record(raw)
  const participantId = text(row?.participantId)
  const runId = text(row?.runId)
  if (!participantId || !runId) return undefined
  return { participantId, runId, cursor: count(row?.cursor) ?? 0 }
}

/**
 * A roster from either shape the wire uses: a thread's own fields
 * (`rosterRevision`, `participants`, `activeRuns`) or the `roster` a write
 * returns (`revision`, `participants`). Anything without rows is no roster.
 */
export function parseRoster(raw: unknown): Roster {
  const body = record(raw) ?? {}
  const rows = Array.isArray(body.participants) ? body.participants : []
  const runs = Array.isArray(body.activeRuns) ? body.activeRuns : []
  return {
    revision: count(body.revision) ?? count(body.rosterRevision) ?? 0,
    participants: rows.flatMap((row) => {
      const participant = parseParticipant(row)
      return participant ? [participant] : []
    }),
    activeRuns: runs.flatMap((run) => {
      const parsed = parseRun(run)
      return parsed ? [parsed] : []
    }),
  }
}

/**
 * The roster a thread carries. The vendored SDK does not name the fields yet,
 * so they are read off the thread as it arrives; a Theorem that predates the
 * roster has none, and this reads as an empty room.
 */
export function parseThreadRoster(thread: unknown): Roster {
  const row = record(thread) ?? {}
  return parseRoster({
    revision: row.rosterRevision,
    participants: row.participants,
    activeRuns: row.activeRuns,
  })
}

/** A seat for a model this browser chose, before Theorem mints its identity. */
function seat(ref: string, label?: string): Participant {
  const participantId = mint()
  return {
    participantId,
    // The principal a seat authors under, spelled from the id Theorem is asked
    // to mint. Neither field is sent — a seat this browser invented goes up as
    // a model alone — and both are replaced by what the write applies.
    actorId: actorOf(participantId),
    model: modelRef(ref),
    label: label ?? ref.split('/').at(-1) ?? ref,
    status: 'active',
    addedAtMs: Date.now(),
  }
}

/** The room's models, in the order they were seated: what a roster's seats are. */
const seatsOf = (participants: readonly Participant[]) =>
  participants.map((part) => refOf(part.model)).join('\n')

const seatsAre = (a: readonly Participant[], b: readonly Participant[]) =>
  seatsOf(a) === seatsOf(b)

/** What this browser holds for one conversation. */
type Entry = {
  /** The thread the conversation became, once it has one. */
  remoteId: string | undefined
  roster: Roster
  /** The participant the last edit acted on: what a turn and the effort menu follow. */
  lead: string | undefined
  /** A change here Theorem has not taken. */
  unsaved: boolean
  /** Counted per edit, so a write can tell whether the room changed while it was away. */
  edits: number
  /** Why the last write failed, in words; nothing while the roster stands as Theorem has it. */
  error: string | undefined
}

const NO_ENTRY: Entry = {
  remoteId: undefined,
  roster: EMPTY_ROSTER,
  lead: undefined,
  unsaved: false,
  edits: 0,
  error: undefined,
}

type RosterState = {
  /** The rosters this browser holds, by the conversation's own id. */
  byConversation: Readonly<Record<string, Entry>>
  /** The conversation the composer has open, so a send reads its roster at send time. */
  current: string | undefined
  /** Where each thread's roster has been read to, so a thread is read once. */
  reads: Readonly<Record<string, 'loading' | 'read'>>
  open: (conversation: string, remoteId: string | undefined) => void
  /** The composer left this conversation, so a send no longer reads its seats. */
  close: (conversation: string) => void
  beginRead: (remoteId: string) => void
  endRead: (remoteId: string, retryable: boolean) => void
  /** The roster a thread read brought, taken as it stands. */
  read: (conversation: string, remoteId: string, roster: Roster) => void
  /** The roster a write delivered, which replaces what this browser held. */
  confirm: (conversation: string, roster: Roster, raced: boolean) => void
  refused: (conversation: string, message: string) => void
  addModel: (conversation: string, ref: string, label?: string) => void
  removeParticipant: (conversation: string, participantId: string) => void
  replaceModel: (
    conversation: string,
    participantId: string,
    ref: string,
    label?: string,
  ) => void
  setRoster: (conversation: string, refs: readonly string[]) => void
  reset: (conversation: string) => void
}

const entryOf = (
  state: Pick<RosterState, 'byConversation'>,
  conversation: string,
) => state.byConversation[conversation] ?? NO_ENTRY

/** One edit applied: a new roster this browser chose, waiting for its thread. */
const edited = (
  state: RosterState,
  conversation: string,
  roster: Roster,
  lead: string | undefined,
): RosterState => {
  const before = entryOf(state, conversation)
  return {
    ...state,
    byConversation: {
      ...state.byConversation,
      [conversation]: {
        ...before,
        roster,
        lead,
        unsaved: true,
        edits: before.edits + 1,
        error: undefined,
      },
    },
  }
}

/**
 * The conversation's roster: the agents the next turns run with, each bound to
 * one model. It belongs to the conversation, so it is kept here and on the
 * thread — never in the account's preferences, which hold the one default model
 * a conversation with no roster of its own runs on.
 */
export const useRoster = create<RosterState>()((set) => ({
  byConversation: {},
  current: undefined,
  reads: {},

  open: (conversation, remoteId) =>
    set((state) => ({
      current: conversation,
      byConversation: {
        ...state.byConversation,
        [conversation]: { ...entryOf(state, conversation), remoteId },
      },
    })),

  close: (conversation) =>
    set((state) =>
      state.current === conversation ? { current: undefined } : {},
    ),

  beginRead: (remoteId) =>
    set((state) => ({ reads: { ...state.reads, [remoteId]: 'loading' } })),

  endRead: (remoteId, retryable) =>
    set((state) => {
      const { [remoteId]: _dropped, ...rest } = state.reads
      return { reads: retryable ? rest : { ...rest, [remoteId]: 'read' } }
    }),

  read: (conversation, remoteId, roster) =>
    set((state) => {
      const before = entryOf(state, conversation)
      // Seats chosen here and not written yet are not thrown away by a read:
      // the revision the thread now stands at is taken, the seats are kept, and
      // the next write carries them against that revision.
      const keeping =
        before.unsaved &&
        !seatsAre(before.roster.participants, roster.participants)
      const held = keeping
        ? { ...roster, participants: before.roster.participants }
        : roster
      const lead = held.participants.some(
        (part) => part.participantId === before.lead,
      )
        ? before.lead
        : held.participants[0]?.participantId
      return {
        ...state,
        reads: { ...state.reads, [remoteId]: 'read' },
        byConversation: {
          ...state.byConversation,
          [conversation]: {
            ...before,
            remoteId,
            roster: held,
            lead,
            error: undefined,
          },
        },
      }
    }),

  confirm: (conversation, roster, raced) =>
    set((state) => {
      const before = entryOf(state, conversation)
      // A write mints the ids of the seats it carried, so a seat is recognised
      // across the write by the model it runs rather than by the id this browser
      // invented for it.
      const claimed = new Map(
        roster.participants.map((part) => [refOf(part.model), part]),
      )
      const admitted = (part: Participant) => {
        const server = claimed.get(refOf(part.model))
        if (!server || !minted(part.participantId)) return part
        return {
          ...part,
          participantId: server.participantId,
          actorId: server.actorId,
          status: server.status,
          addedAtMs: server.addedAtMs,
        }
      }
      // A write mints the ids of the seats this browser seated, so the lead is
      // followed across by the model it was running rather than by its id.
      const was = before.roster.participants.find(
        (part) => part.participantId === before.lead,
      )
      const leadOf = (participants: readonly Participant[]) => {
        const carried = was
          ? participants.find((part) => refOf(part.model) === refOf(was.model))
          : undefined
        return carried?.participantId ?? participants[0]?.participantId
      }
      if (raced) {
        // A seat was chosen while this write was on its way, so the room Theorem
        // applied is not this browser's. The seats chosen here stay chosen, the
        // ones that write carried take the identities Theorem minted for them,
        // and the room goes up again against the revision the write moved to.
        const participants = before.roster.participants.map(admitted)
        return {
          ...state,
          byConversation: {
            ...state.byConversation,
            [conversation]: {
              ...before,
              roster: { ...roster, participants },
              lead: leadOf(participants),
            },
          },
        }
      }
      return {
        ...state,
        byConversation: {
          ...state.byConversation,
          [conversation]: {
            ...before,
            roster,
            lead: leadOf(roster.participants),
            unsaved: false,
            error: undefined,
          },
        },
      }
    }),

  refused: (conversation, message) =>
    set((state) => ({
      byConversation: {
        ...state.byConversation,
        [conversation]: { ...entryOf(state, conversation), error: message },
      },
    })),

  addModel: (conversation, ref, label) =>
    set((state) => {
      const entry = entryOf(state, conversation)
      const { participants } = entry.roster
      // A model holds one seat: the picker marks a row by whether its model is
      // in the room, so adding a model already seated names that seat rather
      // than doubling it.
      const seated = participants.find((part) => refOf(part.model) === ref)
      const lead = seated ?? seat(ref, label)
      return edited(
        state,
        conversation,
        seated
          ? entry.roster
          : { ...entry.roster, participants: [...participants, lead] },
        lead.participantId,
      )
    }),

  removeParticipant: (conversation, participantId) =>
    set((state) => {
      const entry = entryOf(state, conversation)
      const left = entry.roster.participants.filter(
        (part) => part.participantId !== participantId,
      )
      // The seat given up may have been the one a turn was running on; the
      // newest remaining seat takes it over, so the conversation keeps a lead.
      const lead =
        entry.lead === participantId ? left.at(-1)?.participantId : entry.lead
      return edited(
        state,
        conversation,
        { ...entry.roster, participants: left },
        lead,
      )
    }),

  replaceModel: (conversation, participantId, ref, label) =>
    set((state) => {
      const entry = entryOf(state, conversation)
      // The seat stays: the same participant, re-bound to another model, which
      // is what the roster write expresses by sending the id it already has.
      const participants = entry.roster.participants.map((part) =>
        part.participantId === participantId
          ? { ...part, model: modelRef(ref), label: label ?? part.label }
          : part,
      )
      return edited(
        state,
        conversation,
        { ...entry.roster, participants },
        participantId,
      )
    }),

  setRoster: (conversation, refs) =>
    set((state) => {
      const entry = entryOf(state, conversation)
      const byRef = new Map(
        entry.roster.participants.map((part) => [refOf(part.model), part]),
      )
      const participants = refs.map((ref) => byRef.get(ref) ?? seat(ref))
      const lead = participants.some(
        (part) => part.participantId === entry.lead,
      )
        ? entry.lead
        : participants[0]?.participantId
      return edited(
        state,
        conversation,
        { ...entry.roster, participants },
        lead,
      )
    }),

  reset: (conversation) =>
    set((state) => {
      const entry = entryOf(state, conversation)
      // An empty room is a choice: it leaves the model to Theorem's default, and
      // on a thread it is written as one.
      return {
        ...state,
        byConversation: {
          ...state.byConversation,
          [conversation]: {
            ...entry,
            roster: EMPTY_ROSTER,
            lead: undefined,
            unsaved: true,
            edits: entry.edits + 1,
            error: undefined,
          },
        },
      }
    }),
}))

/**
 * The model the conversation's lead runs on: undefined while the room is empty,
 * so the account's pick answers instead. This is the single place a roster
 * decides one model, which lib/theorem/models folds with the account's pick.
 */
export function leadRefOf(
  state: Pick<RosterState, 'byConversation' | 'current'>,
): string | undefined {
  const entry = state.current ? state.byConversation[state.current] : undefined
  if (!entry) return undefined
  const lead =
    entry.roster.participants.find(
      (part) => part.participantId === entry.lead,
    ) ?? entry.roster.participants[0]
  return lead ? refOf(lead.model) : undefined
}

/** The lead of the conversation the composer has open, read at send time. */
export const rosterLeadRef = () => leadRefOf(useRoster.getState())

/** The roster Theorem holds for a thread, without touching this browser's seats. */
async function fetchRoster(remoteId: string): Promise<Roster> {
  const { thread } = await theorem().chat.threads.get({ threadId: remoteId })
  return parseThreadRoster(thread)
}

/** What a roster write sends for one participant: its identity only when Theorem minted it. */
function requestParticipant(part: Participant) {
  return {
    ...(minted(part.participantId)
      ? {}
      : { participantId: part.participantId }),
    model: part.model,
    ...(part.label ? { label: part.label } : {}),
  }
}

/**
 * One roster write. The body replaces the room, so the whole list goes with the
 * revision Theorem said it held; a seat this browser invented comes back with a
 * server-minted id.
 */
async function putRoster(
  remoteId: string,
  expectedRosterRevision: number,
  participants: readonly Participant[],
): Promise<Roster> {
  const { roster } = await mutate((headers) =>
    theoremJson<{ roster: unknown }>(
      `${BASE}/threads/${encodeURIComponent(remoteId)}/participants`,
      {
        method: 'PUT',
        headers,
        body: {
          expectedRosterRevision,
          participants: participants.map(requestParticipant),
        },
      },
    ),
  )
  return parseRoster(roster)
}

/**
 * Reads the conversation's thread roster once per thread. A chat that is not a
 * thread yet has nothing to read; a Theorem that does not serve the roster
 * fields reads as an empty room and is not asked again. Returns the read when
 * there is one, so a caller waiting on it can.
 */
export function readConversationRoster(
  conversation: string,
  remoteId: string | undefined,
): Promise<void> | undefined {
  if (!remoteId || useRoster.getState().reads[remoteId]) return undefined
  useRoster.getState().beginRead(remoteId)
  return fetchRoster(remoteId)
    .then((roster) => useRoster.getState().read(conversation, remoteId, roster))
    .catch((error: unknown) =>
      // A Theorem that does not serve a roster is not asked again: its thread
      // reads as an empty room. One that could not be reached is, on the next
      // mount.
      useRoster.getState().endRead(remoteId, !isNotServed(error)),
    )
}

/** Where each conversation's writes queue up, so one is on its way at a time. */
const queues = new Map<string, Promise<void>>()

/**
 * Brings the conversation's thread up to what this browser holds: one write at a
 * time, the room as it stands when the write goes out. A seat chosen while a
 * write was on its way is not lost — the revision that write moved to is taken,
 * and the newer room follows against it. A revision Theorem did not expect is
 * re-read and the write retried explicitly, never overwritten. A refused write
 * says why and leaves the change waiting, so the next edit tries again. A
 * conversation with no thread keeps its roster client-side and writes nothing.
 */
async function drain(conversation: string) {
  for (;;) {
    const entry = useRoster.getState().byConversation[conversation]
    const remoteId = entry?.remoteId
    if (!entry?.unsaved || !remoteId) return
    const seats = entry.roster.participants
    // What this write sent, so a seat chosen while it was away is told apart
    // from one Theorem has now taken.
    const sent = entry.edits
    const applied = async (expectedRosterRevision: number) =>
      putRoster(remoteId, expectedRosterRevision, seats)
    try {
      const roster = await applied(entry.roster.revision)
      useRoster
        .getState()
        .confirm(
          conversation,
          roster,
          useRoster.getState().byConversation[conversation]?.edits !== sent,
        )
    } catch (error) {
      if (!hasStatus(error, 409)) {
        useRoster.getState().refused(conversation, describeError(error))
        return
      }
      // Someone else moved the roster: take the revision the thread now holds
      // and send this room against it, once more.
      try {
        const { revision } = await fetchRoster(remoteId)
        const roster = await applied(revision)
        useRoster
          .getState()
          .confirm(
            conversation,
            roster,
            useRoster.getState().byConversation[conversation]?.edits !== sent,
          )
      } catch (retryError) {
        useRoster.getState().refused(conversation, describeError(retryError))
        return
      }
    }
  }
}

/**
 * Asks for the conversation's roster to be written. Every edit calls this, and
 * each call waits behind the one before it, so a fast room of three is three
 * writes in order rather than three at once.
 */
export function saveRoster(conversation: string): Promise<void> {
  const queued = (queues.get(conversation) ?? Promise.resolve()).then(() =>
    drain(conversation),
  )
  queues.set(conversation, queued)
  void queued.finally(() => {
    if (queues.get(conversation) === queued) queues.delete(conversation)
  })
  return queued
}

export type ConversationRoster = {
  /** The conversation's key: stable across the thread's creation. */
  conversation: string
  /** The thread it became, once it has one. */
  remoteId: string | undefined
  participants: readonly Participant[]
  activeRuns: readonly ParticipantRun[]
  /** The revision Theorem last confirmed for this roster. */
  revision: number
  /** A seat is waiting on a write. */
  unsaved: boolean
  /** Why the last write failed, in words. */
  error: string | undefined
  addModel: (ref: string, label?: string) => void
  removeParticipant: (participantId: string) => void
  replaceModel: (participantId: string, ref: string, label?: string) => void
  setRoster: (refs: readonly string[]) => void
  reset: () => void
}

/**
 * The open conversation's roster, and the means to change it. A chat that is not
 * a thread yet keeps its seats here; the moment it has one, the seats are
 * written onto it, and every later edit follows.
 */
export function useConversationRoster(): ConversationRoster {
  const conversation = useAuiState((s) => s.threadListItem.id)
  const remoteId = useAuiState((s) => s.threadListItem.remoteId) ?? undefined
  const entry = useRoster((s) => s.byConversation[conversation])
  const edits = entry?.edits ?? 0
  useEffect(() => {
    // Which conversation a turn belongs to, so a send reads these seats at send
    // time, as it used to read one browser-wide pick. Nothing else reads a
    // roster: a conversation the composer has closed leaves the model to the
    // account's pick, as it did before there were rooms.
    useRoster.getState().open(conversation, remoteId)
    readConversationRoster(conversation, remoteId)
    return () => useRoster.getState().close(conversation)
  }, [conversation, remoteId])
  // One write per edit, queued by `saveRoster` while a write is on its way.
  useEffect(() => {
    if (edits) void saveRoster(conversation)
  }, [conversation, edits, remoteId])

  const roster = entry?.roster ?? EMPTY_ROSTER
  return useMemo(
    () => ({
      conversation,
      remoteId: entry?.remoteId ?? remoteId,
      participants: roster.participants,
      activeRuns: roster.activeRuns,
      revision: roster.revision,
      unsaved: entry?.unsaved ?? false,
      error: entry?.error,
      addModel: (ref, label) => {
        useRoster.getState().addModel(conversation, ref, label)
        void saveRoster(conversation)
      },
      removeParticipant: (participantId) => {
        useRoster.getState().removeParticipant(conversation, participantId)
        void saveRoster(conversation)
      },
      replaceModel: (participantId, ref, label) => {
        useRoster
          .getState()
          .replaceModel(conversation, participantId, ref, label)
        void saveRoster(conversation)
      },
      setRoster: (refs) => {
        useRoster.getState().setRoster(conversation, refs)
        void saveRoster(conversation)
      },
      reset: () => {
        useRoster.getState().reset(conversation)
        void saveRoster(conversation)
      },
    }),
    [conversation, remoteId, entry, roster],
  )
}
