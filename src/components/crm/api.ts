// SOURCING: lib/theorem/graphql (Theorem's /graphql through the SDK's fetch passthrough) and the CSRF/idempotency helper from lib/theorem/client, as components/records/api.ts uses them; the record shape is the schema register's `node_json` ({ id, labels, properties, version }) and its `revision_conflict` / `principal_scope_missing` refusals
//
// The CRM reads and writes through the register's record verbs because they
// return a record's saved revision. Every update and delete names the
// revision it read, so a record that moved on is refused, never overwritten.
import { mutate } from '@/lib/theorem/client'
import { GraphQLRequestError, graphql as post } from '@/lib/theorem/graphql'
import type { RecordRow } from '@/components/records/contract'
import { decodeOrigin } from './proposal'
import type { ChangeOrigin } from './proposal'

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const text = (value: unknown) =>
  typeof value === 'string' && value ? value : undefined

/** A value the server may spell in camelCase or snake_case. */
const either = (raw: Record<string, unknown>, camel: string, snake: string) =>
  raw[camel] ?? raw[snake]

// Records

/** A record as the CRM holds it: the table's row, plus the saved revision. */
export type CrmRecord = RecordRow & {
  /** The saved revision; an update or delete must name it. */
  version: number
  labels: string[]
}

export type CrmRecordPage = {
  records: CrmRecord[]
  /** Every record of the type, not only the ones this page carries. */
  count: number
}

/** `{ id, labels, properties, version }`; anything else is not a record. */
export function decodeCrmRecord(raw: unknown): CrmRecord | undefined {
  if (!isObject(raw) || typeof raw.id !== 'string') return undefined
  const version = Number(raw.version)
  if (!Number.isFinite(version)) return undefined
  return {
    id: raw.id,
    values: isObject(raw.properties) ? raw.properties : {},
    // Relation fields hold the related ids in `properties`; nothing is hydrated.
    relations: {},
    version,
    labels: Array.isArray(raw.labels)
      ? raw.labels.filter((label): label is string => typeof label === 'string')
      : [],
  }
}

/** `{ record }`, or the record on its own. */
export function decodeRecordEnvelope(raw: unknown): CrmRecord | undefined {
  if (!isObject(raw)) return undefined
  return decodeCrmRecord(raw.record) ?? decodeCrmRecord(raw)
}

export function decodeRecordPage(raw: unknown): CrmRecordPage {
  const envelope = isObject(raw) ? raw : {}
  const records = (Array.isArray(envelope.records) ? envelope.records : [])
    .map(decodeCrmRecord)
    .filter((record): record is CrmRecord => record !== undefined)
  const count = Number(envelope.count)
  return {
    records,
    count: Number.isFinite(count)
      ? Math.max(count, records.length)
      : records.length,
  }
}

// Refusals

export type CrmVerb =
  'find_many' | 'find_one' | 'create_one' | 'update_one' | 'delete_one'

const WRITES: ReadonlySet<CrmVerb> = new Set([
  'create_one',
  'update_one',
  'delete_one',
])

/** The record moved on after it was read; the write was refused, nothing was lost. */
export class RevisionConflictError extends Error {
  readonly recordId: string
  readonly expectedRevision: number | undefined
  /** The revision the record is at now, when the refusal says. */
  readonly currentRevision: number | undefined
  constructor(
    recordId: string,
    expectedRevision: number | undefined,
    currentRevision: number | undefined,
    cause?: unknown,
  ) {
    super('This record changed since it was opened.', { cause })
    this.name = 'RevisionConflictError'
    this.recordId = recordId
    this.expectedRevision = expectedRevision
    this.currentRevision = currentRevision
  }
}

/** This sign-in may not read, or may not change, records of a type. */
export class RecordAccessError extends Error {
  readonly objectTypeId: string
  readonly action: 'read' | 'write'
  constructor(objectTypeId: string, action: 'read' | 'write', cause?: unknown) {
    super(
      action === 'write'
        ? 'This sign-in cannot change these records.'
        : 'These records are not available to this sign-in.',
      { cause },
    )
    this.name = 'RecordAccessError'
    this.objectTypeId = objectTypeId
    this.action = action
  }
}

/** The record is gone, or was never of this type. */
export class RecordMissingError extends Error {
  readonly recordId: string
  constructor(recordId: string, cause?: unknown) {
    super('This record is not in Theorem any more.', { cause })
    this.name = 'RecordMissingError'
    this.recordId = recordId
  }
}

const ACCESS =
  /principal_scope_missing|missing required principal scopes|write_denied|principal_tenant_missing/

/**
 * A record verb's GraphQL refusal as the error the surface can act on. What
 * it does not recognize it returns unchanged, so nothing is hidden.
 */
