// SOURCING: none — the settings route table, pure data; lucide-react for the one mark the owner's icon set does not hold
import { UserRound } from 'lucide-react'
import { Icon } from '@/components/icons'

/** Settings' sections, grouped as the nav shows them. Each path is a file route. */
export const SETTINGS_GROUPS = [
  {
    // Who you are to your Theorem, how it looks, who keeps you company and how it answers: yours alone.
    label: 'You',
    sections: [
      { path: '/settings/profile', label: 'Profile', Mark: UserRound },
      { path: '/settings/appearance', label: 'Appearance', Mark: Icon.Sun },
      {
        path: '/settings/companions',
        label: 'Theo and Kit',
        Mark: Icon.Sparkle,
      },
      { path: '/settings/responses', label: 'Responses', Mark: Icon.ReadAloud },
      { path: '/settings/styles', label: 'Response styles', Mark: Icon.Draft },
    ],
  },
  {
    // Which models a turn can run on, and the keys that reach them.
    label: 'Models',
    sections: [
      { path: '/settings/ai', label: 'Models', Mark: Icon.Model, width: 1280 },
      { path: '/settings/keys', label: 'API keys', Mark: Icon.Key },
    ],
  },
  {
    // What the agent can reach and use.
    label: 'Tools',
    sections: [
      {
        path: '/settings/connections',
        label: 'Connections',
        Mark: Icon.Plugin,
      },
      {
        path: '/settings/plugins',
        label: 'Plugins and skills',
        Mark: Icon.Skill,
      },
      { path: '/settings/work', label: 'Work tracker', Mark: Icon.Checklist },
      // Installed modules and apps: releases, recovery, disable, export and import.
      {
        path: '/settings/releases',
        label: 'Modules and releases',
        Mark: Icon.Archive,
        width: 880,
      },
    ],
  },
  {
    // What your Theorem knows and how it is running.
    label: 'Your Theorem',
    sections: [
      {
        path: '/settings/import',
        label: 'Import context',
        Mark: Icon.Download,
      },
      // Tables of turns and a time axis: wider than a page of fields.
      {
        path: '/settings/observe',
        label: 'Observe',
        Mark: Icon.Eye,
        width: 1080,
      },
    ],
  },
] as const

/** The section at a route path, with its group, or undefined off settings. */
export function settingsSection(path: string) {
  for (const group of SETTINGS_GROUPS)
    for (const section of group.sections)
      if (path.startsWith(section.path))
        return {
          group: group.label,
          label: section.label,
          path: section.path,
          width: 'width' in section ? section.width : 680,
          // A page under the section, such as one turn under Observe.
          within: path.replace(/\/$/, '') !== section.path,
        }
  return undefined
}
