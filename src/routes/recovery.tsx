// SOURCING: components/shell/recovery-page (the host-owned recovery surface, outside the chat shell and every replaceable shell, handler and module)
import { createFileRoute } from '@tanstack/react-router'
import { RecoveryPage } from '@/components/shell/recovery-page'

export const Route = createFileRoute('/recovery')({
  // Recovery reads this browser's stores and needs no server.
  ssr: false,
  component: RecoveryPage,
})
