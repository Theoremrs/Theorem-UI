// SOURCING: none — TanStack Start server route that delegates to the Theorem proxy (the agent's organization record, read for its profile)
import { createFileRoute } from '@tanstack/react-router'
import { proxyHandlers } from '@/server/theorem-proxy'

export const Route = createFileRoute('/v1/theorem/organization/')({
  server: { handlers: proxyHandlers },
})
