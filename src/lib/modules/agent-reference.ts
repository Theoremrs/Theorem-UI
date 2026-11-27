// SOURCING: none — the context reference a turn carries for one placed custom component, in the
// shape the chat request's `contextReferences` takes it (`location.resource.kind: "component"`),
// typed here as lib/capabilities/reference.ts types its `capability` kind, since the SDK's
// TheoremResource does not list it.
//
// It is the module's own agent representation (its manifest's `agent`): what the component is for,
// and the value of its declared summary output as it stood when the person asked. The page's
// `selectedComponentId` is the component's stable instance id, so the agent can find it again on
// the page; `instances` names what it reads, so the agent regenerates the records itself through
// `capability_query` instead of trusting what the component drew.
import type { TheoremContextReference, TheoremRange } from '@theoremharness/sdk'

/** How much of a summary one envelope carries; a longer one is cut and says so. */
export const ENVELOPE_SUMMARY_MAX = 2000

export type ComponentResource = {
  kind: 'component'
  /** The module the component runs, `vault.focus`. */
  moduleId: string
  /** The component's stable id on its page. */
  selectedComponentId: string
  pageId?: string
  /** What the module says it is for, to an agent. */
  description: string
  /** The module's summary output, as text, when it declares one and has given one. */
  summary?: string
  /** The summary was longer than the envelope carries. */
  summaryTruncated?: true
  /** The capability instances the module declares it reads. */
  instances: string[]
}

export type ComponentContextReference = Omit<
  TheoremContextReference,
  'location'
> & {
  location: { resource: ComponentResource; range?: TheoremRange }
}

export type ComponentEnvelope = {
  moduleId: string
  selectedComponentId: string
  pageId?: string | undefined
  label: string
  description: string
  /** The summary output's current value, whatever its type. */
  summary?: unknown
  instances: ReadonlyArray<string>
}

const asText = (value: unknown) =>
  typeof value === 'string' ? value : JSON.stringify(value)

/** The reference "Ask about" puts in the composer for a custom component. */
export function componentContextReference(
  envelope: ComponentEnvelope,
): ComponentContextReference {
  const text =
    envelope.summary === undefined || envelope.summary === null
      ? undefined
      : asText(envelope.summary)
  const cut = text !== undefined && text.length > ENVELOPE_SUMMARY_MAX
  return {
    label: envelope.label,
    location: {
      resource: {
        kind: 'component',
        moduleId: envelope.moduleId,
        selectedComponentId: envelope.selectedComponentId,
        ...(envelope.pageId ? { pageId: envelope.pageId } : {}),
        description: envelope.description,
        ...(text === undefined
          ? {}
          : { summary: cut ? text.slice(0, ENVELOPE_SUMMARY_MAX) : text }),
        ...(cut ? { summaryTruncated: true as const } : {}),
        instances: [...envelope.instances],
      },
    },
  }
}
