// SOURCING: none — TanStack Start server route that delegates to the Theorem proxy (saving the agent's profile as a new organization revision)
import { createFileRoute } from '@tanstack/react-router'
import { proxyHandlers } from '@/server/theorem-proxy'

export const Route = createFileRoute('/v1/theorem/organization/profile')({
  server: { handlers: proxyHandlers },
})
