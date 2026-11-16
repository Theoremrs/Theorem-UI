// SOURCING: none — pure lookups over the schema register's types (components/records/contract and model) and the CRM's own shapes (./api): the navigator's order, a type's place in the URL, what a sign-in may do, the assistant-context policy in a type's `extensions`, and a saved change in plain words
import type {
  DataModel,
  FieldSpec,
  ObjectType,
} from '@/components/records/contract'
import {
  fieldByKey,
  isEmptyValue,
  recordTitle,
  resolveObjectType,
} from '@/components/records/model'
import {
  RecordAccessError,
  RecordMissingError,
  RevisionConflictError,
} from './api'
import type { CrmRecord, LifeContext, RecordChange, TypeAccess } from './api'

/** The built-in types, in the navigator's order. */
export const BUILT_IN = [
  'person',
  'organization',
  'activity',
  'commitment',
  'interaction',
  'goal',
  'constraint',
] as const

export type BuiltIn = (typeof BUILT_IN)[number]

const builtInRank = (type: ObjectType) =>
  BUILT_IN.indexOf(type.name_singular.toLowerCase() as BuiltIn)

export const builtInName = (type: ObjectType): BuiltIn | undefined =>
  BUILT_IN[builtInRank(type)]

/**
 * The types the CRM lists: the built-in ones first, in their order, then
 * every other declared type by label. Retired types stay out, and so do the
 * register's own system types unless they are built-in.
 */
export function crmTypes(model: DataModel | undefined): ObjectType[] {
  const types = (model?.objectTypes ?? []).filter(
    (type) => !type.retired && (builtInRank(type) >= 0 || !type.system),
  )
  return types.sort((a, b) => {
    const [ra, rb] = [builtInRank(a), builtInRank(b)]
    if (ra >= 0 || rb >= 0)
      return (ra < 0 ? BUILT_IN.length : ra) - (rb < 0 ? BUILT_IN.length : rb)
    return a.label_plural.localeCompare(b.label_plural)
  })
}

/** A type's place in the URL: its plural name, lowercased (`/crm/people`). */
export const typeSlug = (type: ObjectType) =>
  encodeURIComponent(type.name_plural.toLowerCase())

export function typeBySlug(types: ObjectType[], slug: string | undefined) {
  if (!slug) return undefined
  const wanted = decodeURIComponent(slug).toLowerCase()
  return (
    types.find((type) => type.name_plural.toLowerCase() === wanted) ??
    types.find((type) => type.name_singular.toLowerCase() === wanted)
  )
}

export const personType = (types: ObjectType[]) =>
  types.find((type) => type.name_singular.toLowerCase() === 'person')

/** A manifest names a type by its singular name; find the declared one. */
export const typeByName = (types: ObjectType[], name: string | undefined) =>
  name
    ? types.find(
        (type) =>
          type.name_singular.toLowerCase() === name.toLowerCase() ||
          type.object_type_id === name,
      )
    : undefined

// Access

const OPEN: Omit<TypeAccess, 'objectTypeId'> = {
  read: true,
  write: true,
  writeScope: '',
}

/**
 * What this sign-in may do with a type's records. A type the server did not
 * report on is tried, and the server's answer is shown if it refuses.
 */
export function accessFor(
  life: LifeContext | undefined,
  type: ObjectType | undefined,
): Omit<TypeAccess, 'objectTypeId'> {
  if (!type) return OPEN
  return (
    life?.access.find((entry) => entry.objectTypeId === type.object_type_id) ??
    OPEN
  )
}

/** A refusal in the words the person reads, without the server's vocabulary. */
export function describeCrmError(
  error: unknown,
  type: ObjectType | undefined,
  fallback: (error: unknown) => string,
): string {
  const plural = type?.label_plural ?? 'these records'
  if (error instanceof RevisionConflictError)
    return `This ${type?.label_singular.toLowerCase() ?? 'record'} changed since you opened it.`
  if (error instanceof RecordAccessError)
    return error.action === 'write'
      ? `This sign-in can read ${plural} but not change them.`
      : `${type ? plural : 'These records'} are not available to this sign-in.`
  if (error instanceof RecordMissingError)
    return `This ${type?.label_singular.toLowerCase() ?? 'record'} is not in Theorem any more.`
  return fallback(error)
}

