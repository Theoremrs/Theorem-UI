import { createFileRoute } from '@tanstack/react-router'

// CRM mode; the _chat layout renders the shell and ModeView shows the CRM.
export const Route = createFileRoute('/_chat/crm')({
  component: () => null,
})
