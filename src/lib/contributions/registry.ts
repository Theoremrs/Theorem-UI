// SOURCING: zustand (the registry is a store, so a module installed or
// disabled later reaches the shell and pickers already open) with its persist
// middleware (the person's chosen defaults outlive a reload and an update,
// OWN-01), as lib/commands/registry is. The kinds of contribution are the
// spec's EXT-02; the default-handler order is its EXT-03. No library models
// either.
import type { ComponentType } from 'react'
import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import type { CommandSource } from '@/lib/commands/registry'
import { COMMAND_ID } from '@/lib/commands/registry'

/**
 * What a contribution adds. Commands and key bindings live in lib/commands;
 * everything else a module, an application package or the host itself adds
 * to the workspace is one of these.
 */
export const CONTRIBUTION_KINDS = [
  // Shell
  'nav-entry',
  'panel',
  'toolbar-item',
  'inspector-section',
  'context-menu-item',
  'theme',
  'layout-preset',
  /** A whole shell presentation: navigation, tab chrome, menus, toolbars (EXT-08). */
  'shell',
  // Resource experience
  /** Opens a resource kind as its main view; the default-handler order picks one. */
  'open-handler',
  'preview',
  'mention-presentation',
  'reference-row',
  'property-cell',
  'artifact-viewer',
  // Data and views
  'collection-view',
  'import-export-adapter',
  // Work and automation
  'run-view',
  'execution-provider',
  // Entire applications
  /** A replaceable application: the CRM workbench, the research environment. */
  'application',
] as const
export type ContributionKind = (typeof CONTRIBUTION_KINDS)[number]

/** Who contributed it: the host, a vault module, or an installed package. */
export type ContributionSource = CommandSource

export interface Contribution<TProps = any> {
  kind: ContributionKind
  /** Namespaced and stable, as command ids are: `acme.crm.workbench`. */
  id: string
  label: string
  description?: string
  /**
   * The resource kinds (`file`, `record:company`, `acme.ticket`) or
   * application roles (`crm`, `research`) it serves, for handlers, previews,
   * cells and applications.
   */
  serves?: ReadonlyArray<string>
  /** Among handlers for the same thing, higher is preferred; built-ins ship at 0. */
  priority?: number
  /** The web presentation. Absent for a contribution another host renders. */
  Component?: ComponentType<TProps>
  /** Kind-specific data: a theme's tokens, a panel's default location, a command id. */
  meta?: Readonly<Record<string, unknown>>
}

export interface RegisteredContribution extends Contribution {
  source: ContributionSource
}

export interface ContributionConflict {
  kind: ContributionKind
  id: string
  holder: ContributionSource
  refused: ContributionSource
}

interface Registry {
  /** Keyed `${kind}:${id}`, in registration order. */
  contributions: ReadonlyMap<string, RegisteredContribution>
  conflicts: ReadonlyArray<ContributionConflict>
}

export const useContributions = create<Registry>()(() => ({
  contributions: new Map(),
  conflicts: [],
}))

export class ContributionError extends Error {
  constructor(
    readonly id: string,
    detail: string,
  ) {
    super(`contribution ${id}: ${detail}`)
    this.name = 'ContributionError'
  }
}

const keyOf = (kind: ContributionKind, id: string) => `${kind}:${id}`

export const sameSource = (a: ContributionSource, b: ContributionSource) =>
  a.kind === b.kind &&
  (a.kind === 'builtin' ||
    (a.kind === 'module' && b.kind === 'module' && a.moduleId === b.moduleId) ||
    (a.kind === 'extension' &&
      b.kind === 'extension' &&
      a.extensionId === b.extensionId))

export const sourceLabel = (source: ContributionSource) =>
  source.kind === 'builtin'
    ? 'built in'
    : source.kind === 'module'
      ? `module ${source.moduleId}`
      : `extension ${source.extensionId}`

/**
 * Adds a contribution, under the same rules as a command: `theorem.*` is the
 * host's, a module's sit under its own id, and a claim on an id another
 * source holds is refused and recorded, never seized (EXT-02/EXT-03).
 * Returns a function that removes exactly this registration.
 */
