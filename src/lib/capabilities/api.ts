// SOURCING: lib/theorem/passthrough (theoremJson, the SDK's passthrough for routes its generated
// clients do not cover yet) with the shared CSRF and idempotency helper from lib/theorem/client, as
// components/work/api.ts uses them; every fetch of /api/capabilities/v1 is here, so SDK methods
// replace these callers when the SDK is regenerated. The routes and their bodies are the ones
// Theorem's capabilities_api pins (docs/plans/user-authored-capabilities/README.md).
import { mutate } from '@/lib/theorem/client'
import { theoremJson } from '@/lib/theorem/passthrough'
import { codes, matchAll } from './contract'
import type {
  AuthorResult,
  CapabilityDefinition,
  CapabilityRecordRow,
  CreateInstanceRequest,
  DescribeResult,
  DiscoverResult,
  DefinitionPatch,
  InvocationReceipt,
  InvokeRequest,
  QueryRequest,
  QueryResult,
  RepinRequest,
} from './contract'

export const CAPABILITIES = '/api/capabilities/v1'

const id = encodeURIComponent

/** A read: no CSRF, no idempotency key. */
const read = <T>(path: string) => theoremJson<T>(path)

/** A write: CSRF and an idempotency key, retried once on a stale session. */
const write = <T>(
  path: string,
  body: unknown,
  headers?: Record<string, string>,
) =>
  mutate((mutation) =>
    theoremJson<T>(path, {
      method: 'POST',
      body,
      headers: { ...mutation, ...headers },
    }),
  )

// ── Discovery and description ───────────────────────────────────────────────

/** The instances this caller may see. Nothing is listed that grants no read. */
export const discover = () => read<DiscoverResult>(`${CAPABILITIES}/instances`)

/** One instance: its pinned definition, this caller's own grant, and the resolved fields. */
export const describe = (instanceId: string) =>
  read<DescribeResult>(`${CAPABILITIES}/instances/${id(instanceId)}`)

// ── Authoring ───────────────────────────────────────────────────────────────

/** Declare the collection types, store the definition, bind a fresh instance. */
export const createInstance = (request: CreateInstanceRequest) =>
  write<AuthorResult>(`${CAPABILITIES}/instances`, request)

/**
 * Apply a patch to the pinned definition. `expectedDefinitionId` names the
 * version the patch was authored against; a stale one is refused as
 * `capability_definition_conflict`, never applied over what changed.
 */
export const author = (instanceId: string, patch: DefinitionPatch) =>
  write<AuthorResult>(
    `${CAPABILITIES}/instances/${id(instanceId)}/author`,
    patch,
  )

/** Re-pin an instance to an earlier definition version: views and actions, never records. */
export const repin = (instanceId: string, request: RepinRequest) =>
  write<AuthorResult>(
    `${CAPABILITIES}/instances/${id(instanceId)}/repin`,
    request,
  )

// ── Query ───────────────────────────────────────────────────────────────────

/**
 * One page of a view or an ad-hoc query. Sent as a POST like the work tracker's
 * items query, so the server's CSRF check covers it.
 */
export const query = (request: QueryRequest) =>
  write<QueryResult>(
    `${CAPABILITIES}/instances/${id(request.instanceId)}/query`,
    request,
  )

/** A page of a view, by key. */
export const queryView = (
  instanceId: string,
  viewKey: string,
  options: { cursor?: string; limit?: number } = {},
) => query({ instanceId, viewKey, ...options })

/** A page over one collection with no filter, for a module that names no view. */
export const queryCollection = (
  instanceId: string,
  collectionKey: string,
  options: { cursor?: string; limit?: number } = {},
) =>
  query({
    instanceId,
    query: { collectionKey, filter: matchAll() },
    ...options,
  })

/** The next cursor to ask for, or undefined when the page is the last one. */
const nextOf = (page: QueryResult, asked: string | undefined) => {
  const next = page.nextCursor
  // A server that echoes the cursor it was given would loop forever.
  return typeof next === 'string' && next !== asked ? next : undefined
}

/**
 * Every page of a query, in order, following `nextCursor` until the answer
 * names none. `maxPages` bounds how many pages are walked, so a module that
 * asks for a collection reads a bounded amount of it rather than all of it;
 * `from` starts the walk at a cursor an earlier walk stopped at. The walk
 * returns the cursor it did not follow when the bound cut it short, and
 * nothing when the answer ran out, so a caller can tell "not there" from "not
 * looked at yet".
 */
