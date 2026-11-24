// SOURCING: zod (every parameter a sandbox sends is parsed before use),
// picomatch (a path is allowed when one of the declared globs matches it),
// d3-dsv (CSV rows, with autoType for numbers and dates). The checks are this
// app's capability model (plan D9): a block reaches exactly what it declared.
import { autoType, csvParse } from 'd3-dsv'
import picomatch from 'picomatch'
import { z } from 'zod'
import type { WorkspaceClient } from '@/lib/workspace/types'
import type { Capabilities } from './declarations'
import {
  DB_READS,
  MAX_OUTLINE,
  MAX_SNAPSHOT,
  call,
  serve,
} from './sandbox/protocol'
import type {
  ArtifactObservation,
  ArtifactResolution,
  CapabilityFailure,
  CapabilityInvokeParams,
  CapabilityMethod,
  CapabilityOutcome,
  CapabilityQueryParams,
  DbFailure,
  DbMethod,
  DbOutcome,
  DbRead,
  DossierContext,
  DossierState,
  FileFormat,
  FrameError,
  ListedFile,
  ModelTrace,
  PageMethods,
  ReopenedRun,
  Rpc,
  RunRequestResult,
  SandboxMethods,
  AppSelection,
} from './sandbox/protocol'

/** Shared state collections, as the page keeps them for a workspace. */
export interface StateCollections {
  snapshot: (name: string) => Record<string, unknown>
  set: (name: string, key: string, value: unknown) => void | Promise<void>
  delete: (name: string, key: string) => void | Promise<void>
  subscribe: (
    name: string,
    listener: (value: Record<string, unknown>) => void,
  ) => () => void
}

/**
 * The graph databases the page keeps for one App, by declared name. The page
 * holds them because a frame on an origin of its own has no storage.
 */
export interface AppDatabases {
  call: (name: string, method: DbMethod, args: unknown) => Promise<unknown>
  /** Keeps a read current. Returns the function that stops it. */
  subscribe: (
    name: string,
    read: { method: DbRead; args: unknown },
    next: (value: unknown) => void,
    error: (failure: DbFailure) => void,
  ) => () => void
}

/** A database failure as the frame is told of it. */
export function dbFailure(error: unknown): DbFailure {
  const code = (error as { code?: unknown } | null)?.code
  return {
    code: typeof code === 'string' ? code : 'database_failure',
    message: error instanceof Error ? error.message : String(error),
  }
}

/** A capability instance a frame may reach, and what it may do there. */
export interface CapabilityScope {
  instanceId: string
  methods: ReadonlyArray<CapabilityMethod>
  /** The action keys `invoke` may name. */
  actions: ReadonlyArray<string>
}

/**
 * Capability calls the host makes for a frame with its own session: the frame
 * names an instance and an action, never a credential.
 */
export interface AppCapabilities {
  /** What the module declared and the person allowed; anything else is denied. */
  scope: ReadonlyArray<CapabilityScope>
  describe: (instanceId: string) => Promise<unknown>
  query: (request: CapabilityQueryParams) => Promise<unknown>
  invoke: (request: CapabilityInvokeParams) => Promise<unknown>
}

/** A capability's refusal as the frame is told of it: a problem's code and detail. */
export function capabilityFailure(error: unknown): CapabilityFailure {
  const body = (error as { body?: unknown } | null)?.body
  const problem = body !== null && typeof body === 'object' ? (body as Record<string, unknown>) : {}
  return {
    code: typeof problem.code === 'string' ? problem.code : 'capability_failure',
    message:
      typeof problem.detail === 'string'
        ? problem.detail
        : error instanceof Error
          ? error.message
          : String(error),
  }
}

