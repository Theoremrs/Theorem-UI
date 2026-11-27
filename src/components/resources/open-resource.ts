// SOURCING: lib/resources open facade; the state wording of lib/resources/state, so an unopened resource says why.
import { open } from '@/lib/resources/registry'
import type { OpenIntent, OpenResult } from '@/lib/resources/registry'
import { STATE_DETAIL } from '@/lib/resources/state'
import type { ResourceRef } from '@/lib/resources/types'

/** The words for a resource that did not open. */
export const refusalText = (result: Extract<OpenResult, { opened: false }>) =>
  STATE_DETAIL[result.state]

/** Opens `ref` and returns the refusal text when it did not open, so the caller can show it. */
export async function openResource(
  ref: ResourceRef,
  intent: OpenIntent = 'open',
): Promise<string | undefined> {
  const result = await open(ref, intent)
  return result.opened ? undefined : refusalText(result)
}
