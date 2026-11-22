// SOURCING: lib/theorem/catalog (the plugins and skills installed in your Theorem), the settings frame
import { createFileRoute } from '@tanstack/react-router'
import type { ComponentType, SVGProps } from 'react'
import { Icon } from '@/components/icons'
import {
  SettingsBox,
  SettingsPage,
  SettingsRow,
  SettingsSection,
} from '@/components/settings/settings-frame'
import { describeError } from '@/lib/theorem/client'
import { skillOrigin, useCatalogEntries } from '@/lib/theorem/catalog'
import type { SkillEntry } from '@/lib/theorem/catalog'
import { SkillInstallations } from '@/components/settings/skill-installations'

export const Route = createFileRoute('/settings/plugins')({
  component: PluginsSettings,
})

function PluginsSettings() {
  return (
    <SettingsPage
      title="Plugins and skills"
      description="What your Theorem has installed for the agent to use."
    >
      <SkillInstallations />
      <PluginsSection />
      <SkillsSection />
    </SettingsPage>
  )
}

function CatalogList({
  items,
  Mark,
  empty,
}: {
  items: readonly {
    id: string
    name: string
    description?: string
    plugin?: string
    source?: SkillEntry['source']
  }[]
  Mark: ComponentType<SVGProps<SVGSVGElement>>
  empty: string
}) {
  if (!items.length)
    return <p className="px-1 text-sm text-ink-muted">{empty}</p>
  return (
    <SettingsBox>
      {items.map((item) => (
        <SettingsRow
          key={item.id}
          Mark={Mark}
          title={item.name}
          description={[skillOrigin(item), item.description]
            .filter(Boolean)
            .join(' · ')}
        />
      ))}
    </SettingsBox>
  )
}

function PluginsSection() {
  const { plugins, error } = useCatalogEntries()
  return (
    <SettingsSection
      title="Plugins"
      description="Bundles of tools and skills installed in your Theorem."
    >
      {error ? (
        <p className="text-sm text-ink-muted">{describeError(error)}</p>
      ) : (
        <CatalogList
          items={plugins}
          Mark={Icon.Plugin}
          empty="No plugins installed."
        />
      )}
    </SettingsSection>
  )
}

function SkillsSection() {
  const { skills, error } = useCatalogEntries()
  return (
    <SettingsSection
      title="Skills"
      description="Instructions Theorem loads when a conversation needs them."
    >
      {error ? (
        <p className="text-sm text-ink-muted">{describeError(error)}</p>
      ) : (
        <CatalogList
          items={skills}
          Mark={Icon.Skill}
          empty="No skills available."
        />
      )}
    </SettingsSection>
  )
}