/** What the page lends one block. */
export interface BridgeHost {
  client: Pick<WorkspaceClient, 'read' | 'tree' | 'write'>
  /**
   * A limit the person set (a sandboxed module): only the files, state,
   * databases and runs it names. Absent, the block may use them all.
   */
  capabilities?: Capabilities
  state: StateCollections
  /** Absent where a block has no databases: a declared `db` is then refused. */
  db?: AppDatabases
  /** Starts an agent block; the bridge has already checked any limit. */
  run: (target: string) => Promise<RunRequestResult>
  /** `fills`: the page is laid out by its viewport, so the page chooses its height. */
  onResize?: (height: number, fills?: boolean) => void
  onSelection?: (selection: AppSelection) => void
  /** The frame's code threw and nothing caught it. */
  onError?: (error: FrameError) => void
  /** A static copy of the frame, unsanitized: snapshots.ts cleans it before showing it. */
  onSnapshot?: (html: string, outline?: string) => void
  /** The page's conversation, where questions asked from inside the App go. */
  dossier?: AppDossier
  /** Writes a model trace as a Rerun recording. Absent where no Theorem backend is reached. */
  recording?: (trace: ModelTrace) => Promise<Uint8Array>
  /** Keeps the App's runs and results durably. Absent where no Theorem backend is reached. */
  artifacts?: AppArtifacts
  /** Capability instances a sandboxed module was allowed. Absent: every capability call is denied. */
  capability?: AppCapabilities
}

/**
 * The durable store an App's runs and results reach (theorem/app-artifacts.ts):
 * the host names the revision running as the source of a run that names none.
 */
export interface AppArtifacts {
  record: (
    run: Record<string, unknown>,
    domain: string,
    observations: Array<ArtifactObservation>,
  ) => Promise<{ through: string | null; source: unknown }>
  result: (result: Record<string, unknown>, bytes: Uint8Array) => Promise<{ id: string }>
  resolve: (subject: Record<string, unknown>) => Promise<ArtifactResolution>
  /** The revision running, as a result computed now names its source. */
  source: () => unknown
  /** A kept result and its bytes, checked against their digests. */
  open: (id: string) => Promise<{ result: unknown; bytes: Uint8Array }>
  /** A kept run with every moment it holds, checked against its chunks and digests. */
  run: (id: string) => Promise<ReopenedRun>
}

/** The most bytes one App result carries across the bridge; the store's blob bound. */
export const MAX_ARTIFACT_BYTES = 1024 * 1024

/** The page's one conversation, as an App's questions and their replies reach it. */
export interface AppDossier {
  ask: (text: string, context: DossierContext) => Promise<void>
  /** The App's part of the conversation now. */
  state: () => DossierState
  subscribe: (listener: (state: DossierState) => void) => () => void
  /** Opens the App's source where `name` is written; false when it is not. */
  source: (name: string) => boolean
}

/** The longest question an App may put to the conversation, in characters. */
export const MAX_DOSSIER_QUESTION = 4000

/** A call a block made that its declarations do not allow. */
export class BridgeDenied extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BridgeDenied'
  }
}

/**
 * A workspace path a block may name: relative, forward slashes, no `.` or
 * `..` segments, nothing hidden (the folder's `.theorem` and dotfiles).
 */
export function checkPath(path: string): string {
  const segments = path.split('/')
  if (
    !path ||
    path.includes('\\') ||
    path.includes('\0') ||
    segments.some((segment) => !segment || segment.startsWith('.'))
  )
    throw new BridgeDenied(`"${path}" is not a path inside the folder`)
  return path
}

const name = z.string().min(1).max(200)
/** The most a view's selection state may be, as JSON, so a reference to it stays small. */
const MAX_SELECTION_STATE = 4096

