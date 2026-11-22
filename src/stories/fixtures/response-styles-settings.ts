// SOURCING: lib/theorem/passthrough theoremJson, the same call the page's hooks make, so the fake's routes answer the story's seeds as they answer the page. The state itself is the fake's (stories/fixtures/response-styles).
import { theoremJson } from '@/lib/theorem/passthrough'

const ROOT = '/api/chat/v1/response-styles'

const MINE = 'Release notes tone'
const FORMAL = 'theorem.style.formal'

/**
 * Puts the fake in a state worth looking at: the shipped Formal edited by the
 * person (the story's routes mark it as having a newer shipped version), and
 * one style of their own. It checks each step before it writes, so a remount does
 * not repeat one, and a seed that stopped partway resumes where it stopped.
 */
export async function seedResponseStylesSettings() {
  const { styles } = await theoremJson<{
    styles: { id: string; name: string; revision: number }[]
  }>(ROOT)
  // Formal is edited only while it is still the shipped text (revision 0).
  if (styles.find((style) => style.id === FORMAL)?.revision === 0)
    await theoremJson(`${ROOT}/styles/${FORMAL}`, {
      method: 'PUT',
      headers: { 'If-Match': '0' },
      body: {
        name: 'Formal',
        description: 'Precise, for a reader who will quote it.',
        body: 'Write for a reader who will quote this. Define terms before using them, number the steps of any procedure, and keep claims to what the sources support.',
        frameworks: ['theorem.framework.explanation'],
      },
    })
  if (styles.some((style) => style.name === MINE)) return
  await theoremJson(`${ROOT}/styles`, {
    method: 'POST',
    body: {
      name: MINE,
      description: 'Short, plain, in the order a reader scans.',
      body: 'Lead with what changed for the reader, then why. One paragraph per change. No marketing words.',
      frameworks: [],
    },
  })
}
