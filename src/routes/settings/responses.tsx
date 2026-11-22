// SOURCING: components/settings/responses-section (the account's output style, detail, effort and budgets, shared with the composer's controls), the settings frame
import { createFileRoute } from '@tanstack/react-router'
import { SettingsPage } from '@/components/settings/settings-frame'
import { ResponsesSection } from '@/components/settings/responses-section'

export const Route = createFileRoute('/settings/responses')({
  component: ResponsesSettings,
})

function ResponsesSettings() {
  return (
    <SettingsPage
      title="Responses"
      description="How Theorem writes back to you by default. A conversation can change these for itself from the composer."
    >
      <ResponsesSection />
    </SettingsPage>
  )
}
