// SOURCING: none — TanStack Start server route over the link-metadata reader (server/link-preview.ts)
import { createFileRoute } from '@tanstack/react-router'
import { linkPreviewHandler } from '@/server/link-preview'

export const Route = createFileRoute('/api/link-preview/v1/$')({
  server: { handlers: { GET: linkPreviewHandler } },
})
