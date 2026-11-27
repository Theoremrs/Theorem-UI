// SOURCING: none — TanStack Start server route that delegates to the Theorem proxy (saving the organization's settings, such as allowing several agents)
import { createFileRoute } from '@tanstack/react-router'
import { proxyHandlers } from '@/server/theorem-proxy'

export const Route = createFileRoute('/v1/theorem/organization/settings')({
  server: { handlers: proxyHandlers },
})