// Private to me

/** Every built-in type carries it: `available`, or `private` to keep the record from the assistant. */
export const CONTEXT_USE_FIELD = 'context_use'

export const isPrivate = (record: CrmRecord | undefined) =>
  record?.values[CONTEXT_USE_FIELD] === 'private'

export const hasContextUse = (type: ObjectType) =>
  fieldByKey(type, CONTEXT_USE_FIELD) !== undefined

// Assistant-context policy

export const CONTEXT_EXTENSION = 'theorem.context'

export type ContextPolicy = {
  version: 1
  assistance: 'available' | 'excluded'
  excluded_fields?: string[]
  mention_fields?: string[]
  standing?: boolean
}

const strings = (value: unknown) =>
  Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : undefined

/** A type's policy; one that declares none is available to the assistant. */
export function contextPolicy(type: Pick<ObjectType, 'extensions'>): ContextPolicy {
  const raw = type.extensions?.[CONTEXT_EXTENSION]
  const value =
    raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  return {
    version: 1,
    assistance: value.assistance === 'excluded' ? 'excluded' : 'available',
    excluded_fields: strings(value.excluded_fields),
    mention_fields: strings(value.mention_fields),
    standing: value.standing === true ? true : undefined,
  }
}

// Fields and titles

/** The fields a table or a property list shows: all but the private switch, which has its own control. */
export const shownFields = (type: ObjectType) =>
  type.fields.filter((field) => field.key !== CONTEXT_USE_FIELD)

export const sameValue = (a: unknown, b: unknown) =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

/** Related record ids a relation field holds: one id, or a list of them. */
export function relatedIds(record: CrmRecord, field: FieldSpec): string[] {
  const value = record.values[field.key]
  if (typeof value === 'string' && value) return [value]
  if (Array.isArray(value))
    return value.filter((id): id is string => typeof id === 'string' && !!id)
  return []
}

export const relationTarget = (
  model: DataModel | undefined,
  field: FieldSpec,
) =>
  field.field_type.kind === 'relation'
    ? resolveObjectType(model, field.field_type.target_object_type_id)
    : undefined

/** Initials for an avatar: the first letters of the first two words. */
export function initials(name: string) {
  const words = name.trim().split(/\s+/).filter(Boolean)
  return words
    .slice(0, 2)
    .map((word) => word.charAt(0).toUpperCase())
    .join('')
}

// Changes in plain words

const DAY = new Intl.DateTimeFormat('en-US', {
  weekday: 'long',
  month: 'short',
  day: 'numeric',
})

/** A date-only string reads in its own day, wherever the reader is. */
function formatDay(value: unknown) {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined
  const dateOnly =
    typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  const date = new Date(dateOnly ? `${value}T12:00:00` : value)
  return Number.isNaN(date.getTime()) ? undefined : DAY.format(date)
}