export function registerContribution(
  contribution: Contribution,
  source: ContributionSource = { kind: 'builtin' },
): () => void {
  const { id, kind } = contribution
  if (!(CONTRIBUTION_KINDS as ReadonlyArray<string>).includes(kind))
    throw new ContributionError(id, `${kind} is not a contribution kind`)
  if (!COMMAND_ID.test(id))
    throw new ContributionError(id, 'ids are dot-separated lowercase segments')
  if (id.startsWith('theorem.') && source.kind !== 'builtin')
    throw new ContributionError(id, 'theorem.* ids are built in')
  if (source.kind === 'module' && !id.startsWith(`${source.moduleId}.`))
    throw new ContributionError(
      id,
      `a module's contributions sit under its own id, ${source.moduleId}.*`,
    )
  const key = keyOf(kind, id)
  const entry: RegisteredContribution = { ...contribution, source }
  const { contributions, conflicts } = useContributions.getState()
  const held = contributions.get(key)
  if (held && !sameSource(held.source, source)) {
    useContributions.setState({
      conflicts: [
        ...conflicts,
        { kind, id, holder: held.source, refused: source },
      ],
    })
    return () =>
      useContributions.setState((registry) => ({
        conflicts: registry.conflicts.filter(
          (one) =>
            !(
              one.kind === kind &&
              one.id === id &&
              sameSource(one.refused, source)
            ),
        ),
      }))
  }
  const next = new Map(contributions)
  next.set(key, entry)
  useContributions.setState({ contributions: next })
  return () => {
    const current = useContributions.getState().contributions
    if (current.get(key) !== entry) return
    const without = new Map(current)
    without.delete(key)
    useContributions.setState({ contributions: without })
  }
}

export function registerContributions(
  contributions: ReadonlyArray<Contribution>,
  source?: ContributionSource,
): () => void {
  const removes = contributions.map((one) => registerContribution(one, source))
  return () => {
    for (const remove of removes) remove()
  }
}

/** Every contribution of a kind, in registration order. */
export const contributionsOf = (
  kind: ContributionKind,
  registry = useContributions.getState().contributions,
): RegisteredContribution[] =>
  [...registry.values()].filter((one) => one.kind === kind)

export const contributionById = (kind: ContributionKind, id: string) =>
  useContributions.getState().contributions.get(keyOf(kind, id))

export const PREFERENCES_SCHEMA = 'theorem.workspace-preferences/1'

/**
 * The person's choices about which contribution serves what. Kept apart from
 * shipped defaults and from any contribution's own source, so an update
 * changes neither (OWN-01).
 */
export interface HandlerPreferences {
  /** A resource's own handler, by its resourceKey. */
  byResource: Record<string, string>
  /** The person's handler for a resource kind or application role. */
  byServes: Record<string, string>
  /** The workspace's handler for a kind or role, as an admin set it. */
  workspace: Record<string, string>
  /** Built-in entries the person hid; restoring removes the id. */
  hidden: ReadonlyArray<string>
  /** The shell presentation in use; absent, the shipped shell. */
  shell?: string
}

interface PreferenceStore extends HandlerPreferences {
  prefer: (
    scope: 'byResource' | 'byServes' | 'workspace',
    key: string,
    id: string | null,
  ) => void
  setHidden: (id: string, hidden: boolean) => void
  selectShell: (id: string | undefined) => void
  /** Back to every shipped default; contributions and data are untouched. */
  resetAll: () => void
}

const EMPTY: HandlerPreferences = {
  byResource: {},
  byServes: {},
  workspace: {},
  hidden: [],
}

export const useHandlerPreferences = create<PreferenceStore>()(
  persist(
    (set) => ({
      ...EMPTY,
      prefer: (scope, key, id) =>
        set((state) => {
          const { [key]: _, ...rest } = state[scope]
          return { [scope]: id === null ? rest : { ...rest, [key]: id } }
        }),
      setHidden: (id, hidden) =>
        set((state) => ({
          hidden: hidden
            ? [...new Set([...state.hidden, id])]
            : state.hidden.filter((one) => one !== id),
        })),
      selectShell: (shell) => set({ shell }),
      resetAll: () => set({ ...EMPTY, shell: undefined }),
    }),
    {
      name: PREFERENCES_SCHEMA,
      version: 1,
      storage: createJSONStorage(() => localStorage),
      partialize: ({ byResource, byServes, workspace, hidden, shell }) => ({
        byResource,
        byServes,
        workspace,
        hidden,
        shell,
      }),
    },
  ),
)

