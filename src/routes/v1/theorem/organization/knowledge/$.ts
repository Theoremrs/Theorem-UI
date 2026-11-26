// SOURCING: none — TanStack Start server route that delegates to the Theorem proxy (listing the knowledge providers this host ships)
import { createFileRoute } from '@tanstack/react-router'
import { proxyHandlers } from '@/server/theorem-proxy'

export const Route = createFileRoute('/v1/theorem/organization/knowledge/$')({
  server: { handlers: proxyHandlers },
})
