// SOURCING: Theorem's `context_manifest` chat part (schema theorem.life_context_manifest.v1): which saved records a reply was given, at which saved revision, why each one, and what was reached and held back. Decoded here once, with the words each code is shown as, so the renderer never prints a code or a withheld value
import type { ObjectType } from '@/components/records/contract'
import { fieldByKey } from '@/components/records/model'

type Json = Record<string, unknown>

const isObject = (value: unknown): value is Json =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown) =>
  typeof value === 'string' && value.length > 0 ? value : undefined
const count = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined
const texts = (value: unknown) =>
  Array.isArray(value)
    ? value.filter((v): v is string => typeof v === 'string' && v.length > 0)
    : []

export type ManifestWhy =
  | { kind: 'you' }
  | { kind: 'focus' }
  | { kind: 'mentioned'; phrase: string }
  | { kind: 'standing'; through?: string }
  | { kind: 'related_from' | 'related_to'; recordId: string; through?: string }
  /** A reason this client does not know: shown as no reason, never guessed. */
  | { kind: 'unknown' }

export type IncludedRecord = {
  recordId: string
  /** The type's singular name, and its id in the schema register. */
  objectType: string
  objectTypeId: string | undefined
  /** The exact saved revision the reply was given. */
  revision: number
  label: string
  fields: string[]
  withheldFields: string[]
  shortenedFields: string[]
  supersededFields: string[]
  why: ManifestWhy
  estimatedTokens: number | undefined
}

export type WithheldRecord = {
  recordId: string
  objectType: string | undefined
  reason: string
}

export type ContextManifest = {
  you: { state: string; recordId: string | undefined }
  included: IncludedRecord[]
  withheld: WithheldRecord[]
  ambiguous: { phrase: string; recordIds: string[] }[]
  /** Records that were eligible and left out to stay within the limits. */
  overBudget: number
  degraded: string[]
  /** The record types Theorem was told about, when it was given the data model. */
  modelTypes: string[]
  estimatedTokens: number | undefined
  /** How the token figure was reached; it is an estimate, and says so. */
  method: string | undefined
}

function decodeWhy(raw: unknown): ManifestWhy {
  if (!isObject(raw)) return { kind: 'unknown' }
  const through = text(raw.through)
  switch (raw.kind) {
    case 'you':
    case 'focus':
      return { kind: raw.kind }
    case 'mentioned': {
      const phrase = text(raw.phrase)
      return phrase ? { kind: 'mentioned', phrase } : { kind: 'unknown' }
    }
    case 'standing':
      return { kind: 'standing', through }
    case 'related_from':
    case 'related_to': {
      const recordId = text(raw.record_id) ?? text(raw.recordId)
      return recordId
        ? { kind: raw.kind, recordId, through }
        : { kind: 'unknown' }
    }
    default:
      return { kind: 'unknown' }
  }
}

function decodeIncluded(raw: unknown): IncludedRecord[] {
  if (!isObject(raw)) return []
  const recordId = text(raw.record_id)
  const revision = count(raw.revision)
  // A record with no id or no revision cannot be named truthfully; drop it
  // from the list and let the count come from what can be shown.
  if (!recordId || revision === undefined) return []
  return [
    {
      recordId,
      objectType: text(raw.object_type) ?? 'Record',
      objectTypeId: text(raw.object_type_id),
      revision,
      label: text(raw.label) ?? recordId,
      fields: texts(raw.fields),
      withheldFields: texts(raw.withheld_fields),
      shortenedFields: texts(raw.shortened_fields),
      supersededFields: texts(raw.superseded_fields),
      why: decodeWhy(raw.why),
      estimatedTokens: count(raw.estimated_tokens),
    },
  ]
}

/**
 * The part's payload as the page holds it. The manifest sits at the payload's
 * top level; one nested under `payload` is read too. Anything that is not this
 * schema is `undefined`, and the part is not drawn.
 */
export function decodeManifestPart(data: unknown): ContextManifest | undefined {
  const outer = isObject(data) ? data : {}
  const part = isObject(outer.manifest)
    ? outer
    : isObject(outer.payload)
      ? outer.payload
      : {}
  const manifest = part.manifest
  if (!isObject(manifest)) return undefined
  if (text(manifest.schema) !== 'theorem.life_context_manifest.v1')
    return undefined
  const you = isObject(manifest.you) ? manifest.you : {}
  const accounting = isObject(manifest.accounting) ? manifest.accounting : {}
  const delivery = isObject(part.delivery) ? part.delivery : {}
  const list = (value: unknown) => (Array.isArray(value) ? value : [])
  return {
    you: { state: text(you.state) ?? 'unbound', recordId: text(you.record_id) },
    included: list(manifest.included).flatMap(decodeIncluded),
    withheld: list(manifest.withheld).flatMap((raw) => {
      if (!isObject(raw)) return []
      const recordId = text(raw.record_id)
      return recordId
        ? [
            {
              recordId,
              objectType: text(raw.object_type),
              reason: text(raw.reason) ?? 'unknown',
            },
          ]
        : []
    }),
    ambiguous: list(manifest.ambiguous).flatMap((raw) => {
      if (!isObject(raw)) return []
      const phrase = text(raw.phrase)
      return phrase ? [{ phrase, recordIds: texts(raw.record_ids) }] : []
    }),
    overBudget: count(manifest.over_budget) ?? 0,
    degraded: texts(manifest.degraded),
    modelTypes: isObject(manifest.model) ? texts(manifest.model.types) : [],
    estimatedTokens:
      count(delivery.estimatedTokens) ?? count(accounting.estimated_tokens),
    method: text(delivery.method) ?? text(accounting.method),
  }
}

