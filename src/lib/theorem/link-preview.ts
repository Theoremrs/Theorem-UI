// SOURCING: @tanstack/react-query over the same-origin link-metadata route
// (server/link-preview.ts). The link-preview element renders props; this is
// the fetch/cache that supplies them, keyed by URL so every citation of one
// source shares one request and one result.
import { useQuery } from '@tanstack/react-query'
import { z } from 'zod'

const metadataSchema = z.object({
  href: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
  image: z.string().optional(),
  siteName: z.string().optional(),
  favicon: z.string().optional(),
})

export type LinkMetadata = z.infer<typeof metadataSchema>

export const linkMetadataQueryKey = (url: string) =>
  ['theorem', 'link-preview', url] as const

const MAX_OVERLOAD_RETRIES = 3
const MAX_RETRY_DELAY_MS = 10_000

function retryAfterDelay(hint: string | null): number {
  const value = hint?.trim()
  if (!value) return 0
  if (/^\d+$/.test(value)) return Number(value) * 1_000
  // HTTP dates start with a weekday. Do not let Date.parse reinterpret a
  // malformed numeric hint (such as "1.5") as a calendar date.
  if (!/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*[, ]/i.test(value)) return 0
  const now = Date.now()
  const date = Date.parse(value)
  return Number.isFinite(date) ? Math.max(0, date - now) : 0
}

class PreviewOverloadedError extends Error {
  readonly retryAfterMs: number

  constructor(hint: string | null) {
    super('link preview: 503')
    this.retryAfterMs = retryAfterDelay(hint)
  }
}

/**
 * One URL's preview metadata. `null` means the server could read none (the
 * page failed, refused, or carries no metadata): the caller falls back to a
 * plain hyperlink, never a broken card. Only temporary overload retries:
 * at most three retries with 1/2/4-second backoff, honoring reasonable server
 * delays. Scheduled waits total at most 30 seconds, excluding request time.
 * Missing metadata becomes stale with the server's five-minute negative cache,
 * while successful metadata keeps its longer freshness window.
 */
export function useLinkMetadata(url: string | undefined) {
  return useQuery({
    queryKey: linkMetadataQueryKey(url ?? ''),
    enabled: url !== undefined,
    staleTime: (query) =>
      query.state.data === null ? 5 * 60_000 : 30 * 60_000,
    retry: (failureCount, error) =>
      error instanceof PreviewOverloadedError &&
      error.retryAfterMs <= MAX_RETRY_DELAY_MS &&
      failureCount < MAX_OVERLOAD_RETRIES,
    retryDelay: (failureCount, error) =>
      Math.min(
        MAX_RETRY_DELAY_MS,
        Math.max(
          1_000 * 2 ** failureCount,
          error instanceof PreviewOverloadedError ? error.retryAfterMs : 0,
        ),
      ),
    queryFn: async (): Promise<LinkMetadata | null> => {
      const response = await fetch(
        `/api/link-preview/v1/?url=${encodeURIComponent(url!)}`,
        { headers: { accept: 'application/json' } },
      )
      if (response.status === 404 || response.status === 400) return null
      if (response.status === 503)
        throw new PreviewOverloadedError(response.headers.get('retry-after'))
      if (!response.ok) throw new Error(`link preview: ${response.status}`)
      return metadataSchema.parse(await response.json())
    },
  })
}
