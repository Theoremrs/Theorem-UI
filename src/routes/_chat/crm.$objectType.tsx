import { createFileRoute } from '@tanstack/react-router'

// One type's records, by the type's plural name; ModeView shows its table.
export const Route = createFileRoute('/_chat/crm/$objectType')({
  component: () => null,
})
