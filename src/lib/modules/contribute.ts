// SOURCING: zod 4 (z.fromJSONSchema, so a module command's declared argument
// schema validates before it runs, as every command's does), and the two
// owners a module contributes into: lib/commands/registry and
// lib/contributions/registry. This file only translates a module's declared
// `contributes` into registrations (EXT-02); it keeps no registry of its own.
import { z } from 'zod'
import { registerCommand } from '@/lib/commands/registry'
import type { CommandDefinition } from '@/lib/commands/registry'
import { registerContribution } from '@/lib/contributions/registry'
import type { CommandContribution } from './contract'
import { runModuleAction } from './runtime'
import type { ModuleDefinition } from './registry'

/** A declared JSON Schema as a validator; absent when it cannot be expressed. */
function argsValidator(schema: Record<string, unknown> | undefined) {
  if (!schema) return undefined
  try {
    return z.fromJSONSchema(schema)
  } catch {
    // Declared but not expressible here: refuse every call rather than skip
    // validation the module asked for.
    return z.never({ error: 'the declared argument schema is not supported' })
  }
}

/**
 * The command a module declares, routed to its action on a placed instance.
 * With no instance on an open page it fails with a message; it never does
 * nothing quietly.
 */
export function moduleCommand(
  moduleId: string,
  declared: CommandContribution,
): CommandDefinition<unknown> {
  return {
    id: declared.id,
    label: declared.label,
    ...(declared.group && { group: declared.group }),
    ...(declared.description && { description: declared.description }),
    ...(declared.keywords && { keywords: declared.keywords }),
    ...(declared.capability && { capability: declared.capability }),
    ...(declared.keys && { keys: declared.keys }),
    args: argsValidator(declared.args),
    effect: declared.effect,
    target: 'module',
    run: (args) => {
      const result = runModuleAction(moduleId, declared.action, args)
      if (!result.ok) throw new Error(result.message)
      return { instance: result.instance }
    },
  }
}

const registered = new Map<
  string,
  { definition: ModuleDefinition; remove: () => void }
>()

function register(definition: ModuleDefinition): () => void {
  const source = { kind: 'module', moduleId: definition.id } as const
  const removes: Array<() => void> = []
  try {
    for (const command of definition.contributes?.commands ?? [])
      removes.push(
        registerCommand(moduleCommand(definition.id, command), source),
      )
    for (const one of definition.contributes?.contributions ?? [])
      removes.push(
        registerContribution(
          {
            kind: one.kind,
            id: one.id,
            label: one.label,
            ...(one.description && { description: one.description }),
            ...(one.serves && { serves: one.serves }),
            ...(one.priority !== undefined && { priority: one.priority }),
            // The module is what a panel or viewer mounts; it has no host code.
            meta: { ...one.meta, moduleId: definition.id },
          },
          source,
        ),
      )
  } catch (error) {
    // One refused id must not leave half a module registered.
    for (const remove of removes) remove()
    throw error
  }
  return () => {
    for (const remove of removes) remove()
  }
}

/**
 * Makes the registries match the modules now in the catalog: a module that
 * entered is registered, one that left or changed is unregistered first.
 * Installing grants no capability; nothing here touches grants (EXT-01).
 * Returns the ids refused, with why, for the library to show.
 */
export function syncModuleContributions(
  definitions: ReadonlyArray<ModuleDefinition>,
): Array<{ moduleId: string; message: string }> {
  const refused: Array<{ moduleId: string; message: string }> = []
  const live = new Map(definitions.map((d) => [d.id, d]))
  for (const [id, entry] of registered) {
    if (live.get(id) !== entry.definition) {
      entry.remove()
      registered.delete(id)
    }
  }
  for (const definition of definitions) {
    const { contributes } = definition
    if (
      registered.has(definition.id) ||
      (!contributes?.commands.length && !contributes?.contributions.length)
    )
      continue
    try {
      registered.set(definition.id, {
        definition,
        remove: register(definition),
      })
    } catch (error) {
      refused.push({
        moduleId: definition.id,
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }
  lastRefused = refused
  return refused
}

let lastRefused: Array<{ moduleId: string; message: string }> = []
/** Modules whose contributions were refused at the last sync. */
export const refusedContributions = () => lastRefused
