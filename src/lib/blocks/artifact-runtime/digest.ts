// SOURCING: the Web Crypto API's SHA-256 (crypto.subtle.digest), present in
// every browser and worker the App runs in and in Bun. Canonical JSON is
// written here: object keys sorted, no whitespace, so equal states always
// have equal digests. The backend's run store writes the same form.
import type { Digest } from './types'

/**
 * The canonical form this file writes, and the backend's run store writes
 * the same: `theorem.canonical-json/1`. A digest is of these bytes, so a
 * change to the form is a new version, never an edit.
 */
export const CANONICAL_JSON = 'theorem.canonical-json/1'

/** Object keys a canonical value reserves for the explicit encodings below. */
const RESERVED = new Set(['$bigint', '$bytes', '$date'])

const bytesHex = (view: ArrayBufferView) =>
  Array.from(new Uint8Array(view.buffer, view.byteOffset, view.byteLength), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')

/**
 * `value` as canonical JSON (`theorem.canonical-json/1`): object keys sorted
 * by UTF-16 code unit, no whitespace, numbers and strings as JSON.stringify
 * writes them (so `-0` is `0`). The backend writes numbers the same way.
 *
 * Values JSON has no form for are written explicitly, never silently changed:
 * a bigint as `{"$bigint":"<decimal>"}`, bytes (an ArrayBuffer, a typed array
 * or a DataView) as `{"$bytes":"<hex>","type":"<constructor>"}`, a Date as
 * `{"$date":"<ISO instant>"}`, a Map with string keys as the object of its
 * entries. An object that itself uses one of those reserved keys, a sparse
 * array, an array holding `undefined`, a Set, a Map with other keys, any
 * other class instance, a non-finite number, a function and a symbol are
 * refused. `undefined` object members are left out, as JSON leaves them.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null'
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false'
    case 'number':
      if (!Number.isFinite(value))
        throw new TypeError(`${value} has no JSON form`)
      return JSON.stringify(value)
    case 'bigint':
      return `{"$bigint":${JSON.stringify(value.toString())}}`
    case 'string':
      return JSON.stringify(value)
    case 'object':
      return canonicalObject(value)
    default:
      throw new TypeError(`A ${typeof value} has no JSON form`)
  }
}

function canonicalObject(value: object): string {
  if (Array.isArray(value)) {
    const items: Array<string> = []
    for (let index = 0; index < value.length; index++) {
      if (!(index in value))
        throw new TypeError(`An array with a hole at ${index} has no canonical form`)
      const item: unknown = value[index]
      if (item === undefined)
        throw new TypeError(`An array holding undefined at ${index} has no canonical form`)
      items.push(canonicalJson(item))
    }
    return `[${items.join(',')}]`
  }
  // The explicit encodings are written here, keys already in order ("$" sorts
  // before letters), since no plain object may use their reserved keys.
  if (value instanceof ArrayBuffer)
    return `{"$bytes":${JSON.stringify(bytesHex(new Uint8Array(value)))},"type":"ArrayBuffer"}`
  if (ArrayBuffer.isView(value))
    return `{"$bytes":${JSON.stringify(bytesHex(value))},"type":${JSON.stringify(value.constructor.name)}}`
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new TypeError('An invalid Date has no canonical form')
    return `{"$date":${JSON.stringify(value.toISOString())}}`
  }
  if (value instanceof Map) {
    const entries: Array<[string, unknown]> = []
    for (const [key, item] of value as Map<unknown, unknown>) {
      if (typeof key !== 'string')
        throw new TypeError(`A Map keyed by ${typeof key} has no canonical form`)
      entries.push([key, item])
    }
    return writeEntries(entries)
  }
  const prototype = Object.getPrototypeOf(value) as unknown
  if (prototype !== Object.prototype && prototype !== null)
    throw new TypeError(
      `A ${(value as { constructor?: { name?: string } }).constructor?.name ?? 'class'} instance has no canonical form`,
    )
  return writeEntries(Object.entries(value))
}

/** Written from entries, never through an object, so a key such as `__proto__` is kept. */
function writeEntries(all: Array<[string, unknown]>): string {
  const entries = all.filter(([, item]) => item !== undefined)
  const reserved = entries.find(([key]) => RESERVED.has(key))
  if (reserved)
    throw new TypeError(`An object with the reserved key ${reserved[0]} has no canonical form`)
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`
}

const hex = (bytes: ArrayBuffer) =>
  Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')

/** The SHA-256 digest of bytes. */
export async function digestBytes(bytes: Uint8Array): Promise<Digest> {
  return `sha256:${hex(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>))}`
}

/** The SHA-256 digest of `value`'s canonical JSON. */
export const digestOf = (value: unknown): Promise<Digest> =>
  digestBytes(new TextEncoder().encode(canonicalJson(value)))

/** Whether text is a digest this schema writes. */
export const isDigest = (text: unknown): text is Digest =>
  typeof text === 'string' && /^sha256:[0-9a-f]{64}$/.test(text)
