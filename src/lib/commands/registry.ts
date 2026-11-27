// SOURCING: zustand (the registry is a store, so a command a module or
// extension registers later reaches the palette and key bindings already
// open), as the file handler registry (src/lib/handlers/registry.ts) is, and
// zod 4 (a command's argument schema, and its JSON Schema for agents through
// z.toJSONSchema). What a command is, and who may claim which id, is the
// spec's EXT-02/EXT-04; no library models it.
import { z } from 'zod'
import { create } from 'zustand'

/**
 * What running the command does, so a menu, a key binding and an agent can
 * tell a harmless navigation from a write or a model call before running it.
 */
export const COMMAND_EFFECTS = [
  /** Moves somewhere: a route, a panel, a thread. */
  'navigate',
  /** Changes only what is shown: opens the palette, toggles a pane, sorts. */
  'presentation',
  /** Writes domain data through its owner. */
  'mutation',
  /** Invokes a capability or another owner's operation. */
  'invoke',
  /** Runs a model. Ordinary interaction never does this unasked (ARCH-05). */
  'model',
] as const
export type CommandEffect = (typeof COMMAND_EFFECTS)[number]

/** Where the work happens once the command runs. */
export const COMMAND_TARGETS = [
  /** In this window: router, layout, local stores. */
  'host',
  /** A backend owner, which rechecks authority and preconditions itself. */
  'owner',
  /** A placed module's action, through the page runtime. */
  'module',
] as const
export type CommandTarget = (typeof COMMAND_TARGETS)[number]

/** Who registered a command. Only the host may claim `theorem.*`. */
export type CommandSource =
  | { kind: 'builtin' }
  | { kind: 'module'; moduleId: string }
  | { kind: 'extension'; extensionId: string }

/** Who asked for the command to run, for receipts and diagnostics. */
export type CommandInvoker =
  'palette' | 'keybinding' | 'menu' | 'agent' | 'code'

/** What is focused when the command is considered, as the host sees it. */
export interface CommandContext {
  /** A text field, rich editor, terminal or dialog has focus, or nothing does. */
  focus: 'input' | 'editor' | 'terminal' | 'dialog' | 'none'
  /** The current route's path, `/c/abc`. */
  path: string
}

export interface CommandDefinition<TArgs = undefined> {
  /** Namespaced and stable: `theorem.chat.new`, `acme.crm.prepare-brief`. */
  id: string
  label: string
  /** The palette group it is listed under. */
  group?: string
  description?: string
  /** Extra words the palette matches but does not show. */
  keywords?: ReadonlyArray<string>
  /**
   * The arguments, validated before every run whoever invokes it. Absent, the
   * command takes none.
   */
  args?: z.ZodType<TArgs>
  /**
   * Whether the command applies here. This is enablement, not authorization:
   * the owner the command reaches rechecks authority itself (EXT-04).
   */
  when?: (context: CommandContext) => boolean
  /** The capability the owner will require, for display and agents; not a grant. */
  capability?: string
  effect: CommandEffect
  target: CommandTarget
  /** Default chords, `mod+k`; the key binding layer resolves conflicts. */
  keys?: ReadonlyArray<string>
  /** Listed in the palette; false for commands that need arguments a row cannot give. */
  palette?: boolean
  run: (
    args: TArgs,
    context: CommandContext & { invoker: CommandInvoker },
  ) => unknown
}

/** A command as the registry holds it, with who registered it. */
export interface RegisteredCommand extends CommandDefinition<unknown> {
  source: CommandSource
}

/** Someone tried to claim an id already held by another source. */
export interface CommandConflict {
  id: string
  /** The registration that keeps the id. */
  holder: CommandSource
  /** The registration that was refused. */
  refused: CommandSource
}

interface Registry {
  /** By id, in registration order. */
  commands: ReadonlyMap<string, RegisteredCommand>
  conflicts: ReadonlyArray<CommandConflict>
}

export const useCommandRegistry = create<Registry>()(() => ({
  commands: new Map(),
  conflicts: [],
}))

/** `theorem.chat.new`: lowercase segments, at least two, dot-separated. */
export const COMMAND_ID = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/

export class CommandRegistrationError extends Error {
  constructor(
    readonly id: string,
    detail: string,
  ) {
    super(`command ${id}: ${detail}`)
    this.name = 'CommandRegistrationError'
  }
}

const sameSource = (a: CommandSource, b: CommandSource) =>
  a.kind === b.kind &&
  (a.kind === 'builtin' ||
    (a.kind === 'module' && b.kind === 'module' && a.moduleId === b.moduleId) ||
    (a.kind === 'extension' &&
      b.kind === 'extension' &&
      a.extensionId === b.extensionId))

const sourceLabel = (source: CommandSource) =>
  source.kind === 'builtin'
    ? 'built in'
    : source.kind === 'module'
      ? `module ${source.moduleId}`
      : `extension ${source.extensionId}`

/**
 * Adds a command. The same source registering the same id again replaces it
 * in place (a module reloading); another source's claim on a held id is
 * refused and recorded as a conflict rather than seizing it (EXT-03).
 * Returns a function that removes exactly this registration.
 */