export function mapRecordError(
  error: unknown,
  at: {
    objectTypeId: string
    verb: CrmVerb
    recordId?: string
    expectedRevision?: number
  },
): unknown {
  if (!(error instanceof GraphQLRequestError)) return error
  const message = error.message
  if (message.includes('revision_conflict')) {
    const current = /is at revision (\d+)/.exec(message)?.[1]
    return new RevisionConflictError(
      at.recordId ?? '',
      at.expectedRevision,
      current === undefined ? undefined : Number(current),
      error,
    )
  }
  if (ACCESS.test(message))
    return new RecordAccessError(
      at.objectTypeId,
      WRITES.has(at.verb) ? 'write' : 'read',
      error,
    )
  if (message.includes('record_not_found') && at.recordId)
    return new RecordMissingError(at.recordId, error)
  return error
}

// Transport

const query = <T>(document: string, variables: Record<string, unknown> = {}) =>
  post<T>(document, variables)

/** Writes carry CSRF and an idempotency key, retried once on a stale session. */
const write = <T>(document: string, variables: Record<string, unknown>) =>
  mutate((headers) => post<T>(document, variables, headers))

const RECORD_VERB = `mutation RecordVerb($objectTypeId: String!, $verb: String!, $input: JSON!) {
  invokeRecordVerb(objectTypeId: $objectTypeId, verb: $verb, input: $input)
}`

async function invoke(
  objectTypeId: string,
  verb: CrmVerb,
  input: Record<string, unknown>,
  at: { recordId?: string; expectedRevision?: number } = {},
) {
  try {
    const data = await write<{ invokeRecordVerb: unknown }>(RECORD_VERB, {
      objectTypeId,
      verb,
      input,
    })
    return data.invokeRecordVerb
  } catch (error) {
    throw mapRecordError(error, { objectTypeId, verb, ...at })
  }
}

/** The register serves at most this many records to one read. */
export const PAGE_LIMIT = 1000

async function findRecordPage(objectTypeId: string, offset: number) {
  return decodeRecordPage(
    await invoke(objectTypeId, 'find_many', { limit: PAGE_LIMIT, offset }),
  )
}

/**
 * Every record of a type. The register serves one page to a read, so pages
 * are read until the count it reports is in hand; a type with more records
 * than one page holds is not cut off at the first.
 */
export async function findRecords(objectTypeId: string) {
  const first = await findRecordPage(objectTypeId, 0)
  const byId = new Map(first.records.map((record) => [record.id, record]))
  let count = first.count
  let read = first.records.length
  while (read < count) {
    const next = await findRecordPage(objectTypeId, read)
    if (!next.records.length) break
    // A record written between two reads can appear in both.
    for (const record of next.records) byId.set(record.id, record)
    read += next.records.length
    count = next.count
  }
  const records = [...byId.values()]
  return { records, count: Math.max(count, records.length) }
}

/** The most records one search of a type returns. */
export const SEARCH_LIMIT = 20

/**
 * The spellings of `phrase` a case-sensitive `contains` should try: as typed,
 * and, from both the typed and the lowercased phrase, with each word
 * capitalised and with only the first letter capitalised, plus the phrase
 * all in lowercase. So `NOOR`, `noor` and `Noor` all find a record titled
 * Noor. A title cased unusually inside a word (McAllister typed as
 * mcallister) can still be missed: the register's filter has no case-blind
 * operator.
 */
export function searchSpellings(phrase: string) {
  const typed = phrase.trim()
  const capitalise = (word: string) =>
    word.charAt(0).toUpperCase() + word.slice(1)
  const variants = (spelling: string) => [
    spelling.split(/\s+/u).map(capitalise).join(' '),
    capitalise(spelling),
  ]
  const lower = typed.toLowerCase()
  return [...new Set([typed, ...variants(typed), lower, ...variants(lower)])]
}

/**
 * A bounded look for records of a type by title, for a list that offers a few
 * matches: never more than `limit` records per read, however many the type
 * has. The register has no text search, only an exact-case `contains` filter
 * on one field and no `or`, so each spelling of the query is one filtered
 * read, and an empty query is one unfiltered page. Records come back once
 * each; a title that differs in case from every spelling is not found.
 * Every spelling is one read, so a query makes at most six.
 */
export async function searchRecords(
  objectTypeId: string,
  titleField: string | undefined,
  phrase: string,
  limit = SEARCH_LIMIT,
): Promise<CrmRecord[]> {
  const typed = phrase.trim()
  const inputs =
    typed && titleField
      ? searchSpellings(typed).map((value) => ({
          limit,
          filters: [{ field_key: titleField, operator: 'contains', value }],
        }))
      : [{ limit }]
  const pages = await Promise.all(
    inputs.map(async (input) =>
      decodeRecordPage(await invoke(objectTypeId, 'find_many', input)),
    ),
  )
  const byId = new Map<string, CrmRecord>()
  for (const page of pages)
    for (const record of page.records) byId.set(record.id, record)
  return [...byId.values()]
}

