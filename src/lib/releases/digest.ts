// SOURCING: Web Crypto SHA-256, as src/lib/modules/grants.ts digests a module.
// A digest here names content, never a place or a time.

/** SHA-256 of the text, as lowercase hex. */
export async function sha256(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/** JSON with object keys sorted, so equal content has one text and one digest. */
export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) =>
    inner && typeof inner === 'object' && !Array.isArray(inner)
      ? Object.fromEntries(
          Object.entries(inner as Record<string, unknown>).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0,
          ),
        )
      : inner,
  )
}

/** The digest of any JSON-like value, key order ignored. */
export const digestOf = (value: unknown) => sha256(stableJson(value))
