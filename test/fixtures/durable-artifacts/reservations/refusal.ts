// Why a command was refused, in terms a person can act on. Revision 2: after
// "I cannot see why this booking conflicts.", a conflict names each booking
// in the way, who holds it, and the exact window the two share, so the
// person can move theirs. The rules are unchanged.
import { instant } from './rules'
import type { Refusal, Reservation } from './rules'

export interface Explanation {
  headline: string
  /** Each booking in the way, and the window it shares with the candidate. */
  clashes: Array<{
    id: string
    holder: string
    resource: string
    from: string
    to: string
  }>
}

const later = (a: string, b: string) => (instant(a)! >= instant(b)! ? a : b)
const earlier = (a: string, b: string) => (instant(a)! <= instant(b)! ? a : b)

/** Why `refusal` happened; `candidate` is the booking that was refused, when there was one. */
export function explain(
  refusal: Refusal,
  candidate?: Reservation,
): Explanation {
  if (refusal.reason === 'unknown')
    return { headline: `There is no booking ${refusal.id}.`, clashes: [] }
  if (refusal.reason === 'invalid')
    return { headline: refusal.detail, clashes: [] }
  if (!candidate)
    return { headline: 'This booking conflicts with another.', clashes: [] }
  const clashes = refusal.with.map((other) => ({
    id: other.id,
    holder: other.holder,
    resource: other.resource,
    from: new Date(instant(later(candidate.start, other.start))!).toISOString(),
    to: new Date(instant(earlier(candidate.end, other.end))!).toISOString(),
  }))
  const count =
    clashes.length === 1
      ? 'another booking'
      : `${clashes.length} other bookings`
  return {
    headline: `${candidate.resource} is already booked by ${count} for part of this time.`,
    clashes,
  }
}
