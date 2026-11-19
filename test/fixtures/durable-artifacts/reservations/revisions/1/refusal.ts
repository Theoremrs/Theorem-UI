// Revision 1 of refusal.ts, kept as the person saw it before their feedback
// ("I cannot see why this booking conflicts."). Only this file changed in
// revision 2; the rules did not.
import type { Refusal, Reservation } from '../../rules'

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

export function explain(
  refusal: Refusal,
  _candidate?: Reservation,
): Explanation {
  if (refusal.reason === 'conflict')
    return {
      headline: 'This booking conflicts with an existing reservation.',
      clashes: [],
    }
  if (refusal.reason === 'unknown')
    return { headline: `There is no booking ${refusal.id}.`, clashes: [] }
  return { headline: refusal.detail, clashes: [] }
}
