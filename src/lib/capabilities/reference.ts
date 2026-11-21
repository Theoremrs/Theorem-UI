// SOURCING: none — the context reference a turn carries for a capability selection, in the shape the
// chat request's `contextReferences` takes it (`location.resource.kind: "capability"`). The SDK's
// TheoremResource does not list this kind yet, so it is typed here, as components/crm/reference.ts
// types its own `record` kind.
//
// The envelope is what a page's capability module has on screen: which instance and view the rows
// came from, which records the person selected and at what revision, and whether the view narrowed
// or cut the answer short. It carries no record bodies: the agent regenerates the current state with
// `capability_query` over the same instance and view, which is the point of naming the revisions it
// was read at.
import type { TheoremContextReference, TheoremRange } from '@theoremharness/sdk'

/** One selected record, at the revision the person was looking at. */
export type CapabilitySelection = { id: string; revision: number }

export type CapabilityResource = {
  kind: 'capability'
  instanceId: string
  /** The collection the selected records belong to. */
  collectionKey: string
  /** The page the selection came from, so the agent finds the module again. */
  pageId?: string
  /** The view the rows were read through; absent for a record opened outside one. */
  viewKey?: string
  /** What the capability is for, as its definition says. */
  purpose: string
  selected: CapabilitySelection[]
  /** A view filter narrowed the rows: the selection is not the whole collection. */
  filtered: boolean
  /** The page cut the rows short: more records exist than were shown. */
  truncated: boolean
}

export type CapabilityContextReference = Omit<
  TheoremContextReference,
  'location'
> & {
  location: { resource: CapabilityResource; range?: TheoremRange }
}

/**
 * How many selected ids one envelope carries. A selection larger than this is
 * cut short and the envelope says so through `truncated`, so a turn's context
 * stays bounded however far a person drags.
 */
export const ENVELOPE_SELECTED_MAX = 100

export type CapabilityEnvelope = {
  instanceId: string
  collectionKey: string
  pageId?: string | undefined
  viewKey?: string | undefined
  purpose: string
  label: string
  selected: CapabilitySelection[]
  filtered: boolean
  truncated: boolean
}

/** The reference a capability module puts in the composer for what it shows. */
export function capabilityContextReference(
  envelope: CapabilityEnvelope,
): CapabilityContextReference {
  const selected = envelope.selected.slice(0, ENVELOPE_SELECTED_MAX)
  return {
    label: envelope.label,
    location: {
      resource: {
        kind: 'capability',
        instanceId: envelope.instanceId,
        collectionKey: envelope.collectionKey,
        ...(envelope.pageId ? { pageId: envelope.pageId } : {}),
        ...(envelope.viewKey ? { viewKey: envelope.viewKey } : {}),
        purpose: envelope.purpose,
        selected,
        filtered: envelope.filtered,
        // More selected ids than the envelope carries is its own cut.
        truncated:
          envelope.truncated || selected.length < envelope.selected.length,
      },
    },
  }
}
