// SOURCING: lib/modules/store (useVaultClient: the Theorem vault the modules live in), lib/releases through components/settings/releases-section, the settings frame
import { createFileRoute } from '@tanstack/react-router'
import { Empty, EmptyDescription, EmptyTitle } from '@/components/coss/empty'
import { ReleasesSection } from '@/components/settings/releases-section'
import { SettingsPage } from '@/components/settings/settings-frame'
import { Skeleton } from '@/components/ui/skeleton'
import { useVaultClient } from '@/lib/modules/store'

export const Route = createFileRoute('/settings/releases')({
  component: ReleasesSettings,
})

function ReleasesSettings() {
  const { client, isPending, missing } = useVaultClient()
  return (
    <SettingsPage
      title="Modules and releases"
      description="What is installed in your vault, which release of each is running, and how to go back, turn one off, or take it with you."
    >
      {client ? (
        <ReleasesSection client={client} />
      ) : isPending ? (
        <Skeleton className="h-28 w-full rounded-lg" />
      ) : (
        <Empty className="rounded-lg border border-separator">
          <EmptyTitle>There is no vault to read modules from</EmptyTitle>
          <EmptyDescription>{missing}</EmptyDescription>
        </Empty>
      )}
    </SettingsPage>
  )
}
