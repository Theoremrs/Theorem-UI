// SOURCING: components/settings/defaults-section (the handler choices over lib/contributions' EXT-03 order), the settings frame
import { createFileRoute } from '@tanstack/react-router'
import { SettingsPage } from '@/components/settings/settings-frame'
import { DefaultsSection } from '@/components/settings/defaults-section'

export const Route = createFileRoute('/settings/defaults')({
  component: DefaultsSettings,
})

function DefaultsSettings() {
  return (
    <SettingsPage
      title="Defaults"
      description="Which handler opens each kind of resource, which application serves each role, and which shell you use. You choose; nothing installed is chosen for you."
    >
      <DefaultsSection />
    </SettingsPage>
  )
}
