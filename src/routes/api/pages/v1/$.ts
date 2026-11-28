// SOURCING: the authenticated Theorem proxy used by the typed capability routes.
import { createFileRoute } from '@tanstack/react-router'
import { proxyHandlers } from '@/server/theorem-proxy'

export const Route = createFileRoute('/api/pages/v1/$')({
  server: { handlers: proxyHandlers },
})
