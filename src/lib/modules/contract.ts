// SOURCING: zod (every module and page file is parsed before use; both are
// written by people and agents alike), Puck's Data shape (@puckeditor/core
// 0.24: `root`, `content`, `zones`, components as `{type, props: {id}}`) for a
// page's layout, so the file is exactly what the editor reads and writes. The
// module and connection model is this app's own (docs/plans/modular-interface.md).
import { z } from 'zod'
import { COMMAND_EFFECTS, COMMAND_ID } from '@/lib/commands/registry'

/**
 * What flows between modules. `item` is something the person can point at
 * (an Index document, a record, a file), `reference` is a conversation
 * context reference, `json` is anything else.
 */
export const VALUE_TYPES = [
  'text',
  'number',
  'boolean',
  'json',
  'item',
  'reference',
] as const
export type ValueType = (typeof VALUE_TYPES)[number]
export const valueType = z.enum(VALUE_TYPES)

/** Something in Theorem a module can point at. */
export interface Item {
  id: string
  label?: string
  /** `document`, `record`, `file`, ... */
  kind?: string
  /** A TheoremResource, when the item has one. */
  resource?: Record<string, unknown>
  /**
   * Where the item was opened, as the Index names its scopes (`home`, or a
   * `collection` with its `collectionId`), so what is done with it next
   * counts there.
   */
  scope?: Record<string, unknown>
}

/** A module, setting, port or instance name: a short identifier. */
export const identifier = z
  .string()
  .regex(/^[a-z][a-zA-Z0-9]*$/, 'a camelCase name')
  .max(48)

/** A module id: reverse-DNS words, `theorem.` reserved for built-ins. */
export const moduleId = z
  .string()
  .regex(/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/, 'a dotted id like acme.notes')
  .max(96)

/** Instance props the host owns; a module's settings may not use them. */
export const RESERVED_PROPS = [
  'id',
  'title',
  'v',
  'bind',
  'on',
  'children',
  'puck',
  'editMode',
] as const

const port = z.looseObject({
  name: identifier,
  label: z.string().min(1).max(80),
  type: valueType,
  description: z.string().max(400).optional(),
})
export type PortSpec = z.infer<typeof port>

/**
 * A resource a setting chooses: which Index view, object, file, App or
 * conversation an instance shows.
 */
export const RESOURCE_KINDS = [
  'index-view',
  'object-type',
  'file',
  'app',
  'conversation',
  'work-view',
  'work-project',
] as const
export type ResourceKind = (typeof RESOURCE_KINDS)[number]

const setting = z.looseObject({
  name: identifier.refine(
    (name) => !(RESERVED_PROPS as readonly string[]).includes(name),
    'a name the host does not use',
  ),
  label: z.string().min(1).max(80),
  kind: z.enum(['text', 'textarea', 'number', 'boolean', 'select', 'resource']),
  options: z
    .array(z.looseObject({ label: z.string(), value: z.string() }))
    .optional(),
  resource: z.enum(RESOURCE_KINDS).optional(),
  default: z.json().optional(),
  description: z.string().max(400).optional(),
})
export type SettingSpec = z.infer<typeof setting>

/**
 * One step from an older settings shape to `to`. Declarative, so a module
 * installed as files can carry its own and the host can apply it.
 */
const migration = z.looseObject({
  to: z.number().int().min(2),
  rename: z.record(z.string(), z.string()).optional(),
  remove: z.array(z.string()).optional(),
  set: z.record(z.string(), z.json()).optional(),
})
export type MigrationStep = z.infer<typeof migration>

/** What a module may do on a capability instance: read its definition, its records, or run actions. */
export const CAPABILITY_METHODS = ['describe', 'query', 'invoke'] as const

/** One capability instance a module asks to reach through the bridge, and how. */
const instanceRequest = z
  .looseObject({
    instanceId: z.string().min(1).max(200),
    methods: z.array(z.enum(CAPABILITY_METHODS)).min(1),
    /** The action keys `invoke` may name; nothing else runs. */
    actions: z.array(z.string().min(1).max(200)).default([]),
  })
  .refine(
    (one) => one.methods.includes('invoke') === one.actions.length > 0,
    'invoke names the actions it may run, and actions need invoke',
  )
export type InstanceRequest = z.infer<typeof instanceRequest>

