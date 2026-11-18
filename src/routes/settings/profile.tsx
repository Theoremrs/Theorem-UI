// SOURCING: TanStack Router file route; the page is the CRM's ProfileSettings (components/crm/profile-settings)
import { createFileRoute } from '@tanstack/react-router'
import { ProfileSettings } from '@/components/crm/profile-settings'

export const Route = createFileRoute('/settings/profile')({
  component: ProfileSettings,
})
