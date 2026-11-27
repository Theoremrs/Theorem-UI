// SOURCING: lib/commands/registry describeCommands and lib/catalog/ui-catalog
// describeUiCatalog, whose shape this follows: plain JSON an agent or another
// host reads, never live objects. The module facts come from ./registry.
import { allModules } from './registry'
import type { ModuleDefinition } from './registry'

export const MODULE_CATALOG_SCHEMA = 'theorem.modules/1'

/** One module as plain data. `sandboxed: false` marks host code. */
export interface ModuleDescription {
  id: string
  label: string
  description?: string
  version: number
  origin: ModuleDefinition['origin']
  trust: ModuleDefinition['trust']
  /** False only for a trusted module: it runs as host code. */
  sandboxed: boolean
  ports: {
    inputs: ModuleDefinition['inputs']
    outputs: ModuleDefinition['outputs']
    events: ModuleDefinition['events']
    actions: ModuleDefinition['actions']
  }
  settings: ModuleDefinition['settings']
  /** What it asks for. Asking is not being granted. */
  requestedCapabilities: ModuleDefinition['capabilities']
  contributions: {
    commands: string[]
    kinds: Array<{ kind: string; id: string; serves?: string[] }>
  }
  dependencies: NonNullable<ModuleDefinition['dependencies']>
}

export function describeModules(
  modules: ReadonlyArray<ModuleDefinition> = allModules(),
) {
  const described: ModuleDescription[] = modules.map((module) => ({
    id: module.id,
    label: module.label,
    ...(module.description && { description: module.description }),
    version: module.version,
    origin: module.origin,
    trust: module.trust,
    sandboxed: module.trust !== 'trusted',
    ports: {
      inputs: module.inputs,
      outputs: module.outputs,
      events: module.events,
      actions: module.actions,
    },
    settings: module.settings,
    requestedCapabilities: module.capabilities,
    contributions: {
      commands: module.contributes?.commands.map((c) => c.id) ?? [],
      kinds:
        module.contributes?.contributions.map((c) => ({
          kind: c.kind,
          id: c.id,
          ...(c.serves && { serves: c.serves }),
        })) ?? [],
    },
    dependencies: module.dependencies ?? [],
  }))
  return { schema: MODULE_CATALOG_SCHEMA, modules: described }
}