const params = {
  read: z.object({
    path: z.string(),
    as: z.enum(['text', 'json', 'csv', 'bytes']),
  }),
  list: z.object({ glob: z.string().min(1) }),
  write: z.object({ path: z.string(), text: z.string() }),
  open: z.object({ name }),
  set: z.object({ name, key: z.string().min(1), value: z.json() }),
  remove: z.object({ name, key: z.string().min(1) }),
  run: z.object({ target: z.string() }),
  db: z.object({
    name,
    method: z.enum([...DB_READS, 'mutate']),
    args: z.json().optional(),
  }),
  subscribe: z.object({
    name,
    id: z.number().int().nonnegative(),
    method: z.enum(DB_READS),
    args: z.json().optional(),
  }),
  unsubscribe: z.object({ id: z.number().int().nonnegative() }),
  error: z.object({
    message: z.string().max(2000),
    name: z.string().max(200).optional(),
    line: z.number().int().nonnegative().optional(),
    column: z.number().int().nonnegative().optional(),
    stack: z.string().max(8000).optional(),
  }),
  resize: z.object({
    height: z.number().finite().nonnegative(),
    fills: z.boolean().optional(),
  }),
  selection: z.object({
    text: z.string().max(4096),
    rowId: z.string().max(200).optional(),
    field: z.string().max(200).optional(),
    entityId: z.string().max(200).optional(),
    entityLabel: z.string().max(200).optional(),
    cellId: z.string().max(200).optional(),
    source: z.string().max(300).optional(),
    ids: z.array(z.string().max(200)).max(200).optional(),
    state: z
      .record(z.string(), z.json())
      .refine((state) => JSON.stringify(state).length <= MAX_SELECTION_STATE, {
        message: `A view's state is at most ${MAX_SELECTION_STATE} characters`,
      })
      .optional(),
  }),
  ask: z.object({
    text: z.string().trim().min(1).max(MAX_DOSSIER_QUESTION),
    context: z.record(z.string(), z.json()),
  }),
  source: z.object({ name: z.string().min(1).max(200) }),
  record: z.strictObject({
    run: z.record(z.string(), z.json()),
    domain: z.string().trim().min(1).max(200),
    observations: z
      .array(
        z.strictObject({
          index: z.string().regex(/^(0|[1-9][0-9]{0,19})$/),
          time: z.string().regex(/^(0|[1-9][0-9]{0,19})$/),
          stateDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
          state: z.string().max(MAX_ARTIFACT_BYTES).optional(),
        }),
      )
      .min(1)
      .max(4096),
  }),
  result: z.strictObject({
    result: z.record(z.string(), z.json()),
    bytes: z.instanceof(Uint8Array).refine((bytes) => bytes.length > 0 && bytes.length <= MAX_ARTIFACT_BYTES, {
      message: `A result's bytes are 1 to ${MAX_ARTIFACT_BYTES} bytes.`,
    }),
  }),
  resolve: z.strictObject({ subject: z.record(z.string(), z.json()) }),
  openResult: z.strictObject({ id: z.string().regex(/^sha256:[0-9a-f]{64}$/) }),
  openRun: z.strictObject({ id: z.string().min(1).max(256) }),
  trace: z.strictObject({
    recordingId: z.string().trim().min(1).max(200),
    frames: z.array(
      z.strictObject({
        cycle: z.number().int(),
        cause: z.string().max(2000),
        values: z.record(
          z.string().max(400),
          z.record(z.string().max(200), z.union([z.number().finite(), z.string().max(4000)])),
        ),
      }),
    ),
    layout: z
      .strictObject({
        plots: z
          .array(
            z.strictObject({
              title: z.string().max(200),
              ports: z.array(z.strictObject({ part: z.string().max(400), port: z.string().max(200) })).max(64),
            }),
          )
          .max(24)
          .optional(),
      })
      .optional(),
  }),
  capabilityDescribe: z.strictObject({ instanceId: name }),
  capabilityQuery: z.strictObject({
    instanceId: name,
    viewKey: name.optional(),
    query: z.record(z.string(), z.json()).optional(),
    cursor: z.string().min(1).max(4096).optional(),
    limit: z.number().int().positive().optional(),
  }),
  capabilityInvoke: z.strictObject({
    instanceId: name,
    actionKey: name,
    inputs: z.record(z.string(), z.json()),
    recordId: name.optional(),
    expectedRevision: z.number().int().nonnegative().optional(),
    invocationKey: name.optional(),
  }),
  snapshot: z.object({
    html: z.string().max(MAX_SNAPSHOT),
    // What is on the page by role and name. Longer than the limit is dropped,
    // not refused: the copy is still good.
    outline: z.string().optional(),
  }),
}