/** What a sandboxed module asks to reach. Asking is not being granted. */
export const requestedCapabilities = z.looseObject({
  read: z.array(z.string()).default([]),
  write: z.array(z.string()).default([]),
  state: z.array(z.string()).default([]),
  net: z.array(z.string().regex(/^[a-z0-9.-]+(:\d+)?$/i)).default([]),
  /** Capability instances, reached only through the host's scoped bridge methods. */
  instances: z.array(instanceRequest).optional(),
})
export type RequestedCapabilities = z.infer<typeof requestedCapabilities>

/** Where an input's value comes from: another instance's output, on this page. */
export const binding = z.looseObject({
  /** The source instance, or `@in` for the composite's own input. */
  from: z.string().min(1),
  port: identifier,
  /** A dot path into the value, `item.label`, `0.id`. */
  pick: z.string().max(200).optional(),
  /** Set when the source's type differs from the input's: convert it. */
  convert: z.boolean().optional(),
})
export type Binding = z.infer<typeof binding>

/** Host actions an event may reach. None of them calls a model. */
export const HOST_ACTIONS = ['composer.attach', 'composer.ask'] as const
export type HostAction = (typeof HOST_ACTIONS)[number]

/** Where an event goes: an action of another instance, or the host. */
const routeSchema = z.looseObject({
  to: z.union([
    z.looseObject({ instance: z.string().min(1), action: identifier }),
    z.looseObject({ host: z.enum(HOST_ACTIONS) }),
  ]),
  pick: z.string().max(200).optional(),
  convert: z.boolean().optional(),
})
/** Typed by hand so `'host' in route.to` narrows; the schema stays loose to keep unknown fields. */
export interface Route {
  to: { instance: string; action: string } | { host: HostAction }
  pick?: string
  convert?: boolean
}
export const route: z.ZodType<Route> = routeSchema

/** Puck's component data: `{type, props: {id, ...}}`, slots as nested arrays. */
export const componentData: z.ZodType<ComponentData> = z.lazy(() =>
  z.looseObject({
    type: z.string().min(1),
    props: z.looseObject({ id: z.string().min(1) }),
  }),
)
export interface ComponentData {
  type: string
  props: { id: string; [key: string]: unknown }
  [key: string]: unknown
}

/** Puck's Data: the page's root props, its content, and legacy zones. */
export const layoutData = z.looseObject({
  root: z.looseObject({ props: z.record(z.string(), z.unknown()).optional() }),
  content: z.array(componentData),
  zones: z.record(z.string(), z.array(componentData)).optional(),
})
export type LayoutData = z.infer<typeof layoutData>

/** How a composite's inner instances surface as the composite's own ports. */
const exposes = z.looseObject({
  outputs: z
    .record(
      identifier,
      z.looseObject({ instance: z.string(), port: identifier }),
    )
    .default({}),
  events: z
    .record(
      identifier,
      z.looseObject({ instance: z.string(), event: identifier }),
    )
    .default({}),
  /** An action of the composite's, handed to the inner instance's own. */
  actions: z
    .record(
      identifier,
      z.looseObject({ instance: z.string(), action: identifier }),
    )
    .default({}),
})

const implementation = z.discriminatedUnion('kind', [
  /** An HTML page in the module's folder, run in an opaque-origin frame. */
  z.looseObject({
    kind: z.literal('sandboxed-html'),
    entry: z
      .string()
      .regex(/^[\w-]+(\/[\w-]+)*\.html$/)
      .default('index.html'),
  }),
  /** Instances of other modules, wired together, saved as one. */
  z.looseObject({
    kind: z.literal('composite'),
    content: z.array(componentData),
    exposes: exposes.default({ outputs: {}, events: {}, actions: {} }),
  }),
])

/**
 * How an agent reads the module when it is selected or asked about: what it
 * is for, and the output whose current value says what it shows now.
 */
const agentRepresentation = z.looseObject({
  description: z.string().min(1).max(1000),
  summaryOutput: identifier.optional(),
})
export type AgentRepresentation = z.infer<typeof agentRepresentation>

/**
 * What the page shows instead when the sandbox is unavailable, not granted, or
 * fails: an instance's records and action controls through the built-in table.
 */
const moduleFallback = z.looseObject({
  kind: z.literal('capability-records'),
  instanceId: z.string().min(1).max(200),
  viewKey: z.string().min(1).max(200).optional(),
  /** The actions offered; absent, every action the view offers. */
  actions: z.array(z.string().min(1).max(200)).optional(),
})
export type ModuleFallback = z.infer<typeof moduleFallback>

