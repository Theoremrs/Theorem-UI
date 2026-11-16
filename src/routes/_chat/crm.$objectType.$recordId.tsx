import { createFileRoute } from '@tanstack/react-router'

// One record's page, by the record's id; ModeView shows it in CRM mode.
export const Route = createFileRoute('/_chat/crm/$objectType/$recordId')({
  component: () => null,
})
