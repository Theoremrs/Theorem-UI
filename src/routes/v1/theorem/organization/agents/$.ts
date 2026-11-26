// SOURCING: none — TanStack Start server route that delegates to the Theorem proxy (an agent's profile, knowledge, memories, export, import and evaluation)
import { createFileRoute } from '@tanstack/react-router'
import { proxyHandlers } from '@/server/theorem-proxy'

export const Route = createFileRoute('/v1/theorem/organization/agents/$')({
  server: { handlers: proxyHandlers },
})