/**
 * The contribution kinds a module file may declare. Declarative only: a
 * vault file never supplies host code, so each is data the host renders
 * (a theme's tokens, a handler's `serves`, a panel that mounts the module).
 */
export const DECLARABLE_CONTRIBUTIONS = [
  'nav-entry',
  'panel',
  'open-handler',
  'preview',
  'reference-row',
  'property-cell',
  'artifact-viewer',
  'collection-view',
  'theme',
  'layout-preset',
  'shell',
  'application',
] as const

/** A kind needing a `serves` list to mean anything. */
const SERVING_KINDS: ReadonlyArray<string> = [
  'open-handler',
  'preview',
  'reference-row',
  'property-cell',
  'artifact-viewer',
  'collection-view',
  'application',
]

const commandContribution = z.looseObject({
  /** Full id, under the module's own: `acme.notes.pin`. */
  id: z.string().regex(COMMAND_ID).max(120),
  label: z.string().min(1).max(80),
  group: z.string().max(80).optional(),
  description: z.string().max(400).optional(),
  /** A JSON Schema for the arguments; absent, the command takes none. */
  args: z.record(z.string(), z.unknown()).optional(),
  effect: z.enum(COMMAND_EFFECTS),
  /** A module's commands run on the module; the host owns every other target. */
  target: z.literal('module').default('module'),
  /** The module action port the command routes to. */
  action: identifier,
  keys: z.array(z.string().min(1).max(40)).max(4).optional(),
  keywords: z.array(z.string().max(40)).max(12).optional(),
  /** The capability the action will need, for display; declaring grants nothing. */
  capability: z.string().max(200).optional(),
})
export type CommandContribution = z.infer<typeof commandContribution>

const kindContribution = z.looseObject({
  kind: z.enum(DECLARABLE_CONTRIBUTIONS),
  id: z.string().regex(COMMAND_ID).max(120),
  label: z.string().min(1).max(80),
  description: z.string().max(400).optional(),
  serves: z.array(z.string().min(1).max(120)).max(32).optional(),
  priority: z.number().int().min(-100).max(100).optional(),
  /** Kind-specific data; a theme's `tokens` is required. */
  meta: z.record(z.string(), z.unknown()).optional(),
})
export type KindContribution = z.infer<typeof kindContribution>

const contributes = z.looseObject({
  commands: z.array(commandContribution).default([]),
  contributions: z.array(kindContribution).default([]),
})
export type Contributes = z.infer<typeof contributes>

/**
 * How much of the host a module's code reaches. `isolated` runs in the
 * opaque-origin frame; `composition` is saved wiring of other modules;
 * `trusted` is host code, not sandboxed, and only a built-in may be it.
 */
export const TRUST_TIERS = ['isolated', 'composition', 'trusted'] as const
export type TrustTier = (typeof TRUST_TIERS)[number]

/** The format number this client reads and writes (EXT-07). */
export const FORMAT_VERSION = 1

export const MODULE_SCHEMA = 'theorem.module/1'