/** Why the handler that serves was chosen, in EXT-03's order. */
export type HandlerReason =
  | 'explicit'
  | 'resource-preference'
  | 'person-preference'
  | 'workspace-default'
  | 'shipped-default'
  | 'only-candidate'

export interface HandlerResolution {
  handler: RegisteredContribution | undefined
  reason: HandlerReason | undefined
  /** Every handler that could serve, the chosen one first. */
  candidates: RegisteredContribution[]
  /**
   * Handlers that tie for the choice with no preference to break it. The
   * shipped default (or the first registered) serves meanwhile, and the
   * person is shown the choice rather than having one installed for them.
   */
  ambiguous: RegisteredContribution[]
  /** A preference named a handler that is no longer installed. */
  missingPreference?: string
}

/**
 * The handler that serves `serves` (a resource kind or application role),
 * in EXT-03's order: an explicit choice for this opening; the person's choice
 * for this resource; the person's choice for the kind; the workspace's
 * default; the shipped default. Choosing changes presentation only: the
 * resource's id, data and references are the same whichever serves.
 */
export function resolveHandler(
  kind: ContributionKind,
  serves: string,
  options: { explicit?: string; resourceKey?: string } = {},
  preferences: HandlerPreferences = useHandlerPreferences.getState(),
  registry = useContributions.getState().contributions,
): HandlerResolution {
  const candidates = contributionsOf(kind, registry).filter((one) =>
    one.serves?.includes(serves),
  )
  const byId = new Map(candidates.map((one) => [one.id, one]))
  let missingPreference: string | undefined
  const pick = (id: string | undefined, reason: HandlerReason) => {
    if (!id) return undefined
    const found = byId.get(id)
    if (!found) {
      missingPreference ??= id
      return undefined
    }
    return { handler: found, reason }
  }
  const visible = candidates.filter(
    (one) =>
      !(one.source.kind === 'builtin' && preferences.hidden.includes(one.id)),
  )
  const chosen =
    pick(options.explicit, 'explicit') ??
    pick(
      options.resourceKey && preferences.byResource[options.resourceKey],
      'resource-preference',
    ) ??
    pick(preferences.byServes[serves], 'person-preference') ??
    pick(preferences.workspace[serves], 'workspace-default')

  const ordered = (list: RegisteredContribution[]) =>
    list
      .map((one, at) => ({ one, at }))
      .toSorted(
        (a, b) =>
          (b.one.priority ?? 0) - (a.one.priority ?? 0) ||
          (a.one.source.kind === 'builtin' ? 0 : 1) -
            (b.one.source.kind === 'builtin' ? 0 : 1) ||
          a.at - b.at,
      )
      .map(({ one }) => one)

  if (chosen) {
    return {
      handler: chosen.handler,
      reason: chosen.reason,
      candidates: [
        chosen.handler,
        ...ordered(candidates).filter((one) => one !== chosen.handler),
      ],
      ambiguous: [],
      ...(missingPreference && { missingPreference }),
    }
  }

  // No preference: the shipped default serves. An installed handler never
  // takes over on its own, however high its priority (EXT-03).
  const pool = visible.length ? visible : candidates
  const builtins = ordered(pool.filter((one) => one.source.kind === 'builtin'))
  const others = ordered(pool.filter((one) => one.source.kind !== 'builtin'))
  const handler = builtins[0] ?? others[0]
  const reason: HandlerReason | undefined = !handler
    ? undefined
    : pool.length === 1
      ? 'only-candidate'
      : 'shipped-default'
  const ambiguous = builtins.length
    ? others.length
      ? [builtins[0]!, ...others]
      : []
    : others.length > 1
      ? others
      : []
  return {
    handler,
    reason,
    candidates: handler
      ? [handler, ...ordered(candidates).filter((one) => one !== handler)]
      : [],
    ambiguous,
    ...(missingPreference && { missingPreference }),
  }
}
