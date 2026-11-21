// SOURCING: the web's data-part rules in ../src/components/chat/theorem-parts.tsx (RENDERERS, CitationPart, citationUrl), applied to the parts @theoremharness/sdk projects

type Json = Record<string, unknown>
const object = (value: unknown): Json =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {}

/** Parts the web draws nothing for: the run's steps, usage and expressions show elsewhere or not at all. */
export const SILENT_PARTS = new Set([
  'theorem-progress',
  'theorem-usage',
  'theorem-expression',
  'theorem-expression_refused',
])

/**
 * Sources a web search or page read retrieved arrive one citation per result,
 * eight to a search. The answer links what it uses and the tool call keeps
 * every result, so, as on the web, these draw nothing.
 */
const RETRIEVED_SOURCES = new Set<unknown>(['web_search', 'web_read'])

export type Citation = { label: string; url?: string }

/** An absolute web URL, or nothing: a destination is never inferred. */
function webUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : undefined
  } catch {
    return undefined
  }
}

/** The tag a citation draws, or undefined when it draws none. */
export function citationOf(data: unknown): Citation | undefined {
  const part = object(data)
  if (RETRIEVED_SOURCES.has(part.sourceKind)) return undefined
  const url = webUrl(object(part.provenance).url)
  const label =
    (typeof part.label === 'string' && part.label) || (url ? new URL(url).hostname : undefined) || 'Source'
  return { label, url }
}