export async function* queryPages(
  request: Omit<QueryRequest, 'cursor'>,
  { maxPages = 20, from }: { maxPages?: number; from?: string } = {},
): AsyncGenerator<QueryResult, string | undefined> {
  let cursor = from
  for (let page = 0; page < maxPages; page++) {
    const result = await query({ ...request, ...(cursor ? { cursor } : {}) })
    yield result
    const next = nextOf(result, cursor)
    if (!next) return undefined
    cursor = next
  }
  return cursor
}

// ── Invocation ──────────────────────────────────────────────────────────────

/** A fresh idempotency key for one intended call. */
export const newInvocationKey = () => crypto.randomUUID()

/** What a caller asks of `invoke`: the key is optional, so a retry can reuse it. */
export type InvokeInput = Omit<InvokeRequest, 'invocationKey'> & {
  invocationKey?: string
}

/**
 * Run one declared action. The idempotency key is chosen here and rides twice:
 * as the body's `invocationKey` and as the `Idempotency-Key` header the route
 * maps to it. A retry that names the same key replays the stored receipt; a
 * retry after a lost session reuses the key the first attempt chose, so one
 * intended click is one invocation.
 */
export async function invoke(input: InvokeInput): Promise<InvocationReceipt> {
  const invocationKey = input.invocationKey ?? newInvocationKey()
  const request: InvokeRequest = { ...input, invocationKey }
  const path = `${CAPABILITIES}/instances/${id(request.instanceId)}/invoke`
  return mutate((headers) =>
    theoremJson<InvocationReceipt>(path, {
      method: 'POST',
      body: request,
      headers: { ...headers, 'Idempotency-Key': invocationKey },
    }),
  )
}

/** The stored receipt of one invocation, by its journal id. */
export const readReceipt = (
  instanceId: string,
  recordId: string,
): Promise<InvocationReceipt> =>
  read(
    `${CAPABILITIES}/instances/${id(instanceId)}/invocations/${id(recordId)}`,
  )

// ── One record ──────────────────────────────────────────────────────────────

/**
 * One record, read by id through the instance's own route. It answers under the
 * read grant and the collection's context policy, so a record this caller may
 * not see is refused as `capability_record_not_found` rather than drawn empty.
 */
export const readRecord = (
  instanceId: string,
  recordId: string,
): Promise<CapabilityRecordRow> =>
  read(`${CAPABILITIES}/instances/${id(instanceId)}/records/${id(recordId)}`)

/**
 * Where a bounded collection scan stopped, by collection key: the cursor of the
 * first page it did not read. A lookup resumed from it reads on from there.
 */
export type RecordScanResume = Record<string, string>

/**
 * What looking a record up answers: the row and the collection that holds it,
 * or the row with the collections the bounded scan has not finished, so the
 * module can say so and read on. A record that is not there answers undefined.
 */
export type RecordLookup =
  | { kind: 'found'; row: CapabilityRecordRow; collectionKey: string }
  | {
      kind: 'incomplete'
      row: CapabilityRecordRow
      resume: RecordScanResume
    }

/**
 * The record a detail module shows, with the collection that holds it.
 *
 * The record route names no collection in its answer, and a module needs one:
 * the resolved field schemas and the update actions are per collection. So the
 * row is read by id first, which settles whether it is there at all; a caller
 * that names a collection (or a definition with only one) is answered at once,
 * and one that names only a record id then finds which collection holds it by
 * walking the definition's collections, each bounded. A walk the bound cut
 * short is an incomplete lookup with where to resume, never "not there". A
 * record that is absent, or that its context policy withholds from this
 * caller, answers undefined: "not there" is an answer, not a failure. Locating
 * a record's collection without a scan is a recorded backend follow-up.
 */
