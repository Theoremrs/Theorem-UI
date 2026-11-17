// SOURCING: hand-roll — the host's `program_report` (docs/plans/2026-11-15-ide-host-program-report.md of the backend worktree) is Theorem's own wire shape, not in the installed SDK (0.6.0-alpha.8) and not modelled by zod-style libraries as four cases with a text bound in Unicode scalars; zod would parse the shape but not choose per field between dropping, keeping and calling the whole report unavailable, which is the point of this file.

/** The words the host maps a program's report to; `unknown` carries the program's own word in `rawState`. */
export const PROGRAM_STATES = [
  'idle',
  'working',
  'done',
  'blocked',
  'error',
  'unknown',
] as const
export type ProgramState = (typeof PROGRAM_STATES)[number]

/** The most Unicode scalar values one report text keeps, whatever the host sent. */
export const REPORT_TEXT_LIMIT = 4096

/** What the program says about itself. Opaque text, shown as text and never read as a command. */
export interface ProgramStatus {
  state: ProgramState
  /** The program's own word, only with `state: 'unknown'`. */
  rawState?: string
  kind?: string
  msg?: string
  app?: string
  title?: string
  /** 0-255, as sent. */
  progress?: number
}

/**
 * What the host says the program reported. Exactly four cases; nothing here is task, approval or
 * lifecycle state, and no case is ever derived from output or liveness.
 * - `unavailable`: the host says nothing (an older host, a native terminal, or a report that could not be read).
 * - `never_reported`: the host says the program has never reported.
 * - `cleared`: it reported before and has no current word. `statusMs` or `seq` is the core's, when sent.
 * - `current`: its current word.
 */
export type ProgramReport =
  | { kind: 'unavailable' }
  | { kind: 'never_reported' }
  | { kind: 'cleared'; statusMs?: number; seq?: number }
  | { kind: 'current'; status: ProgramStatus; statusMs?: number; seq?: number }

export const UNAVAILABLE: ProgramReport = { kind: 'unavailable' }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** A non-negative whole number the host can have counted; anything else is not a timestamp or a sequence. */
const count = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined

/**
 * Text kept as text: control characters (escape sequences, NUL, DEL, C1) become U+FFFD so the text can
 * never act as terminal input or markup, and it is cut at {@link REPORT_TEXT_LIMIT} Unicode scalars
 * whatever the host's own bound was.
 */
export function boundedText(value: string): string {
  const scalars = Array.from(value)
  const cut = scalars.length > REPORT_TEXT_LIMIT
  const kept = cut ? scalars.slice(0, REPORT_TEXT_LIMIT) : scalars
  return kept
    .map((char) =>
      char !== '\n' && char !== '\t' && /\p{Cc}/u.test(char) ? '\ufffd' : char,
    )
    .join('')
}

const text = (value: unknown): string | undefined =>
  typeof value === 'string' ? boundedText(value) : undefined

function statusOf(value: Record<string, unknown>): ProgramStatus | undefined {
  const word = value.state
  // Without a word there is nothing to show, and none is made up.
  if (typeof word !== 'string') return undefined
  const known = (PROGRAM_STATES as readonly string[]).includes(word)
  const status: ProgramStatus = {
    state: known ? (word as ProgramState) : 'unknown',
  }
  if (!known) {
    // A word outside the list is the program's own word, not working or idle; the host should have said so in `raw_state`.
    status.rawState = boundedText(word)
  } else if (word === 'unknown') {
    const raw = text(value.raw_state)
    if (raw !== undefined) status.rawState = raw
  }
  for (const [field, key] of [
    ['kind', 'kind'],
    ['msg', 'msg'],
    ['app', 'app'],
    ['title', 'title'],
  ] as const) {
    const found = text(value[field])
    if (found !== undefined) status[key] = found
  }
  const { progress } = value
  if (
    typeof progress === 'number' &&
    Number.isInteger(progress) &&
    progress >= 0 &&
    progress <= 255
  ) {
    status.progress = progress
  }
  return status
}

/**
 * Reads one `program_report` field. It never throws and never answers a case the host did not state.
 * - Absent, null, not an object, or `reported` not a boolean: `unavailable`.
 * - `reported: false` beside a `status`: the two contradict, so `unavailable` (neither claim is made).
 * - `reported: true` with no `status`: `cleared`. A `status` that is not an object, or has no `state` string: `unavailable`.
 * - A `state` outside the list becomes `unknown` carrying that word as `rawState`, never any other word.
 * - Per field: text that is not a string, a `progress` that is not an integer in 0-255, a `status_ms` or `seq` that is not a
 *   non-negative whole number is dropped, and the rest of the report is kept.
 */
export function parseProgramReport(value: unknown): ProgramReport {
  if (!isRecord(value) || typeof value.reported !== 'boolean') {
    return UNAVAILABLE
  }
  const order = {
    ...(count(value.status_ms) !== undefined
      ? { statusMs: count(value.status_ms) }
      : {}),
    ...(count(value.seq) !== undefined ? { seq: count(value.seq) } : {}),
  }
  const { status } = value
  if (!value.reported) {
    return status === undefined || status === null
      ? { kind: 'never_reported' }
      : UNAVAILABLE
  }
  if (status === undefined || status === null) {
    return { kind: 'cleared', ...order }
  }
  const read = isRecord(status) ? statusOf(status) : undefined
  return read ? { kind: 'current', status: read, ...order } : UNAVAILABLE
}

/**
 * Whether an update replaces the report held. An update replaces unless both carry the core's sequence
 * and the update's is older: sequences order only against sequences (a timestamp is not comparable with
 * one, and an update with neither says nothing about order, so it replaces).
 */
export function replaces(held: ProgramReport, update: ProgramReport): boolean {
  const heldSeq = 'seq' in held ? held.seq : undefined
  const newSeq = 'seq' in update ? update.seq : undefined
  return !(heldSeq !== undefined && newSeq !== undefined && newSeq < heldSeq)
}
