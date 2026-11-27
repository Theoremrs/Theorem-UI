// SOURCING: lib/contributions/registry (the one contribution registry and
// EXT-03 handler order) and zustand (hooks re-read when a contribution is
// installed, a preference changes or safe mode flips). This is the host's own
// view of that registry: in safe mode it sees built-ins only and no stored
// preferences, so a broken extension or choice cannot reach recovery (EXEC-05).
import { useMemo } from 'react'
import type { ComponentType, ReactNode, SVGProps } from 'react'
import {
  contributionsOf,
  resolveHandler,
  useContributions,
  useHandlerPreferences,
} from '@/lib/contributions/registry'
import type {
  ContributionKind,
  HandlerPreferences,
  HandlerResolution,
  RegisteredContribution,
} from '@/lib/contributions/registry'
import { isSafeMode, useSafeMode } from './safe-mode'

type Registry = ReturnType<typeof useContributions.getState>['contributions']

/** The registry as the host sees it: built-ins only while safe mode is on. */
export function hostRegistry(
  registry: Registry = useContributions.getState().contributions,
  safe = isSafeMode(),
): Registry {
  if (!safe) return registry
  return new Map(
    [...registry].filter(([, one]) => one.source.kind === 'builtin'),
  )
}

/** The preferences the host honors: none in safe mode, the shipped order serves. */
export const hostPreferences = (
  preferences: HandlerPreferences = useHandlerPreferences.getState(),
  safe = isSafeMode(),
): HandlerPreferences =>
  safe
    ? { byResource: {}, byServes: {}, workspace: {}, hidden: [] }
    : preferences

export const hostContributionsOf = (
  kind: ContributionKind,
  safe = isSafeMode(),
) => contributionsOf(kind, hostRegistry(undefined, safe))

/** resolveHandler through the host's view (EXT-03 order, safe mode aware). */
export function hostResolveHandler(
  kind: ContributionKind,
  serves: string,
  options: { explicit?: string; resourceKey?: string } = {},
): HandlerResolution {
  return resolveHandler(
    kind,
    serves,
    options,
    hostPreferences(),
    hostRegistry(),
  )
}

/** Contributions of a kind, re-read when the registry or safe mode changes. */
export function useHostContributions(kind: ContributionKind) {
  const registry = useContributions((state) => state.contributions)
  const safe = useSafeMode((state) => state.active)
  return useMemo(
    () => contributionsOf(kind, hostRegistry(registry, safe)),
    [kind, registry, safe],
  )
}

/** One destination on the rail, as a `nav-entry` contribution describes it. */
export interface NavEntry {
  id: string
  label: string
  Mark: ComponentType<SVGProps<SVGSVGElement>>
  /** A built-in mode this destination opens (the rail's drag order is by mode). */
  mode?: string
  /** A path another source's destination opens. */
  to?: string
  /** Offered only where folders can be opened (the Vault). */
  folders?: boolean
  /** Cannot be hidden: Home. */
  essential?: boolean
  builtin: boolean
}

const NO_MARK = (() => null) as unknown as NavEntry['Mark']

/** Navigation entries in registration order, without the built-ins the person hid. */
export function navEntriesOf(
  contributions: ReadonlyArray<RegisteredContribution>,
  hidden: ReadonlyArray<string>,
): NavEntry[] {
  return contributions
    .filter((one) => {
      const essential = one.meta?.essential === true
      const builtin = one.source.kind === 'builtin'
      return essential || !(builtin && hidden.includes(one.id))
    })
    .map((one) => ({
      id: one.id,
      label: one.label,
      Mark: (one.Component as NavEntry['Mark'] | undefined) ?? NO_MARK,
      ...(typeof one.meta?.mode === 'string' && { mode: one.meta.mode }),
      ...(typeof one.meta?.to === 'string' && { to: one.meta.to }),
      ...(one.meta?.folders === true && { folders: true }),
      ...(one.meta?.essential === true && { essential: true }),
      builtin: one.source.kind === 'builtin',
    }))
}

/** The rail's destinations now. */
export const navEntries = (safe = isSafeMode()): NavEntry[] =>
  navEntriesOf(
    hostContributionsOf('nav-entry', safe),
    hostPreferences(undefined, safe).hidden,
  )

export function useNavEntries(): NavEntry[] {
  const contributions = useHostContributions('nav-entry')
  const hidden = useHandlerPreferences((state) => state.hidden)
  const safe = useSafeMode((state) => state.active)
  return useMemo(
    () => navEntriesOf(contributions, safe ? [] : hidden),
    [contributions, hidden, safe],
  )
}

/** What a shell presentation receives: the same data the shipped one uses. */
export interface ShellPresentationProps {
  projectId: string
  threadId: string | undefined
  navigation: NavEntry[]
  panels: RegisteredContribution[]
  /** The shipped presentation, for a shell that wraps it rather than replaces it. */
  shipped: ReactNode
}

export const SHIPPED_SHELL_ID = 'theorem.shell.default'

/**
 * The shell contribution the person selected, if it is installed and safe mode
 * is off. Absent or the shipped id means the shipped presentation renders.
 */
export function selectedShell(
  preferences: Pick<
    HandlerPreferences,
    'shell'
  > = useHandlerPreferences.getState(),
  safe = isSafeMode(),
): RegisteredContribution | undefined {
  if (safe || !preferences.shell || preferences.shell === SHIPPED_SHELL_ID)
    return undefined
  return hostContributionsOf('shell', safe).find(
    (one) => one.id === preferences.shell,
  )
}

export function useSelectedShell() {
  const shell = useHandlerPreferences((state) => state.shell)
  const shells = useHostContributions('shell')
  return useMemo(
    () =>
      !shell || shell === SHIPPED_SHELL_ID
        ? undefined
        : shells.find((one) => one.id === shell),
    [shell, shells],
  )
}
