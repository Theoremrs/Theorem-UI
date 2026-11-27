// SOURCING: none — TanStack Start server route that delegates to the Theorem proxy (creating an agent in the organization)
import { createFileRoute } from '@tanstack/react-router'
import { proxyHandlers } from '@/server/theorem-proxy'

export const Route = createFileRoute('/v1/theorem/organization/agents/')({
  server: { handlers: proxyHandlers },
})
