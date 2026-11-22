// SOURCING: lib/theorem/passthrough (theoremJson, the SDK's passthrough for routes its generated
// clients do not cover yet) with the shared CSRF and idempotency helper from lib/theorem/client, as
// components/work/api.ts uses them; every fetch of /api/capabilities/v1 is here, so SDK methods
// replace these callers when the SDK is regenerated. The routes and their bodies are the ones
// Theorem's capabilities_api pins (docs/plans/user-authored-capabilities/README.md).
import { mutate } from '@/lib/theorem/client'
import { theoremJson } from '@/lib/theorem/passthrough'
import { codes, matchAll, ruleCodes } from './contract'
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
  CapabilityModule,
  RegisterModuleRequest,
  RegisterModuleResult,
  RuleRun,
  RuleRunList,
  RuleRunListQuery,
  RunRuleRequest,
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
 * The record a detail module shows, with the collection that holds it.
 *
 * The record route names no collection in its answer, and a module needs one:
 * the resolved field schemas and the update actions are per collection. So a
 * caller that names a collection reads the record straight away; one that names
 * only a record id first finds which collection holds it by walking the
 * definition's collections, bounded, then reads the row from the record route —
 * which stays the one source of a row on both paths. A record that is absent, or
 * that its context policy withholds from this caller, answers undefined: "not
 * there" is an answer, not a failure. Locating a record's collection without a
 * scan is a recorded backend follow-up.
 */
export async function readRecordAnywhere(
  instanceId: string,
  definition: CapabilityDefinition,
  recordId: string,
  collectionKey?: string,
): Promise<{ row: CapabilityRecordRow; collectionKey: string } | undefined> {
  /** The row by id, or undefined when the instance says it is not there. */
  const byId = async () => {
    try {
      return await readRecord(instanceId, recordId)
    } catch (error) {
      if (isRecordMissing(error)) return undefined
      throw error
    }
  }

  if (collectionKey) {
    const row = await byId()
    return row ? { row, collectionKey } : undefined
  }

  for (const collection of definition.collections) {
    for await (const page of queryPages({
      instanceId,
      query: { collectionKey: collection.key, filter: matchAll() },
    })) {
      if (!page.records.some((record) => record.id === recordId)) continue
      const row = await byId()
      return row ? { row, collectionKey: collection.key } : undefined
    }
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

// ── slice 2: rules, runs, modules ───────────────────────────────────────────

/** One page of an instance's rule runs, newest first, optionally for one rule. */
export function listRuns(
  instanceId: string,
  { ruleKey, cursor, limit }: RuleRunListQuery = {},
): Promise<RuleRunList> {
  const search = new URLSearchParams()
  if (ruleKey) search.set('ruleKey', ruleKey)
  if (cursor) search.set('cursor', cursor)
  if (limit !== undefined) search.set('limit', String(limit))
  const suffix = search.size ? `?${search}` : ''
  return read(`${CAPABILITIES}/instances/${id(instanceId)}/runs${suffix}`)
}

/** One run, with its attempts. */
export const readRun = (instanceId: string, runId: string): Promise<RuleRun> =>
  read(`${CAPABILITIES}/instances/${id(instanceId)}/runs/${id(runId)}`)

/**
 * Queue a schedule rule now. The key rides as the `Idempotency-Key` header and
 * the body stays empty, so the route adopts the header as the manual run's key:
 * one click, after a lost session too, is one run.
 */
export function runRuleNow(
  instanceId: string,
  ruleKey: string,
  { invocationKey = newInvocationKey() }: { invocationKey?: string } = {},
): Promise<RuleRun> {
  const body: RunRuleRequest = {}
  return write<RuleRun>(
    `${CAPABILITIES}/instances/${id(instanceId)}/rules/${id(ruleKey)}/run`,
    body,
    { 'Idempotency-Key': invocationKey },
  )
}

/** Retry a failed or dead run whose last attempt finished failed. */
export const retryRun = (instanceId: string, runId: string) =>
  write<RuleRun>(
    `${CAPABILITIES}/instances/${id(instanceId)}/runs/${id(runId)}/retry`,
    {},
  )

/** Put a WASM module in the library; the answer names it by content (`capmod:`). */
export const registerModule = (request: RegisterModuleRequest) =>
  write<RegisterModuleResult>(`${CAPABILITIES}/library/modules`, request)

export const readModule = (moduleId: string): Promise<CapabilityModule> =>
  read(`${CAPABILITIES}/library/modules/${id(moduleId)}`)

/** `refusalMessage`, knowing the slice-2 codes too. */
export function ruleRefusalMessage(error: unknown, action: string): string {
  switch (refusalCode(error)) {
    case ruleCodes.MODULE_NOT_FOUND:
      return 'That module is not in the library.'
    case ruleCodes.MODULE_FAILED:
      return 'The module behind this action failed. Nothing was written.'
    case ruleCodes.RULE_UNKNOWN:
      return 'This rule is no longer part of the definition.'
    case ruleCodes.RULE_LOOP:
      return 'Skipped: this rule is already part of the chain that started it, or the chain is too deep.'
    case ruleCodes.BACKGROUND_DENIED:
      return 'Your grant does not let rules run in the background as you.'
    case ruleCodes.RUN_NOT_FOUND:
      return 'That run is not here.'
    case ruleCodes.RUN_NOT_RETRYABLE:
      return 'Only a run whose last attempt failed can be retried.'
  }
  return refusalMessage(error, action)
}