/** A changed value as a few words: never a blank where a value was cleared. */
export function changeValue(
  field: FieldSpec | undefined,
  value: unknown,
  titleOf: (field: FieldSpec, id: string) => string,
): string {
  if (isEmptyValue(value)) return 'nothing'
  const kind = field?.field_type.kind
  if (field && kind === 'relation') {
    const ids = Array.isArray(value) ? value : [value]
    return ids.map((id) => titleOf(field, String(id))).join(', ')
  }
  if (kind === 'date' || kind === 'timestamp')
    return formatDay(value) ?? String(value)
  if (kind === 'boolean') return value === true ? 'yes' : 'no'
  if (Array.isArray(value)) return value.map(String).join(', ')
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

/** `user:avery` reads "Avery"; a change nobody is named on reads "Someone". */
export function actorName(actor: string | null) {
  if (!actor) return 'Someone'
  const name = actor.includes(':') ? actor.slice(actor.indexOf(':') + 1) : actor
  return name ? name.charAt(0).toUpperCase() + name.slice(1) : 'Someone'
}

/** The revision a change left the record at. */
export const revisionAfter = (change: RecordChange) =>
  change.previousRevision === null ? null : change.previousRevision + 1

export type ChangeLine = { fieldKey: string; text: string }

/**
 * One sentence per changed field: "Avery changed Due from Wednesday, Nov 18
 * to Friday, Nov 20". The private switch reads as what it means.
 */
export function changeLines(
  change: RecordChange,
  type: ObjectType | undefined,
  titleOf: (field: FieldSpec, id: string) => string,
): ChangeLine[] {
  const who = actorName(change.actor)
  return Object.entries(change.changed).map(([key, { from, to }]) => {
    if (key === CONTEXT_USE_FIELD)
      return {
        fieldKey: key,
        text:
          to === 'private'
            ? `${who} made this private`
            : `${who} made this available to Theorem`,
      }
    const field = type ? fieldByKey(type, key) : undefined
    const label = field?.label ?? key
    const [before, after] = [
      changeValue(field, from, titleOf),
      changeValue(field, to, titleOf),
    ]
    return {
      fieldKey: key,
      text: isEmptyValue(from)
        ? `${who} set ${label} to ${after}`
        : isEmptyValue(to)
          ? `${who} cleared ${label} (was ${before})`
          : `${who} changed ${label} from ${before} to ${after}`,
    }
  })
}

/** "revision 6 → 7", or nothing when the change does not say. */
export function revisionStep(change: RecordChange) {
  const after = revisionAfter(change)
  if (change.kind === 'created') return after === null ? 'revision 1' : `revision ${after}`
  return after === null ? undefined : `revision ${change.previousRevision} → ${after}`
}

/** A record's title under its type, for labels and sentences. */
export const titleOfRecord = (
  type: ObjectType,
  record: CrmRecord | undefined,
) => recordTitle(type, record)

// Relations pointing here

export type RelatedGroup = {
  /** The type the related records are of. */
  type: ObjectType
  /** The relation field, and which side holds it. */
  field: FieldSpec
  direction: 'from' | 'to'
  /** A related record that has not loaded is still named by its id. */
  entries: { id: string; record?: CrmRecord }[]
}

/**
 * A record's relations, grouped: what its own relation fields point at
 * (`from`), and the records of other types whose fields point at it (`to`).
 * `recordsOf` gives a type's loaded records; a type still loading gives none.
 */
export function relatedGroups(
  model: DataModel | undefined,
  type: ObjectType,
  record: CrmRecord,
  recordsOf: (type: ObjectType) => CrmRecord[],
): RelatedGroup[] {
  const groups: RelatedGroup[] = []
  for (const field of type.fields) {
    const target = relationTarget(model, field)
    if (!target) continue
    const ids = new Set(relatedIds(record, field))
    if (!ids.size) continue
    const loaded = new Map(recordsOf(target).map((r) => [r.id, r]))
    groups.push({
      type: target,
      field,
      direction: 'from',
      entries: [...ids].map((id) => ({ id, record: loaded.get(id) })),
    })
  }
  const refs = new Set([
    type.object_type_id,
    type.node_label,
    type.name_singular,
  ])
  for (const from of crmTypes(model))
    for (const field of from.fields) {
      if (
        field.field_type.kind !== 'relation' ||
        !refs.has(field.field_type.target_object_type_id)
      )
        continue
      const records = recordsOf(from).filter(
        (r) => r.id !== record.id && relatedIds(r, field).includes(record.id),
      )
      if (records.length)
        groups.push({
          type: from,
          field,
          direction: 'to',
          entries: records.map((r) => ({ id: r.id, record: r })),
        })
    }
  return groups
}
