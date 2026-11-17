// SOURCING: hand-roll — no installed dependency models "text that may carry a credential" for one readable reason string (fast-redact and pino's redact work on object paths, not on prose; secretlint is a repository scanner, not installed). The patterns are the credential shapes the spec's receipts rule (R42) names: bearer tokens, vendor-prefixed API keys, JWTs, and `key=value` pairs whose key says secret.

/** The longest a reason or diagnostic line grows; a host echoing a whole file is cut here. */
export const REASON_LIMIT = 240

const MASK = '[redacted]'

const SECRETS: readonly RegExp[] = [
  // Bearer tokens.
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  // Vendor-prefixed keys: sk-live-..., sk_test_..., pk-..., ghp_..., xoxb-..., AKIA...
  /\b(?:sk|pk|rk|ghp|gho|ghu|ghs|github_pat|xox[abprs]|glpat|npm)[-_][A-Za-z0-9_-]{12,}/g,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  // JSON web tokens.
  /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]*/g,
  // `api_key: value`, `"token":"value"`, `password=value`.
  /\b(api[_-]?key|access[_-]?key|secret|token|passw(?:or)?d|authorization|credential)s?(["']?\s*[:=]\s*["']?)[^\s"',;&}]{4,}/gi,
  // A long unbroken run of letters and digits that mixes both: a key with no label (a uuid has dashes, a word has no digits).
  /\b(?=[A-Za-z0-9_]*\d)(?=[A-Za-z0-9_]*[A-Za-z])[A-Za-z0-9_]{32,}\b/g,
]

/** `text` with every credential-shaped run masked. */
export function redact(text: string): string {
  let out = text
  for (const pattern of SECRETS) {
    out = out.replace(pattern, (_match, key, separator) =>
      typeof key === 'string' && typeof separator === 'string'
        ? `${key}${separator}${MASK}`
        : MASK,
    )
  }
  return out
}

/** One line a person can read: collapsed whitespace, credentials masked, cut at {@link REASON_LIMIT}. */
export function readable(text: string): string {
  const flat = redact(text).replace(/\s+/g, ' ').trim()
  return flat.length > REASON_LIMIT ? `${flat.slice(0, REASON_LIMIT)}...` : flat
}