/** `Modules/<folder>/module.json` in the vault. */
export const moduleManifest = z
  .looseObject({
    schema: z.literal(MODULE_SCHEMA),
    /** The writer's format number; a file above this client's is not rewritten. */
    format: z.number().int().min(1).optional(),
    id: moduleId.refine(
      (id) => !id.startsWith('theorem.'),
      'theorem.* ids are built in',
    ),
    version: z.number().int().min(1).default(1),
    label: z.string().min(1).max(80),
    description: z.string().max(1000).optional(),
    settings: z.array(setting).default([]),
    inputs: z.array(port).default([]),
    outputs: z.array(port).default([]),
    events: z.array(port).default([]),
    actions: z.array(port).default([]),
    capabilities: requestedCapabilities.default({
      read: [],
      write: [],
      state: [],
      net: [],
    }),
    migrations: z.array(migration).default([]),
    implementation,
    agent: agentRepresentation.optional(),
    fallback: moduleFallback.optional(),
    /** Declared trust; must match the implementation, and `trusted` is never a file's. */
    trust: z.enum(TRUST_TIERS).optional(),
    /** npm packages the module's page imports, by name and version; resolved by the App resolver. */
    dependencies: z
      .record(z.string().min(1).max(214), z.string().min(1).max(200))
      .optional(),
    /** What the module adds to the workspace. Declaring grants nothing. */
    contributes: contributes.optional(),
  })
  .superRefine((manifest, context) => {
    const expected =
      manifest.implementation.kind === 'composite' ? 'composition' : 'isolated'
    if (manifest.trust && manifest.trust !== expected)
      context.addIssue({
        code: 'custom',
        path: ['trust'],
        message:
          manifest.trust === 'trusted'
            ? 'a module file runs sandboxed; only built-in modules are trusted'
            : `a ${manifest.implementation.kind} module is ${expected}`,
      })
    const mine = `${manifest.id}.`
    const actionNames = new Set(manifest.actions.map((a) => a.name))
    const seen = new Set<string>()
    manifest.contributes?.commands.forEach((command, at) => {
      const path = ['contributes', 'commands', at]
      if (!command.id.startsWith(mine))
        context.addIssue({
          code: 'custom',
          path: [...path, 'id'],
          message: `a module's commands sit under its own id, ${manifest.id}.*`,
        })
      if (!actionNames.has(command.action))
        context.addIssue({
          code: 'custom',
          path: [...path, 'action'],
          message: `"${command.action}" is not one of the actions`,
        })
      if (seen.has(`command:${command.id}`))
        context.addIssue({
          code: 'custom',
          path: [...path, 'id'],
          message: `${command.id} is declared twice`,
        })
      seen.add(`command:${command.id}`)
    })
    manifest.contributes?.contributions.forEach((one, at) => {
      const path = ['contributes', 'contributions', at]
      if (!one.id.startsWith(mine))
        context.addIssue({
          code: 'custom',
          path: [...path, 'id'],
          message: `a module's contributions sit under its own id, ${manifest.id}.*`,
        })
      if (SERVING_KINDS.includes(one.kind) && !one.serves?.length)
        context.addIssue({
          code: 'custom',
          path: [...path, 'serves'],
          message: `a ${one.kind} says what it serves`,
        })
      if (one.kind === 'theme') {
        const tokens = one.meta?.tokens
        const valid =
          !!tokens &&
          typeof tokens === 'object' &&
          !Array.isArray(tokens) &&
          Object.values(tokens).every((value) => typeof value === 'string')
        if (!valid)
          context.addIssue({
            code: 'custom',
            path: [...path, 'meta', 'tokens'],
            message: 'a theme carries tokens, a map of names to values',
          })
      }
      if (seen.has(`${one.kind}:${one.id}`))
        context.addIssue({
          code: 'custom',
          path: [...path, 'id'],
          message: `${one.kind} ${one.id} is declared twice`,
        })
      seen.add(`${one.kind}:${one.id}`)
    })
    const summary = manifest.agent?.summaryOutput
    if (summary && !manifest.outputs.some((one) => one.name === summary))
      context.addIssue({
        code: 'custom',
        path: ['agent', 'summaryOutput'],
        message: `"${summary}" is not one of the outputs`,
      })
  })
export type ModuleManifest = z.infer<typeof moduleManifest>
export type ModuleImplementation = ModuleManifest['implementation']

export const PAGE_SCHEMA = 'theorem.page/1'
/** A page file's name ends so: `Pages/Desk.page.json`. */
export const PAGE_SUFFIX = '.page.json'

/** `Pages/<name>.page.json` in the vault. */
export const pageDocument = z.looseObject({
  schema: z.literal(PAGE_SCHEMA),
  title: z.string().min(1).max(120),
  /** The writer's format number; a file above this client's is not rewritten. */
  format: z.number().int().min(1).optional(),
  /** Listed first in Pages. */
  pinned: z.boolean().default(false),
  /** The Puck layout, with each instance's settings and wiring in its props. */
  layout: layoutData,
})
export type PageDocument = z.infer<typeof pageDocument>

/** An instance's props, as the host reads them from the layout. */
export interface InstanceProps {
  id: string
  title?: string
  /** The module version its settings were saved under. */
  v?: number
  bind?: Record<string, Binding>
  on?: Record<string, Route[]>
  [setting: string]: unknown
}

const instanceWiring = z.looseObject({
  bind: z.record(z.string(), binding).optional(),
  on: z.record(z.string(), z.array(route)).optional(),
})