export async function readRecordAnywhere(
  instanceId: string,
  definition: CapabilityDefinition,
  recordId: string,
  collectionKey?: string,
  resume?: RecordScanResume,
): Promise<RecordLookup | undefined> {
  let row: CapabilityRecordRow
  try {
    row = await readRecord(instanceId, recordId)
  } catch (error) {
    if (isRecordMissing(error)) return undefined
    throw error
  }
  if (collectionKey) return { kind: 'found', row, collectionKey }
  const only = definition.collections.length === 1
  if (only && !resume)
    return { kind: 'found', row, collectionKey: definition.collections[0]!.key }

  const cut: RecordScanResume = {}
  const scanned = resume
    ? definition.collections.filter((one) => Object.hasOwn(resume, one.key))
    : definition.collections
  for (const collection of scanned) {
    const pages = queryPages(
      {
        instanceId,
        query: { collectionKey: collection.key, filter: matchAll() },
      },
      { from: resume?.[collection.key] },
    )
    let step = await pages.next()
    while (!step.done) {
      if (step.value.records.some((record) => record.id === recordId))
        return { kind: 'found', row, collectionKey: collection.key }
      step = await pages.next()
    }
    if (step.value) cut[collection.key] = step.value
  }
  return Object.keys(cut).length
    ? { kind: 'incomplete', row, resume: cut }
    : undefined
}

// ── Refusals ────────────────────────────────────────────────────────────────

/** The problem code a refusal carries, when it carries one at all. */
export function refusalCode(error: unknown): string | undefined {
  const body =
    error !== null && typeof error === 'object' && 'body' in error
      ? (error as { body?: unknown }).body
      : undefined
  if (body === null || typeof body !== 'object') return undefined
  const code = (body as Record<string, unknown>).code
  return typeof code === 'string' ? code : undefined
}

/** A stale revision or a stale definition base: what is on screen moved on, so reload and retry. */
export const isReloadConflict = (error: unknown) => {
  const code = refusalCode(error)
  return code === codes.REVISION_CONFLICT || code === codes.DEFINITION_CONFLICT
}

/** The caller's grant does not reach this call. */
export const isPermissionDenial = (error: unknown) => {
  const code = refusalCode(error)
  return code === codes.GRANT_DENIED || code === codes.AUTHOR_DENIED
}

/** Whether the instance is not there (or never was permitted). */
export const isMissing = (error: unknown) =>
  refusalCode(error) === codes.NOT_FOUND

/**
 * Whether the record itself is not there: absent, or held back from this caller
 * by its collection's context policy. The contract folds both into one code, so
 * a module says "not here" and never infers a permission it cannot see.
 */
export const isRecordMissing = (error: unknown) =>
  refusalCode(error) === codes.RECORD_NOT_FOUND

/** One line for each state class, so a module says what is true and what comes next. */
export function refusalMessage(error: unknown, action: string): string {
  const code = refusalCode(error)
  switch (code) {
    case codes.REVISION_CONFLICT:
      return `${action} changed this record while you were looking at it. Nothing was lost: reload it and try again.`
    case codes.DEFINITION_CONFLICT:
      return 'The definition changed while you were editing it. Reload it, check your change against the current one, and try again.'
    case codes.GRANT_DENIED:
      return `You do not have permission to use this capability in that way.`
    case codes.AUTHOR_DENIED:
      return `You do not have permission to change this capability's definition.`
    case codes.NOT_FOUND:
      return `This capability instance is not there.`
    case codes.VIEW_UNKNOWN:
      return `This view is no longer part of the definition.`
    case codes.COLLECTION_UNKNOWN:
      return `This collection is no longer part of the definition.`
    case codes.ACTION_UNKNOWN:
      return `This action is no longer part of the definition.`
    case codes.INPUT_INVALID:
      return `The action refused its inputs.`
    case codes.PRECONDITION_FAILED:
      return `The action's preconditions do not hold for this record.`
    case codes.TRANSITION_DENIED:
      return `The collection's lifecycle does not allow that change.`
    case codes.RECORD_NOT_FOUND:
      return `That record is not here for you to read: it is gone from the collection, or its context policy withholds it from this caller.`
    case codes.KEY_REUSED:
      return `This invocation key was already used for a different call.`
    case codes.EFFECT_UNKNOWN:
      return `Whether the last attempt took effect is unknown. Read the record before trying again.`
    case codes.SCHEMA_CHANGE_UNSUPPORTED:
      return `That change to the schema is not supported: fields are added optional only in this slice.`
    case codes.DEFINITION_INVALID:
      return `The definition was refused as invalid.`
    case codes.INSTANCE_EXISTS:
      return `An instance with that id is already bound.`
  }
  const detail =
    error !== null && typeof error === 'object' && 'body' in error
      ? (error as { body?: unknown }).body
      : undefined
  const message =
    detail && typeof detail === 'object'
      ? ((detail as Record<string, unknown>).detail ??
        (detail as Record<string, unknown>).title)
      : undefined
  if (typeof message === 'string' && message.trim()) return message.trim()
  return `${action} could not be completed.`
}
