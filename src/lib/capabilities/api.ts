// SOURCING: lib/theorem/passthrough (theoremJson, the SDK's passthrough for routes its generated
// clients do not cover yet) with the shared CSRF and idempotency helper from lib/theorem/client, as
// components/work/api.ts uses them; every fetch of /api/capabilities/v1 is here, so SDK methods
// replace these callers when the SDK is regenerated. The routes and their bodies are the ones
// Theorem's capabilities_api pins (docs/plans/user-authored-capabilities/README.md).
import { mutate } from '@/lib/theorem/client'
import { theoremJson } from '@/lib/theorem/passthrough'
import { codes, matchAll, QUERY_LIMIT_DEFAULT } from './contract'
import type {
  AuthorResult,
  CapabilityDefinition,
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
 * names none. `limit` bounds how many pages are walked, so a module that asks
 * for a collection reads a bounded amount of it rather than all of it.
 */
export async function* queryPages(
  request: Omit<QueryRequest, 'cursor'>,
  { maxPages = 20 }: { maxPages?: number } = {},
): AsyncGenerator<QueryResult> {
  let cursor: string | undefined
  for (let page = 0; page < maxPages; page++) {
    const result = await query({ ...request, cursor })
    yield result
    const next = nextOf(result, cursor)
    if (!next) return
    cursor = next
  }
}

/**
 * The rows a query answers, walked through its cursors, with what only the
 * first page carries. Stops at `maxRows` so a caller that wants a handful of
 * rows never reads a whole collection.
 */
export async function queryRows(
  request: Omit<QueryRequest, 'cursor' | 'limit'>,
  {
    maxRows = 1_000,
    limit = QUERY_LIMIT_DEFAULT,
  }: { maxRows?: number; limit?: number } = {},
) {
  const rows: QueryResult['records'] = []
  let first: QueryResult | undefined
  for await (const page of queryPages({ ...request, limit })) {
    first ??= page
    rows.push(...page.records)
    if (rows.length >= maxRows) break
  }
  return { rows, first }
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
 * The contract has no route that reads one record by id: a record is named by
 * its row in a query. So a module showing one record walks its collection's
 * pages until the row turns up, bounded by `maxPages`, and says when it did not.
 * An indexed lookup by id is a recorded backend follow-up.
 */
export async function readRecord(
  instanceId: string,
  collectionKey: string,
  recordId: string,
  { maxPages = 20 }: { maxPages?: number } = {},
) {
  for await (const page of queryPages(
    { instanceId, query: { collectionKey, filter: matchAll() } },
    { maxPages },
  )) {
    const row = page.records.find((candidate) => candidate.id === recordId)
    if (row) return { row, filtered: page.filtered, truncated: page.truncated }
  }
  return undefined
}

/**
 * The record a detail module shows, found across the definition's collections.
 * Without a named collection they are walked in definition order, so a bound
 * selection that carries its collection key costs one walk.
 */
export async function readRecordAnywhere(
  instanceId: string,
  definition: CapabilityDefinition,
  recordId: string,
  collectionKey?: string,
) {
  const keys = collectionKey
    ? [collectionKey]
    : definition.collections.map((collection) => collection.key)
  for (const key of keys) {
    const found = await readRecord(instanceId, key, recordId)
    if (found) return { ...found, collectionKey: key }
  }
  return undefined
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
      return `That record is no longer in the collection.`
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
