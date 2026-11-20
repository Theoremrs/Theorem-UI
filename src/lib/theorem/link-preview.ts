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

/**
 * One URL's preview metadata. `null` means the server could read none (the
 * page failed, refused, or carries no metadata): the caller falls back to a
 * plain hyperlink, never a broken card. Failures are not retried in the
 * session; the server caches them briefly so a remount is cheap.
 */
export function useLinkMetadata(url: string | undefined) {
  return useQuery({
    queryKey: linkMetadataQueryKey(url ?? ''),
    enabled: url !== undefined,
    staleTime: 30 * 60_000,
    retry: false,
    queryFn: async (): Promise<LinkMetadata | null> => {
      const response = await fetch(
        `/api/link-preview/v1/?url=${encodeURIComponent(url!)}`,
        { headers: { accept: 'application/json' } },
      )
      if (response.status === 404 || response.status === 400) return null
      if (!response.ok) throw new Error(`link preview: ${response.status}`)
      return metadataSchema.parse(await response.json())
    },
  })
}