/** The most reads one frame may keep subscribed. */
const MAX_DB_SUBSCRIPTIONS = 64

/** The tallest a block frame may ask to be, in CSS pixels. */
const MAX_HEIGHT = 20_000

function matcher(globs: Array<string>): (path: string) => boolean {
  if (!globs.length) return () => false
  const test = picomatch(globs, { dot: false })
  return (path) => test(path)
}

/** A file's bytes as a block asked for them: text, JSON, CSV rows or bytes. */
export function decodeFile(bytes: Uint8Array, as: FileFormat): unknown {
  if (as === 'bytes') return bytes
  const text = new TextDecoder().decode(bytes)
  if (as === 'text') return text
  if (as === 'json') return JSON.parse(text) as unknown
  // A plain array: d3-dsv's `columns` property does not survive cloning.
  return [...csvParse(text, autoType)]
}

/**
 * The capabilities the host lends, for one call. A module reaches a capability
 * only through the host, and only where its manifest declared the instance
 * (and the action) and the person allowed it; any other call is refused.
 */
function lentCapability(
  host: BridgeHost,
  instanceId: string,
  method: CapabilityMethod,
  actionKey?: string,
) {
  const lent = host.capability
  const scope = lent?.scope.find((one) => one.instanceId === instanceId)
  if (!lent || !scope)
    throw new BridgeDenied(
      `capability("${instanceId}") is not among the capability instances this module was allowed`,
    )
  if (!scope.methods.includes(method))
    throw new BridgeDenied(
      `capability.${method} on "${instanceId}" was not allowed`,
    )
  if (actionKey !== undefined && !scope.actions.includes(actionKey))
    throw new BridgeDenied(
      `the action "${actionKey}" of "${instanceId}" is not among the actions this module was allowed`,
    )
  return lent
}

/** A capability call as the frame is answered: its value, or the refusal it met. */
async function capabilityOutcome(
  reach: () => Promise<unknown>,
): Promise<CapabilityOutcome> {
  try {
    return { ok: true, value: await reach() }
  } catch (error) {
    return { ok: false, error: capabilityFailure(error) }
  }
}

/**
 * Serves the page side of one block's bridge. Every call is parsed, and
 * checked against the person's limit when they set one, before it touches
 * the folder.
 * Returns a function that stops the state subscriptions it opened.
 */