/** One record at its saved revision; a record that is gone is a RecordMissingError. */
export async function findRecord(objectTypeId: string, id: string) {
  const record = decodeRecordEnvelope(
    await invoke(objectTypeId, 'find_one', { id }, { recordId: id }),
  )
  if (!record) throw new RecordMissingError(id)
  return record
}

export async function createCrmRecord(
  objectTypeId: string,
  values: Record<string, unknown>,
) {
  const record = decodeRecordEnvelope(
    await invoke(objectTypeId, 'create_one', values),
  )
  if (!record)
    throw new Error('Theorem created the record but did not return it.')
  return record
}

/**
 * Change fields of a record read at `expectedRevision`. The record comes back
 * at its new revision; a record that moved on is a RevisionConflictError.
 */
export async function updateCrmRecord(
  objectTypeId: string,
  id: string,
  patch: Record<string, unknown>,
  expectedRevision: number,
) {
  const record = decodeRecordEnvelope(
    await invoke(
      objectTypeId,
      'update_one',
      { ...patch, id, expected_revision: expectedRevision },
      { recordId: id, expectedRevision },
    ),
  )
  if (!record)
    throw new Error('Theorem saved the change but did not return the record.')
  return record
}

export async function deleteCrmRecord(
  objectTypeId: string,
  id: string,
  expectedRevision: number,
) {
  await invoke(
    objectTypeId,
    'delete_one',
    { id, expected_revision: expectedRevision },
    { recordId: id, expectedRevision },
  )
}

// Life context: the built-in types, who "me" is, and what this sign-in may do

export type SelfBinding =
  | { state: 'bound'; personRecordId: string; updatedAt?: number | string }
  | { state: 'unbound' }
  /** The sign-in names a workspace but no person, so nobody can be "me". */
  | { state: 'unavailable'; reason?: string }

export type TypeAccess = {
  objectTypeId: string
  read: boolean
  write: boolean
  writeScope: string
}

export type LifeContext = {
  /** Whether every built-in type is declared here. */
  installed: boolean
  /** Whether any built-in type is declared here. */
  started: boolean
  /** The built-in types this workspace does not have yet, by name. */
  missing: string[]
  /**
   * Built-in types this workspace installed before fields were added to
   * them, with the fields each lacks. Installing again adds them.
   */
  outdated: { nameSingular: string; missingFields: string[] }[]
  types: { nameSingular: string; declared: boolean; missingFields: string[] }[]
  self: SelfBinding
  access: TypeAccess[]
  /** The name this sign-in's own writes carry in a record's history. */
  actor: string | null
}

function decodeSelf(raw: unknown): SelfBinding {
  if (!isObject(raw)) return { state: 'unbound' }
  const personRecordId = text(either(raw, 'personRecordId', 'person_record_id'))
  if (raw.state === 'bound' && personRecordId) {
    const updatedAt = either(raw, 'updatedAt', 'updated_at')
    return {
      state: 'bound',
      personRecordId,
      updatedAt:
        typeof updatedAt === 'number' || typeof updatedAt === 'string'
          ? updatedAt
          : undefined,
    }
  }
  if (raw.state === 'unavailable')
    return { state: 'unavailable', reason: text(raw.reason) }
  return { state: 'unbound' }
}

/** Reads what the server answered, and nothing it did not: a missing flag is false. */
export function decodeLifeContext(raw: unknown): LifeContext {
  const value = isObject(raw) ? raw : {}
  const types = (Array.isArray(value.types) ? value.types : []).flatMap(
    (type) => {
      if (!isObject(type)) return []
      const nameSingular = text(either(type, 'nameSingular', 'name_singular'))
      const fields = either(type, 'missingFields', 'missing_fields')
      const missingFields = Array.isArray(fields)
        ? fields.filter((key): key is string => typeof key === 'string')
        : []
      return nameSingular
        ? [{ nameSingular, declared: type.declared === true, missingFields }]
        : []
    },
  )
  return {
    installed: value.installed === true,
    started: value.installed === true || types.some((type) => type.declared),
    missing: types
      .filter((type) => !type.declared)
      .map((type) => type.nameSingular),
    outdated: types
      .filter((type) => type.declared && type.missingFields.length > 0)
      .map(({ nameSingular, missingFields }) => ({
        nameSingular,
        missingFields,
      })),
    types,
    self: decodeSelf(value.self),
    actor: text(value.actor) ?? null,
    access: (Array.isArray(value.access) ? value.access : []).flatMap(
      (entry) => {
        if (!isObject(entry)) return []
        const objectTypeId = text(
          either(entry, 'objectTypeId', 'object_type_id'),
        )
        return objectTypeId
          ? [
              {
                objectTypeId,
                read: entry.read === true,
                write: entry.write === true,
                writeScope:
                  text(either(entry, 'writeScope', 'write_scope')) ?? '',
              },
            ]
          : []
      },
    ),
  }
}

