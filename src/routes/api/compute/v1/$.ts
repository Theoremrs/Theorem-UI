// SOURCING: none — TanStack Start server route that delegates to the Theorem proxy (Theorem's computations: calls, jobs and their outputs)
import { createFileRoute } from '@tanstack/react-router'
import { proxyHandlers } from '@/server/theorem-proxy'

export const Route = createFileRoute('/api/compute/v1/$')({
  server: { handlers: proxyHandlers },
})
