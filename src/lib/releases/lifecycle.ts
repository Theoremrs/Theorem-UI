// SOURCING: the command registry (src/lib/commands/registry.ts), the
// contribution registry (src/lib/contributions/registry.ts) and ./instance-scope.
// EXEC-05: disabling or uninstalling takes out what a module can run (its
// commands, default key bindings, contributions, its running instance) and
// leaves its data, source history and the settings and resource identity of
// everything that used it. Runs already admitted belong to their execution
// provider; nothing here touches them.
import { useCommandRegistry } from '@/lib/commands/registry'
import type { CommandSource } from '@/lib/commands/registry'
import { resolveHandler, useContributions } from '@/lib/contributions/registry'
import type { RegisteredContribution } from '@/lib/contributions/registry'
import { activeInstances } from './instance-scope'
import { releaseRecords } from './store'
import { addHistory } from './state'
import type { ModuleRecord } from './state'

const ownedBy = (source: CommandSource, identity: string) =>
  (source.kind === 'module' && source.moduleId === identity) ||
  (source.kind === 'extension' && source.extensionId === identity)

export interface RemovedContributions {
  commands: string[]
  contributions: string[]
}

/**
 * Removes every command and contribution a module or extension registered, by
 * source. Commands go with their default key bindings; a person's own
 * bindings and handler preferences stay, and apply again if it returns.
 */
export function removeContributionsBySource(
  identity: string,
): RemovedContributions {
  const commands = useCommandRegistry.getState().commands
  const removedCommands = [...commands.values()]
    .filter((c) => ownedBy(c.source, identity))
    .map((c) => c.id)
  if (removedCommands.length) {
    const next = new Map(commands)
    for (const id of removedCommands) next.delete(id)
    useCommandRegistry.setState({ commands: next })
  }
  const registry = useContributions.getState().contributions
  const removedKeys = [...registry.entries()]
    .filter(([, c]) => ownedBy(c.source, identity))
    .map(([key]) => key)
  if (removedKeys.length) {
    const next = new Map(registry)
    for (const key of removedKeys) next.delete(key)
    useContributions.setState({ contributions: next })
  }
  // A refused claim by this source is not a registration either.
  useCommandRegistry.setState((s) => ({
    conflicts: s.conflicts.filter((c) => !ownedBy(c.refused, identity)),
  }))
  useContributions.setState((s) => ({
    conflicts: s.conflicts.filter((c) => !ownedBy(c.refused, identity)),
  }))
  return { commands: removedCommands, contributions: removedKeys }
}

export type LifecycleResult = {
  removed: RemovedContributions
  /** Cleanups of the running instance that threw. */
  disposeFailures: unknown[]
  /** Said once, so the interface does not imply admitted work was stopped. */
  note: string
}

const NOTE =
  'New runs and openings stop. Work already started stays with its execution provider; Theorem does not stop it or report it finished. Your data and source history are kept.'

function stop(
  identity: string,
  change: (record: ModuleRecord) => ModuleRecord,
): LifecycleResult {
  const removed = removeContributionsBySource(identity)
  const { failures } = activeInstances.remove(identity)
  releaseRecords.update(identity, change)
  return { removed, disposeFailures: failures, note: NOTE }
}

/** Turns a module off; its files, releases, data and settings stay. */
export const disableModule = (identity: string): LifecycleResult =>
  stop(identity, (record) =>
    addHistory(
      { ...record, disabled: true },
      { axis: 'source', summary: 'Disabled' },
      Date.now(),
    ),
  )

/**
 * Takes a module out. Release records and source history are kept (the files
 * are not deleted here), so reinstalling rebinds the same data by identity.
 */
export const uninstallModule = (identity: string): LifecycleResult =>
  stop(identity, (record) =>
    addHistory(
      { ...record, disabled: true, uninstalled: true },
      { axis: 'source', summary: 'Uninstalled; data and history kept' },
      Date.now(),
    ),
  )

/** Allows a disabled module to run again. Its contributions return when it next activates. */
export const enableModule = (identity: string) =>
  releaseRecords.update(identity, (record) =>
    addHistory(
      { ...record, disabled: false, uninstalled: false },
      { axis: 'source', summary: 'Enabled' },
      Date.now(),
    ),
  )

/** What stands where a missing renderer was (A08). */
export interface Placeholder {
  kind: 'placeholder'
  /** The module that rendered it. */
  identity: string
  reason: 'disabled' | 'uninstalled' | 'missing'
  /** The settings it held, unchanged, so enabling it again finds them. */
  settings: Record<string, unknown>
  /** The resource it showed; the same id whichever handler opens it. */
  resourceKey?: string
  /** Other handlers that can open it, best first; empty if none. */
  openers: RegisteredContribution[]
  /** Export of its source and settings is always offered. */
  exportable: true
  message: string
}

/**
 * The placeholder for something a removed module drew. It carries the
 * original settings and resource identity unchanged and lists any other
 * handler that can open the resource, from the default-handler order.
 */
export function placeholderFor(input: {
  identity: string
  serves?: string
  resourceKey?: string
  settings?: Record<string, unknown>
}): Placeholder {
  const record = releaseRecords.get(input.identity)
  const reason = record?.uninstalled
    ? 'uninstalled'
    : record?.disabled
      ? 'disabled'
      : 'missing'
  const openers = input.serves
    ? resolveHandler('open-handler', input.serves, {
        resourceKey: input.resourceKey,
      }).candidates.filter((c) => !ownedBy(c.source, input.identity))
    : []
  return {
    kind: 'placeholder',
    identity: input.identity,
    reason,
    settings: input.settings ?? {},
    ...(input.resourceKey ? { resourceKey: input.resourceKey } : {}),
    openers,
    exportable: true,
    message:
      reason === 'missing'
        ? `${input.identity} is not installed. What you set up here is kept.`
        : `${input.identity} is ${reason}. What you set up here is kept.`,
  }
}
