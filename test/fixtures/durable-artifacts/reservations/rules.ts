// The equipment-reservation rules: what a booking is, when two conflict,
// and what creating, editing, cancelling and undoing do to the bookings.
// Nothing here draws anything; main.tsx is the presentation.
//
// Time: a booking's start and end are instants, written as RFC 3339 text
// with an explicit offset ("2026-11-19T09:00:00-05:00"). They are compared as
// instants, never as display strings, and stored normalized to UTC ("Z").
// The zone a person sees them in is the presentation's choice (`zone` in
// main.tsx), and changing it changes no booking.

/** The rules' identity: a different meaning is a different version. */
export const RULES = { name: 'reservation-rules', version: '1' } as const

export interface Reservation {
  id: string
  resource: string
  /** UTC instant, RFC 3339 with "Z". */
  start: string
  /** UTC instant, RFC 3339 with "Z"; after `start`. */
  end: string
  holder: string
}

export type Command =
  | { kind: 'create'; reservation: Reservation }
  | { kind: 'edit'; reservation: Reservation }
  | { kind: 'cancel'; id: string }

export type Refusal =
  | { reason: 'conflict'; with: Array<Reservation> }
  | { reason: 'invalid'; detail: string }
  | { reason: 'unknown'; id: string }

export type Outcome =
  | { ok: true; reservations: Array<Reservation> }
  | { ok: false; refusal: Refusal }

const OFFSET_INSTANT =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/

/** Milliseconds since the epoch, for RFC 3339 text that names its offset; undefined otherwise. */
export function instant(text: string): number | undefined {
  if (!OFFSET_INSTANT.test(text)) return undefined
  const at = Date.parse(text)
  return Number.isNaN(at) ? undefined : at
}

/** The same instant, normalized to UTC text. */
export function utc(text: string): string | undefined {
  const at = instant(text)
  return at === undefined ? undefined : new Date(at).toISOString()
}

/**
 * Whether two bookings overlap. Intervals are half-open, [start, end): one
 * ending at 10:00 and another starting at 10:00 on the same resource do not.
 * Different resources never conflict, and a booking does not conflict with
 * itself (an edit is checked against everything else).
 */
export function overlaps(a: Reservation, b: Reservation): boolean {
  if (a.resource !== b.resource || a.id === b.id) return false
  return (
    instant(a.start)! < instant(b.end)! && instant(b.start)! < instant(a.end)!
  )
}

/** The bookings `candidate` would conflict with. */
export function conflicts(
  reservations: Array<Reservation>,
  candidate: Reservation,
): Array<Reservation> {
  return reservations.filter((other) => overlaps(candidate, other))
}

function normalized(reservation: Reservation): Reservation | Refusal {
  const start = utc(reservation.start)
  const end = utc(reservation.end)
  if (!start || !end)
    return {
      reason: 'invalid',
      detail:
        'Start and end must be instants with an offset, like 2026-11-19T09:00-05:00.',
    }
  if (instant(end)! <= instant(start)!)
    return { reason: 'invalid', detail: 'A booking ends after it starts.' }
  if (!reservation.resource.trim())
    return { reason: 'invalid', detail: 'A booking names its equipment.' }
  return { ...reservation, start, end }
}

/** Applies one command; a refused command changes nothing. */
export function apply(
  reservations: Array<Reservation>,
  command: Command,
): Outcome {
  if (command.kind === 'cancel') {
    if (!reservations.some((item) => item.id === command.id))
      return { ok: false, refusal: { reason: 'unknown', id: command.id } }
    return {
      ok: true,
      reservations: reservations.filter((item) => item.id !== command.id),
    }
  }
  const exists = reservations.some((item) => item.id === command.reservation.id)
  if (command.kind === 'create' && exists)
    return {
      ok: false,
      refusal: {
        reason: 'invalid',
        detail: `${command.reservation.id} is already booked.`,
      },
    }
  if (command.kind === 'edit' && !exists)
    return {
      ok: false,
      refusal: { reason: 'unknown', id: command.reservation.id },
    }
  const candidate = normalized(command.reservation)
  if ('reason' in candidate) return { ok: false, refusal: candidate }
  const clashing = conflicts(reservations, candidate)
  if (clashing.length > 0)
    return { ok: false, refusal: { reason: 'conflict', with: clashing } }
  const rest = reservations.filter((item) => item.id !== candidate.id)
  return {
    ok: true,
    reservations: [...rest, candidate].sort(
      (a, b) =>
        instant(a.start)! - instant(b.start)! || a.id.localeCompare(b.id),
    ),
  }
}

/**
 * The bookings with their history: every accepted command can be undone and
 * redone. Refused commands are not history.
 */
export class History {
  private past: Array<Array<Reservation>> = []
  private future: Array<Array<Reservation>> = []

  constructor(public current: Array<Reservation> = []) {}

  run(command: Command): Outcome {
    const outcome = apply(this.current, command)
    if (outcome.ok) {
      this.past.push(this.current)
      this.future = []
      this.current = outcome.reservations
    }
    return outcome
  }

  get canUndo(): boolean {
    return this.past.length > 0
  }

  get canRedo(): boolean {
    return this.future.length > 0
  }

  undo(): boolean {
    const previous = this.past.pop()
    if (!previous) return false
    this.future.push(this.current)
    this.current = previous
    return true
  }

  redo(): boolean {
    const next = this.future.pop()
    if (!next) return false
    this.past.push(this.current)
    this.current = next
    return true
  }
}