export async function readLifeContext() {
  const data = await query<{ lifeContext: unknown }>(
    `query LifeContext { lifeContext }`,
  )
  return decodeLifeContext(data.lifeContext)
}

/** Declares Organization, Person, Activity, Commitment, Interaction, Goal and Constraint. */
export async function installLifeContextTypes() {
  const data = await write<{ installLifeContextTypes: unknown }>(
    `mutation InstallLifeContextTypes { installLifeContextTypes }`,
    {},
  )
  return decodeLifeContext(data.installLifeContextTypes)
}

export type SelfBindingRefusal =
  | 'self_binding_requires_verified_user'
  | 'person_type_missing'
  | 'record_not_found'

const SELF_REFUSALS: SelfBindingRefusal[] = [
  'self_binding_requires_verified_user',
  'person_type_missing',
  'record_not_found',
]

/** "This is me" was refused, and why. */
export class SelfBindingError extends Error {
  readonly code: SelfBindingRefusal
  constructor(code: SelfBindingRefusal, cause?: unknown) {
    super(
      code === 'self_binding_requires_verified_user'
        ? 'This sign-in names a workspace but not a person, so no record can be marked as you.'
        : code === 'person_type_missing'
          ? 'People are not set up in this workspace yet.'
          : 'This person is not in Theorem any more.',
      { cause },
    )
    this.name = 'SelfBindingError'
    this.code = code
  }
}

export function mapSelfBindingError(error: unknown): unknown {
  if (!(error instanceof GraphQLRequestError)) return error
  const code = SELF_REFUSALS.find((refusal) =>
    error.errors.some((entry) => entry.message.includes(refusal)),
  )
  return code ? new SelfBindingError(code, error) : error
}

export async function bindSelfPerson(recordId: string) {
  try {
    const data = await write<{ bindSelfPerson: unknown }>(
      `mutation BindSelfPerson($id: String!) { bindSelfPerson(recordId: $id) }`,
      { id: recordId },
    )
    return decodeLifeContext(data.bindSelfPerson)
  } catch (error) {
    throw mapSelfBindingError(error)
  }
}

// Changes

export type RecordChange = {
  id: string
  recordId: string
  objectTypeId: string
  kind: 'created' | 'updated' | 'deleted'
  /** The revision the change was made against; none for a record's first. */
  previousRevision: number | null
  /**
   * The revision the change left the record at, as the server read it back.
   * Revisions are the store's own counter, so this is not the last one plus
   * one. None for a delete, or where the server does not say.
   */
  revision: number | null
  changed: Record<string, { from: unknown; to: unknown }>
  actor: string | null
  atMs: number
  /** Where the change came from, when the server says: a proposal the person approved. */
  origin?: ChangeOrigin
}

export function decodeRecordChange(raw: unknown): RecordChange | undefined {
  if (!isObject(raw)) return undefined
  const id = text(raw.id)
  const recordId = text(either(raw, 'recordId', 'record_id'))
  const kind = raw.kind
  if (!id || !recordId) return undefined
  if (kind !== 'created' && kind !== 'updated' && kind !== 'deleted')
    return undefined
  const previous = either(raw, 'previousRevision', 'previous_revision')
  const whole = (value: unknown) =>
    typeof value === 'number' && Number.isFinite(value) ? value : null
  const changed: RecordChange['changed'] = {}
  if (isObject(raw.changed))
    for (const [key, change] of Object.entries(raw.changed))
      if (isObject(change)) changed[key] = { from: change.from, to: change.to }
  const at = Number(either(raw, 'atMs', 'at_ms'))
  const origin = decodeOrigin(raw.origin)
  return {
    id,
    recordId,
    objectTypeId: text(either(raw, 'objectTypeId', 'object_type_id')) ?? '',
    kind,
    previousRevision: whole(previous),
    revision: whole(raw.revision),
    changed,
    actor: text(raw.actor) ?? null,
    atMs: Number.isFinite(at) ? at : 0,
    ...(origin ? { origin } : {}),
  }
}

/** A record's saved changes, newest first. */
export async function readRecordChanges(recordId: string, limit = 100) {
  const data = await query<{ recordChanges: unknown }>(
    `query RecordChanges($id: String!, $limit: Int) { recordChanges(recordId: $id, limit: $limit) }`,
    { id: recordId, limit },
  )
  const envelope = isObject(data.recordChanges) ? data.recordChanges : {}
  return (Array.isArray(envelope.changes) ? envelope.changes : [])
    .map(decodeRecordChange)
    .filter((change): change is RecordChange => change !== undefined)
}
