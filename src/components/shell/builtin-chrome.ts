// SOURCING: lib/contributions/registry (the one contribution registry; the
// shipped chrome registers through it exactly as an installed module's does,
// EXT-08 / ARCH-02), builtin-nav (the shipped destinations) and
// lib/appearance-policy (the shipped palettes). Importing this file registers
// the host's own navigation entries, shell presentation, layout presets and
// themes; registering again replaces the same built-in entries in place.
import { registerContributions } from '@/lib/contributions/registry'
import type { Contribution } from '@/lib/contributions/registry'
import { PALETTES } from '@/lib/appearance-policy'
import { SHIPPED_SHELL_ID } from '@/lib/shell/host-registry'
import { MODES } from './builtin-nav'

/** `theorem.nav.home` for Home, `theorem.nav.<mode>` for the rest. */
export const navEntryId = (mode: string) =>
  `theorem.nav.${mode === 'chat' ? 'home' : mode}`

/** The layout arrangements dock.tsx / arrangements.ts apply by name. */
export const SHIPPED_PRESETS = [
  { arrangement: 'focus', label: 'Focus' },
  { arrangement: 'together', label: 'Work together' },
  { arrangement: 'explore', label: 'Explore' },
] as const

export const builtinChrome = (): Contribution[] => [
  ...MODES.map((entry): Contribution => ({
    kind: 'nav-entry',
    id: navEntryId(entry.mode),
    label: entry.label,
    Component: entry.Mark,
    meta: {
      mode: entry.mode,
      // Home is the way back from everything; it cannot be hidden.
      ...(entry.mode === 'chat' && { essential: true }),
      ...('folders' in entry && { folders: true }),
    },
  })),
  {
    kind: 'shell',
    id: SHIPPED_SHELL_ID,
    label: 'Theorem',
    description:
      'The shipped shell: the rail, the navigation panel and the dock.',
  },
  ...SHIPPED_PRESETS.map((preset): Contribution => ({
    kind: 'layout-preset',
    id: `theorem.layout.${preset.arrangement}`,
    label: preset.label,
    meta: { arrangement: preset.arrangement },
  })),
  ...PALETTES.map(({ value, label }): Contribution => ({
    kind: 'theme',
    id: `theorem.theme.${value}`,
    label,
    meta: { palette: value },
  })),
]

/** Registers the shipped chrome; again replaces the same entries in place. */
export const registerBuiltinChrome = () =>
  registerContributions(builtinChrome())

registerBuiltinChrome()