/** Whether the part has anything at all to tell the person. */
export const manifestSaysSomething = (manifest: ContextManifest) =>
  manifest.included.length > 0 ||
  manifest.withheld.length > 0 ||
  manifest.ambiguous.length > 0 ||
  manifest.degraded.length > 0 ||
  manifest.overBudget > 0

const plural = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`

/** "Used 5 saved records · 1 held back". */
export function manifestSummary(manifest: ContextManifest) {
  const used = manifest.included.length
  const held = manifest.withheld.length
  const parts = [
    used
      ? `Used ${plural(used, 'saved record', 'saved records')}`
      : 'Used no saved records',
  ]
  if (held) parts.push(`${held} held back`)
  if (manifest.overBudget)
    parts.push(`${manifest.overBudget} left out for length`)
  return parts.join(' · ')
}

/** A field's label where its type is known, else its key made readable. */
export function fieldWord(type: ObjectType | undefined, key: string) {
  const field = type ? fieldByKey(type, key) : undefined
  return field?.label ?? key.replace(/_/g, ' ')
}

const listOf = (words: string[]) =>
  words.length <= 1
    ? (words[0] ?? '')
    : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`

/**
 * Why a record was used, in plain words. `labelOf` names another record of
 * the same reply; `type` is the record's own type and `otherType` the type of
 * the record it is tied to, for the field's label.
 */
export function whyWords(
  record: IncludedRecord,
  labelOf: (recordId: string) => string | undefined,
  type: ObjectType | undefined,
  typeOf: (recordId: string) => ObjectType | undefined,
): string | undefined {
  const why = record.why
  switch (why.kind) {
    case 'you':
      return 'This is you'
    case 'focus':
      return 'You pointed Theorem at it'
    case 'mentioned':
      return `Your message says “${why.phrase}”`
    case 'standing':
      return 'It always applies to you'
    case 'related_from': {
      // An included record points at this one through its field.
      const other = labelOf(why.recordId) ?? 'another record used here'
      return why.through
        ? `${fieldWord(typeOf(why.recordId), why.through)} of ${other}`
        : `Tied to ${other}`
    }
    case 'related_to': {
      // This record points at an included one through its own field.
      const other = labelOf(why.recordId) ?? 'another record used here'
      return why.through
        ? `${fieldWord(type, why.through)}: ${other}`
        : `Tied to ${other}`
    }
    default:
      return undefined
  }
}

/** What was kept from, shortened in or added to a used record. Never a value. */
export function fieldNotes(
  record: IncludedRecord,
  type: ObjectType | undefined,
) {
  const words = (keys: string[]) =>
    listOf(keys.map((key) => fieldWord(type, key)))
  const notes: string[] = []
  if (record.withheldFields.length)
    notes.push(`Held back: ${words(record.withheldFields)}`)
  if (record.shortenedFields.length)
    notes.push(`Shortened to fit: ${words(record.shortenedFields)}`)
  if (record.supersededFields.length)
    notes.push(
      `Given with the value it replaced: ${words(record.supersededFields)}`,
    )
  return notes
}

const WITHHELD: Record<string, string> = {
  no_context_policy: 'its type has not been made available to Theorem',
  unreadable_context_policy:
    'its type’s setting for Theorem could not be read, so it was kept out',
  type_excluded: 'its type is kept out of Theorem’s answers',
  record_private: 'it is private to you',
  record_deleted: 'it has been deleted',
  field_excluded: 'the field that ties it in is kept out of Theorem’s answers',
  not_readable: 'this sign-in cannot read it',
  not_found: 'it could not be found',
  related_withheld: 'it relates a record that is kept out',
}

/** Why a record was held back. A reason this client does not know says so. */
export const withheldWords = (reason: string) =>
  WITHHELD[reason] ?? 'the reason was not given'

/** A way the reading fell short, in a sentence. */
export function degradedWords(code: string) {
  const [kind, subject] = code.split(':', 2)
  if (kind === 'unreadable_type' && subject)
    return `${subject} records could not be read, so none were used.`
  if (kind === 'scan_limited' && subject)
    return `Only some ${subject} records were looked through; others may bear on this.`
  if (kind === 'time_limit')
    return 'Looking through saved records took too long and stopped early; some may be missing.'
  if (kind === 'model_fields_omitted')
    return 'How your records are organised was described without the meaning of each field, to fit.'
  if (kind === 'model_omitted')
    return 'How your records are organised was too long to describe, so the records were given without it.'
  if (kind === 'resolution_failed')
    return 'Saved records could not be read for this reply, so none were used.'
  return 'Saved records were not read completely for this reply.'
}

/** "about 310 tokens — estimate: serialized characters / 4". */
export function tokenWords(manifest: ContextManifest) {
  if (manifest.estimatedTokens === undefined) return undefined
  const about = `about ${new Intl.NumberFormat('en-US').format(manifest.estimatedTokens)} tokens`
  return manifest.method
    ? `${about} — ${manifest.method}`
    : `${about} — an estimate`
}
