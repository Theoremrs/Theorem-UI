// SOURCING: the Web Crypto API's SHA-256 (crypto.subtle.digest), present in
// every browser and worker the App runs in and in Bun. Canonical JSON is
// written here: object keys sorted, no whitespace, so equal states always
// have equal digests. The backend's run store writes the same form.
import type { Digest } from './types'

/**
 * `value` as canonical JSON. A bigint is written as `{"$bigint":"<decimal>"}`
 * so it stays exact; `undefined` members are left out as JSON leaves them;
 * a non-finite number, a function or a symbol is refused rather than
 * silently changed.
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
    case 'object': {
      if (value instanceof Map) return canonicalJson(Object.fromEntries(value))
      if (value instanceof Set) return canonicalJson([...value])
      if (ArrayBuffer.isView(value))
        return canonicalJson(Array.from(value as unknown as ArrayLike<number>))
      if (Array.isArray(value))
        return `[${value.map((item) => (item === undefined ? 'null' : canonicalJson(item))).join(',')}]`
      const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`
    }
    default:
      throw new TypeError(`A ${typeof value} has no JSON form`)
  }
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