export function registerCommand<TArgs>(
  definition: CommandDefinition<TArgs>,
  source: CommandSource = { kind: 'builtin' },
): () => void {
  const { id } = definition
  if (!COMMAND_ID.test(id))
    throw new CommandRegistrationError(
      id,
      'ids are dot-separated lowercase segments',
    )
  if (id.startsWith('theorem.') && source.kind !== 'builtin')
    throw new CommandRegistrationError(id, 'theorem.* ids are built in')
  if (source.kind === 'module' && !id.startsWith(`${source.moduleId}.`))
    throw new CommandRegistrationError(
      id,
      `a module's commands sit under its own id, ${source.moduleId}.*`,
    )

  const entry = { ...definition, source } as RegisteredCommand
  const { commands, conflicts } = useCommandRegistry.getState()
  const held = commands.get(id)
  if (held && !sameSource(held.source, source)) {
    useCommandRegistry.setState({
      conflicts: [...conflicts, { id, holder: held.source, refused: source }],
    })
    return () =>
      useCommandRegistry.setState((registry) => ({
        conflicts: registry.conflicts.filter(
          (one) => !(one.id === id && sameSource(one.refused, source)),
        ),
      }))
  }
  const next = new Map(commands)
  next.set(id, entry)
  useCommandRegistry.setState({ commands: next })
  return () => {
    const current = useCommandRegistry.getState().commands
    if (current.get(id) !== entry) return
    const without = new Map(current)
    without.delete(id)
    useCommandRegistry.setState({ commands: without })
  }
}

/** Registers several; the returned function removes them all. */
export function registerCommands(
  definitions: ReadonlyArray<CommandDefinition<any>>,
  source?: CommandSource,
): () => void {
  const removes = definitions.map((one) => registerCommand(one, source))
  return () => {
    for (const remove of removes) remove()
  }
}

export const commandById = (id: string) =>
  useCommandRegistry.getState().commands.get(id)

export const applies = (command: RegisteredCommand, context: CommandContext) =>
  command.when ? command.when(context) : true

export type CommandResult =
  | { ok: true; value: unknown }
  | {
      ok: false
      reason: 'unknown' | 'not-applicable' | 'invalid-args' | 'failed'
      message: string
    }

/**
 * Runs a command by id: the one path a palette row, a key binding, a menu and
 * an agent all take, so the same action behaves the same from each (EXT-04).
 * Arguments are validated first; a failure comes back as a result, not a throw.
 */
export async function executeCommand(
  id: string,
  args: unknown,
  context: CommandContext,
  invoker: CommandInvoker,
): Promise<CommandResult> {
  const command = commandById(id)
  if (!command)
    return { ok: false, reason: 'unknown', message: `no command ${id}` }
  if (!applies(command, context))
    return {
      ok: false,
      reason: 'not-applicable',
      message: `${command.label} does not apply here`,
    }
  let parsed: unknown = undefined
  if (command.args) {
    const result = command.args.safeParse(args)
    if (!result.success) {
      const issue = result.error.issues[0]
      const at = issue?.path.length ? `${issue.path.join('.')}: ` : ''
      return {
        ok: false,
        reason: 'invalid-args',
        message: `${at}${issue?.message ?? 'arguments do not parse'}`,
      }
    }
    parsed = result.data
  }
  try {
    const value = await command.run(parsed, { ...context, invoker })
    return { ok: true, value }
  } catch (error) {
    return {
      ok: false,
      reason: 'failed',
      message: error instanceof Error ? error.message : String(error),
    }
  }
}

export const COMMAND_CATALOG_SCHEMA = 'theorem.commands/1'

/** One command as plain data: what an agent or another host reads. */
export interface CommandDescription {
  id: string
  label: string
  group?: string
  description?: string
  effect: CommandEffect
  target: CommandTarget
  capability?: string
  keys: ReadonlyArray<string>
  source: string
  applies: boolean
  /** JSON Schema of the arguments, absent when it takes none. */
  args?: unknown
}

function argsSchema(schema: z.ZodType | undefined): unknown {
  if (!schema) return undefined
  try {
    return z.toJSONSchema(schema)
  } catch {
    // A schema JSON Schema cannot express (a transform, a custom check)
    // still validates at run time; say so rather than describing it wrongly.
    return { description: 'arguments are validated at run time' }
  }
}

/**
 * The machine-readable command catalog: every registered command, whether it
 * applies in `context`, and its argument schema, as JSON-serializable data.
 */
export function describeCommands(context: CommandContext) {
  const commands: CommandDescription[] = [
    ...useCommandRegistry.getState().commands.values(),
  ].map((command) => ({
    id: command.id,
    label: command.label,
    ...(command.group && { group: command.group }),
    ...(command.description && { description: command.description }),
    effect: command.effect,
    target: command.target,
    ...(command.capability && { capability: command.capability }),
    keys: command.keys ?? [],
    source: sourceLabel(command.source),
    applies: applies(command, context),
    ...(command.args && { args: argsSchema(command.args) }),
  }))
  const conflicts = useCommandRegistry.getState().conflicts.map((one) => ({
    id: one.id,
    holder: sourceLabel(one.holder),
    refused: sourceLabel(one.refused),
  }))
  return { schema: COMMAND_CATALOG_SCHEMA, commands, conflicts }
}
