// SOURCING: @assistant-ui/react's defaultDirectiveFormatter (the same parser
// the composer's chips and the sent message's chips use), over the draft text
// at send. The pick writes `:skill[Name]{name=id}`; this reads those picks back
// as the turn's structured `skills` field, so the harness loads the skill
// rather than relying on the model reading the directive (Theorem
// docs/plans/connections/CONTRACT.md, Explicit skill selection on a turn).
import { defaultDirectiveFormatter } from '@assistant-ui/react'

/** The turn field for the skills picked in the draft: nothing when none. */
export const skillTurnOptions = (
  text: string,
): { skills?: { ids: string[] } } => {
  const ids = defaultDirectiveFormatter
    .parse(text)
    .filter((segment) => segment.kind === 'mention' && segment.type === 'skill')
    .map((segment) => (segment as { id: string }).id)
  const unique = [...new Set(ids)]
  return unique.length ? { skills: { ids: unique } } : {}
}
