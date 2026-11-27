// SOURCING: lib/contributions/registry (resolveHandler's EXT-03 order, the
// preference store and its hidden list) through lib/shell/host-registry (safe
// mode aware). This file only turns the registry into rows a person can read
// and acts on the preference store when they choose; it never selects an
// installed handler on its own (EXT-03).
import {
  contributionsOf,
  resolveHandler,
  useContributions,
  useHandlerPreferences,
} from '@/lib/contributions/registry'
import type {
  ContributionKind,
  HandlerPreferences,
  HandlerReason,
  RegisteredContribution,
} from '@/lib/contributions/registry'
import { hostPreferences, hostRegistry } from './host-registry'
import { isSafeMode } from './safe-mode'

/** Kinds whose contribution serves a resource kind or an application role. */
export const HANDLER_KINDS: ReadonlyArray<ContributionKind> = [
  'open-handler',
  'application',
  'preview',
  'artifact-viewer',
  'collection-view',
  'mention-presentation',
  'reference-row',
  'property-cell',
]

export type DefaultsStatus =
  /** A choice by the person (or workspace) is serving. */
  | 'chosen'
  /** One candidate, or the shipped default, serves with nothing to decide. */
  | 'default'
  /** Several candidates tie and no preference breaks it: the person decides. */
  | 'ambiguous'
  /** A preference names a handler that is no longer installed. */
  | 'missing'
  /** A preference exists for a role nothing now serves. */
  | 'orphaned'

export interface DefaultsRow {
  key: string
  kind: ContributionKind | 'shell'
  /** The resource kind or application role; `shell` for the shell row. */
  serves: string
  candidates: RegisteredContribution[]
  /** The id serving now, if any. */
  current: string | undefined
  reason: HandlerReason | undefined
  status: DefaultsStatus
  /** The preference's id when it names something not installed. */
  missingPreference?: string
  /** Handlers tied for the choice. */
  ambiguous: RegisteredContribution[]
  /** Whether the person has set a choice for this row. */
  hasPreference: boolean
}

export const REASON_TEXT: Record<HandlerReason, string> = {
  explicit: 'Chosen for this opening',
  'resource-preference': 'Your choice for this resource',
  'person-preference': 'Your choice',
  'workspace-default': "The workspace's default",
  'shipped-default': 'The shipped default',
  'only-candidate': 'The only handler installed',
}

/**
 * One row per resource kind or role anything serves, plus the shell, from the
 * registry as the host sees it. A row's status says whether the person needs
 * to decide (a tie, or a choice whose handler was uninstalled).
 */
export function defaultsRows(
  registry = useContributions.getState().contributions,
  preferences: HandlerPreferences = useHandlerPreferences.getState(),
  safe = isSafeMode(),
): DefaultsRow[] {
  const visible = hostRegistry(registry, safe)
  const prefs = hostPreferences(preferences, safe)
  const rows: DefaultsRow[] = []
  const served = new Set<string>()
  for (const kind of HANDLER_KINDS) {
    const serves = new Set(
      contributionsOf(kind, visible).flatMap((one) => one.serves ?? []),
    )
    for (const role of [...serves].sort()) {
      served.add(role)
      const resolution = resolveHandler(kind, role, {}, prefs, visible)
      const hasPreference = Boolean(
        prefs.byServes[role] ?? prefs.workspace[role],
      )
      rows.push({
        key: `${kind}:${role}`,
        kind,
        serves: role,
        candidates: resolution.candidates,
        current: resolution.handler?.id,
        reason: resolution.reason,
        status: resolution.missingPreference
          ? 'missing'
          : resolution.ambiguous.length
            ? 'ambiguous'
            : resolution.reason === 'person-preference' ||
                resolution.reason === 'workspace-default' ||
                resolution.reason === 'resource-preference'
              ? 'chosen'
              : 'default',
        ...(resolution.missingPreference && {
          missingPreference: resolution.missingPreference,
        }),
        ambiguous: resolution.ambiguous,
        hasPreference,
      })
    }
  }
  // A choice made for a role nothing serves now (its handler was removed).
  for (const [role, id] of Object.entries(prefs.byServes)) {
    if (served.has(role)) continue
    rows.push({
      key: `orphan:${role}`,
      kind: 'open-handler',
      serves: role,
      candidates: [],
      current: undefined,
      reason: undefined,
      status: 'orphaned',
      missingPreference: id,
      ambiguous: [],
      hasPreference: true,
    })
  }
  const shells = contributionsOf('shell', visible)
  const selected = prefs.shell
  const installed = shells.find((one) => one.id === selected)
  rows.unshift({
    key: 'shell',
    kind: 'shell',
    serves: 'shell',
    candidates: shells,
    current:
      installed?.id ?? shells.find((one) => one.source.kind === 'builtin')?.id,
    reason: installed ? 'person-preference' : 'shipped-default',
    status:
      selected && !installed ? 'missing' : installed ? 'chosen' : 'default',
    ...(selected && !installed && { missingPreference: selected }),
    ambiguous: [],
    hasPreference: Boolean(selected),
  })
  return rows
}

/** Built-in navigation entries a person may hide, with whether each is hidden now. */
export function hideableBuiltins(
  registry = useContributions.getState().contributions,
  hidden: ReadonlyArray<string> = useHandlerPreferences.getState().hidden,
) {
  return contributionsOf('nav-entry', registry)
    .filter((one) => one.source.kind === 'builtin' && !one.meta?.essential)
    .map((one) => ({
      id: one.id,
      label: one.label,
      hidden: hidden.includes(one.id),
    }))
}

/** Records the person's choice for a row. Nothing else ever calls this. */
export function chooseHandler(row: DefaultsRow, id: string) {
  const prefs = useHandlerPreferences.getState()
  if (row.kind === 'shell') prefs.selectShell(id)
  else prefs.prefer('byServes', row.serves, id)
}

/** Drops the person's choice, so the shipped default serves again. */
export function restoreDefault(row: DefaultsRow) {
  const prefs = useHandlerPreferences.getState()
  if (row.kind === 'shell') prefs.selectShell(undefined)
  else {
    prefs.prefer('byServes', row.serves, null)
  }
}

export const setBuiltinHidden = (id: string, hidden: boolean) =>
  useHandlerPreferences.getState().setHidden(id, hidden)