/** An instance's wiring, or nothing for wiring that does not parse. */
export function wiringOf(props: Record<string, unknown>): {
  bind: Record<string, Binding>
  on: Record<string, Route[]>
} {
  const parsed = instanceWiring.safeParse({ bind: props.bind, on: props.on })
  return parsed.success
    ? { bind: parsed.data.bind ?? {}, on: parsed.data.on ?? {} }
    : { bind: {}, on: {} }
}

/** zod's first problem, as a sentence naming where it is. */
export function describeIssues(error: z.ZodError): string {
  const issue = error.issues[0]
  if (!issue) return 'it does not parse'
  const at = issue.path.length ? `${issue.path.join('.')}: ` : ''
  return `${at}${issue.message}`
}

export class ModuleFileError extends Error {
  constructor(
    readonly path: string,
    detail: string,
  ) {
    super(`${path}: ${detail}`)
    this.name = 'ModuleFileError'
  }
}

function parseJson(path: string, text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new ModuleFileError(path, 'it is not JSON')
  }
}

/**
 * A file written by a newer Theorem than this one (EXT-07). It is read for a
 * limited presentation (`limited`) and never rewritten: parse refuses with
 * this error, so no document exists for a save to write back.
 */
export class NewerFormatError extends ModuleFileError {
  constructor(
    path: string,
    readonly found: string,
    /** What can be shown without understanding the file: its title, id, label. */
    readonly limited: { title?: string; id?: string; label?: string },
    /** The stored JSON, untouched, for a viewer that wants to show it. */
    readonly raw: unknown,
  ) {
    super(
      path,
      `it was written by a newer Theorem (${found}); this version shows it read-only and does not rewrite it`,
    )
    this.name = 'NewerFormatError'
  }
}

/** The schema's trailing number, `theorem.page/2` -> 2. */
const schemaNumber = (schema: unknown, base: string): number | undefined => {
  if (typeof schema !== 'string' || !schema.startsWith(`${base}/`))
    return undefined
  const n = Number(schema.slice(base.length + 1))
  return Number.isInteger(n) ? n : undefined
}

/** Throws NewerFormatError for a file whose schema or format is above this client's. */
function fence(path: string, base: string, value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return
  const record = value as Record<string, unknown>
  const major = schemaNumber(record.schema, base)
  const format = typeof record.format === 'number' ? record.format : 1
  if ((major !== undefined && major > 1) || format > FORMAT_VERSION) {
    const text = (k: string) =>
      typeof record[k] === 'string' ? record[k] : undefined
    throw new NewerFormatError(
      path,
      major !== undefined && major > 1
        ? String(record.schema)
        : `format ${format}`,
      { title: text('title'), id: text('id'), label: text('label') },
      value,
    )
  }
}

/**
 * One module or page file, read against its schema; a refusal names the file
 * and the field. Unknown fields stay in the result (the schemas are loose), so
 * writing it back keeps what a newer or foreign writer added.
 */
function parseFile<T>(
  schema: z.ZodType<T>,
  base: string,
  path: string,
  text: string,
): T {
  const value = parseJson(path, text)
  fence(path, base, value)
  const result = schema.safeParse(value)
  if (!result.success)
    throw new ModuleFileError(path, describeIssues(result.error))
  return result.data
}

export const parseManifest = (path: string, text: string): ModuleManifest =>
  parseFile(moduleManifest, 'theorem.module', path, text)

export const parsePage = (path: string, text: string): PageDocument =>
  parseFile(pageDocument, 'theorem.page', path, text)

/** A page file's text: stable key order, two-space indent, trailing newline. */
export const pageText = (page: PageDocument) =>
  `${JSON.stringify(page, null, 2)}\n`

export const manifestText = (manifest: ModuleManifest) =>
  `${JSON.stringify(manifest, null, 2)}\n`

/**
 * The text to save over `stored`: refuses when what is stored was written by
 * a newer format, so an older client never flattens it. For a caller that
 * holds only text; a parsed document cannot be newer, as parse refused it.
 */
export function guardedWrite(
  path: string,
  stored: string | undefined,
  next: string,
): string {
  if (stored !== undefined) {
    const base = path.endsWith(PAGE_SUFFIX) ? 'theorem.page' : 'theorem.module'
    try {
      fence(path, base, JSON.parse(stored))
    } catch (error) {
      if (error instanceof NewerFormatError) throw error
    }
  }
  return next
}