export function serveBridge(rpc: Rpc, host: BridgeHost): () => void {
  serve<PageMethods, 'frame.selection'>(rpc, 'frame.selection', (raw) => {
    host.onSelection?.(params.selection.parse(raw))
    return null
  })
  const { capabilities } = host
  const any = () => true
  const mayRead = capabilities ? matcher(capabilities.read) : any
  const mayWrite = capabilities ? matcher(capabilities.write) : any
  const subscriptions = new Map<string, () => void>()

  const collection = (value: string) => {
    if (capabilities && !capabilities.state.includes(value))
      throw new BridgeDenied(
        `state("${value}") is not among the collections this module was allowed`,
      )
    return value
  }

  serve<PageMethods, 'files.read'>(rpc, 'files.read', async (raw) => {
    const { path, as } = params.read.parse(raw)
    if (!mayRead(checkPath(path)))
      throw new BridgeDenied(
        `files.read("${path}") is not among the files this module was allowed`,
      )
    const { bytes } = await host.client.read(path)
    return decodeFile(bytes, as)
  })

  serve<PageMethods, 'files.list'>(rpc, 'files.list', async (raw) => {
    const { glob } = params.list.parse(raw)
    const requested = picomatch(glob, { dot: false })
    const entries = await host.client.tree()
    return entries
      .filter(
        (entry) =>
          entry.kind === 'file' && requested(entry.path) && mayRead(entry.path),
      )
      .map(({ path, size, mtimeMs }): ListedFile => ({ path, size, mtimeMs }))
  })

  serve<PageMethods, 'files.write'>(rpc, 'files.write', async (raw) => {
    const { path, text } = params.write.parse(raw)
    if (!mayWrite(checkPath(path)))
      throw new BridgeDenied(
        `files.write("${path}") is not among the files this module was allowed`,
      )
    return host.client.write(path, text)
  })

  serve<PageMethods, 'state.open'>(rpc, 'state.open', (raw) => {
    const value = collection(params.open.parse(raw).name)
    if (!subscriptions.has(value))
      subscriptions.set(
        value,
        host.state.subscribe(value, (snapshot) => {
          void call<SandboxMethods, 'state.changed'>(rpc, 'state.changed', {
            name: value,
            value: snapshot,
          }).catch(() => {})
        }),
      )
    return host.state.snapshot(value)
  })

  serve<PageMethods, 'state.set'>(rpc, 'state.set', async (raw) => {
    const { name: value, key, value: item } = params.set.parse(raw)
    await host.state.set(collection(value), key, item)
    return null
  })

  serve<PageMethods, 'state.delete'>(rpc, 'state.delete', async (raw) => {
    const { name: value, key } = params.remove.parse(raw)
    await host.state.delete(collection(value), key)
    return null
  })

  const reads = new Map<number, () => void>()
  const database = (value: string): AppDatabases => {
    if (capabilities && !capabilities.db.includes(value))
      throw new BridgeDenied(
        `db("${value}") is not among the databases this module was allowed`,
      )
    if (!host.db)
      throw new BridgeDenied('Databases are not available to this block.')
    return host.db
  }

  serve<PageMethods, 'db.call'>(rpc, 'db.call', async (raw) => {
    const { name: value, method, args } = params.db.parse(raw)
    const databases = database(value)
    try {
      const result = await databases.call(value, method, args ?? null)
      return { ok: true, value: result } satisfies DbOutcome
    } catch (error) {
      return { ok: false, error: dbFailure(error) } satisfies DbOutcome
    }
  })

  serve<PageMethods, 'db.subscribe'>(rpc, 'db.subscribe', (raw) => {
    const { name: value, id, method, args } = params.subscribe.parse(raw)
    const databases = database(value)
    if (reads.has(id)) throw new BridgeDenied(`subscription ${id} is in use`)
    if (reads.size >= MAX_DB_SUBSCRIPTIONS)
      throw new BridgeDenied(
        `A block keeps at most ${MAX_DB_SUBSCRIPTIONS} reads subscribed.`,
      )
    const tell = (outcome: DbOutcome) => {
      void call<SandboxMethods, 'db.changed'>(rpc, 'db.changed', {
        id,
        outcome,
      }).catch(() => {})
    }
    reads.set(
      id,
      databases.subscribe(
        value,
        { method, args: args ?? null },
        (result) => tell({ ok: true, value: result }),
        (failure) => tell({ ok: false, error: failure }),
      ),
    )
    return null
  })

  serve<PageMethods, 'db.unsubscribe'>(rpc, 'db.unsubscribe', (raw) => {
    const { id } = params.unsubscribe.parse(raw)
    reads.get(id)?.()
    reads.delete(id)
    return null
  })

  serve<PageMethods, 'run.request'>(rpc, 'run.request', (raw) => {
    const { target } = params.run.parse(raw)
    if (capabilities && !capabilities.run.includes(target))
      throw new BridgeDenied(
        `run("${target}") is not among the runs this module was allowed`,
      )
    return host.run(target)
  })

  serve<PageMethods, 'frame.error'>(rpc, 'frame.error', (raw) => {
    host.onError?.(params.error.parse(raw))
    return null
  })

  serve<PageMethods, 'frame.resize'>(rpc, 'frame.resize', (raw) => {
    const { height, fills } = params.resize.parse(raw)
    host.onResize?.(Math.min(height, MAX_HEIGHT), fills)
    return null
  })

  serve<PageMethods, 'frame.snapshot'>(rpc, 'frame.snapshot', (raw) => {
    const { html, outline } = params.snapshot.parse(raw)
    host.onSnapshot?.(
      html,
      outline !== undefined && outline.length <= MAX_OUTLINE
        ? outline
        : undefined,
    )
    return null
  })

  const dossier = () => {
    if (!host.dossier)
      throw new BridgeDenied('This App is not shown in a conversation.')
    return host.dossier
  }
  let watching: (() => void) | undefined
  serve<PageMethods, 'dossier.ask'>(rpc, 'dossier.ask', async (raw) => {
    const { text, context } = params.ask.parse(raw)
    await dossier().ask(text, context)
    return null
  })
  serve<PageMethods, 'dossier.watch'>(rpc, 'dossier.watch', () => {
    if (!host.dossier)
      return { available: false, running: false, messages: [] } satisfies DossierState
    watching ??= host.dossier.subscribe((state) => {
      void call<SandboxMethods, 'dossier.changed'>(rpc, 'dossier.changed', state).catch(() => {})
    })
    return host.dossier.state()
  })
  serve<PageMethods, 'dossier.source'>(rpc, 'dossier.source', (raw) => ({
    found: dossier().source(params.source.parse(raw).name),
  }))

  const artifacts = () => {
    if (!host.artifacts)
      throw new BridgeDenied('This App is shown where no Theorem backend keeps runs or results.')
    return host.artifacts
  }
  serve<PageMethods, 'artifacts.record'>(rpc, 'artifacts.record', async (raw) => {
    const { run, domain, observations } = params.record.parse(raw)
    return artifacts().record(run, domain, observations)
  })
  serve<PageMethods, 'artifacts.result'>(rpc, 'artifacts.result', async (raw) => {
    const { result, bytes } = params.result.parse(raw)
    return artifacts().result(result, bytes)
  })
  serve<PageMethods, 'artifacts.resolve'>(rpc, 'artifacts.resolve', async (raw) =>
    artifacts().resolve(params.resolve.parse(raw).subject),
  )
  serve<PageMethods, 'artifacts.source'>(rpc, 'artifacts.source', () => artifacts().source())
  serve<PageMethods, 'artifacts.open'>(rpc, 'artifacts.open', async (raw) =>
    artifacts().open(params.openResult.parse(raw).id),
  )
  serve<PageMethods, 'artifacts.run'>(rpc, 'artifacts.run', async (raw) =>
    artifacts().run(params.openRun.parse(raw).id),
  )

  serve<PageMethods, 'capability.describe'>(rpc, 'capability.describe', (raw) => {
    const { instanceId } = params.capabilityDescribe.parse(raw)
    const lent = lentCapability(host, instanceId, 'describe')
    return capabilityOutcome(() => lent.describe(instanceId))
  })
  serve<PageMethods, 'capability.query'>(rpc, 'capability.query', (raw) => {
    const request = params.capabilityQuery.parse(raw)
    const lent = lentCapability(host, request.instanceId, 'query')
    return capabilityOutcome(() => lent.query(request))
  })
  serve<PageMethods, 'capability.invoke'>(rpc, 'capability.invoke', (raw) => {
    const request = params.capabilityInvoke.parse(raw)
    const lent = lentCapability(
      host,
      request.instanceId,
      'invoke',
      request.actionKey,
    )
    return capabilityOutcome(() => lent.invoke(request))
  })

  serve<PageMethods, 'trace.recording'>(rpc, 'trace.recording', async (raw) => {
    if (!host.recording)
      throw new BridgeDenied('This App is shown where no Theorem backend writes recordings.')
    return host.recording(params.trace.parse(raw))
  })

  return () => {
    watching?.()
    for (const unsubscribe of subscriptions.values()) unsubscribe()
    subscriptions.clear()
    for (const stop of reads.values()) stop()
    reads.clear()
  }
}
