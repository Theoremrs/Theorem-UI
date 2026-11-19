// SOURCING: none — the context reference a turn carries for one saved record, in the shape the chat request's `contextReferences` takes it (`location.resource.kind: "record"`, the record's id as `objectId`). The SDK's TheoremResource does not list this kind yet, so it is typed here, as lib/theorem/delegations types its own
import type { TheoremContextReference, TheoremRange } from '@theoremharness/sdk'

/** A saved record of a declared type, named by its id. */
export type RecordResource = {
  kind: 'record'
  objectId: string
  /** The type's singular name, as the schema register declares it. */
  objectType: string
}

export type RecordReference = Omit<TheoremContextReference, 'location'> & {
  location: { resource: RecordResource; range?: TheoremRange }
}

export const recordReference = (
  objectType: string,
  objectId: string,
  label: string,
): RecordReference => ({
  location: { resource: { kind: 'record', objectId, objectType } },
  label,
})
