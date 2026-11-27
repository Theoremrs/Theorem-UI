// SOURCING: json-rpc-2.0 (requests, responses and notifications both ways over
// one MessagePort). The method tables are this app's capability bridge (plan
// D9). Values cross by structured clone, the way postMessage sends them.
//
// Everything under sandbox/ runs inside a block's sandbox document as well as
// in the page, so it imports only its own files and the specifiers in the
// block import map (react, react-dom/client, json-rpc-2.0, object-inspect).
import {
  JSONRPCClient,
  JSONRPCServer,
  JSONRPCServerAndClient,
} from 'json-rpc-2.0'
import type { AppTheme, ThemeState } from './theme'

/** How a file is read: its text, parsed JSON, CSV rows, or its bytes. */
export type FileFormat = 'text' | 'json' | 'csv' | 'bytes'

export interface ListedFile {
  path: string
  size: number
  mtimeMs: number
}

/** A run the page asked an agent block for. Agents are wired in plan Phase 5. */
export interface RunRequestResult {
  status: 'not-wired' | 'queued'
  target: string
  message: string
}

/** One value recorded while a block ran, for last-run values. */
export interface Trace {
  line: number
  /** The variables a declaration on this line set, or null for an expression. */
  variables: Record<string, unknown> | null
  value?: unknown
}

/** What one run of a block produced. Every value has been made clonable. */
export interface RunOutcome {
  status: 'ok' | 'error'
  value?: unknown
  error?: { message: string; name: string }
  traces: Array<Trace>
  displayed: number
  durationMs: number
}

export interface AppSelection {
  text: string
  rowId?: string
  field?: string
  /** The nearest `[data-entity-id]` the person selected or clicked, such as one GPU lane. */
  entityId?: string
  entityLabel?: string
  /** The notebook cell (`[data-cell-id]`) the selection or click is in. */
  cellId?: string
  /**
   * Where the element was written, `Table.tsx:21:13`, in an App built from
   * source: the nearest `[data-theorem-source]`.
   */
  source?: string
  /**
   * What a view named of its own selection with `theorem.select`: the records
   * chosen by id, and the view's state (a brush's extent, a focused node, the
   * parameters moved off the values the reply assumed).
   */
  ids?: Array<string>
  state?: Record<string, unknown>
}

/** The reads a database answers. A subscription keeps one of them current. */
export const DB_READS = [
  'inspect',
  'getNode',
  'getEdge',
  'queryNodes',
  'neighbors',
  'query',
] as const
export type DbRead = (typeof DB_READS)[number]
export type DbMethod = DbRead | 'mutate'

/** A database failure. `code` is the database's own, such as `cypher_write_unsupported`. */
export interface DbFailure {
  code: string
  message: string
}

/** A database call's outcome. A failure is a value, so its code crosses the bridge. */
export type DbOutcome =
  { ok: true; value: unknown } | { ok: false; error: DbFailure }

/** What a module may do on a capability instance it was allowed. */
export type CapabilityMethod = 'describe' | 'query' | 'invoke'

/** A capability's refusal: its own code, such as `capability_precondition_failed`. */
export interface CapabilityFailure {
  code: string
  message: string
}

/** A capability call's outcome. A refusal is a value, so its code crosses the bridge. */
export type CapabilityOutcome =
  { ok: true; value: unknown } | { ok: false; error: CapabilityFailure }

/** One page of an instance's view, or an ad-hoc query over one of its collections. */
export interface CapabilityQueryParams {
  instanceId: string
  viewKey?: string
  query?: Record<string, unknown>
  cursor?: string
  limit?: number
}

/** One declared action, run by the host as the person who granted it. */
export interface CapabilityInvokeParams {
  instanceId: string
  actionKey: string
  inputs: Record<string, unknown>
  recordId?: string
  expectedRevision?: number
  /** The frame's own key for one intended call, so a retry it makes runs once. */
  invocationKey?: string
}

/** Something a frame's code threw and nothing caught, as the frame saw it. */
export interface FrameError {
  message: string
  /** The error's class, such as `TypeError`. */
  name?: string
  /** Where the frame's document says it was thrown, one-based. */
  line?: number
  column?: number
  stack?: string
}

/** The most uncaught errors one load of a frame reports. */
export const MAX_FRAME_ERRORS = 20

/** How one notebook cell first settled: its value shown, or its failure shown. */
export interface CellStatus {
  cell: string
  stage: 'ready' | 'failed'
  /** Why a failed cell failed, as its inspector shows it. */
  error?: string
  /**
   * What a ready cell shows: its value as the inspector shows it collapsed,
   * each name it defines with its value, or an element's labelled parts.
   */
  shows?: string
}

/** The longest failure a cell status carries. */
export const MAX_CELL_ERROR = 2000

/** The longest description of what a cell shows. */
export const MAX_CELL_SHOWS = 300

/** The event a notebook's runtime dispatches in its frame as each cell first settles. */
export const CELL_STATUS_EVENT = 'theorem:cell-status'

/** The most cell statuses one load of a frame reports. */
export const MAX_CELL_STATUSES = 200

/** Methods the page serves; the sandbox calls them, and the page checks each call. */
export interface PageMethods {
  'files.read': {
    params: { path: string; as: FileFormat }
    result: unknown
  }
  'files.list': { params: { glob: string }; result: Array<ListedFile> }
  'files.write': {
    params: { path: string; text: string }
    result: { hash: string }
  }
  'state.open': {
    params: { name: string }
    result: Record<string, unknown>
  }
  'state.set': {
    params: { name: string; key: string; value: unknown }
    result: null
  }
  'state.delete': { params: { name: string; key: string }; result: null }
  'run.request': { params: { target: string }; result: RunRequestResult }
  /** One call on a declared database. `args` is the method's own argument. */
  'db.call': {
    params: { name: string; method: DbMethod; args?: unknown }
    result: DbOutcome
  }
  /** Keeps a read current; its results arrive as `db.changed` with this id. */
  'db.subscribe': {
    params: { name: string; id: number; method: DbRead; args?: unknown }
    result: null
  }
  'db.unsubscribe': { params: { id: number }; result: null }
  'frame.selection': { params: AppSelection; result: null }
  /** The frame's code threw and nothing caught it. */
  'frame.error': { params: FrameError; result: null }
  /** A notebook cell first showed its value or its failure. */
  'frame.status': { params: CellStatus; result: null }
  /** `fills`: the page is laid out by its viewport and has no height of its own. */
  'frame.resize': { params: { height: number; fills?: boolean }; result: null }
  /** A static copy of the frame, for where a live frame would cost too much. */
  'frame.snapshot': {
    params: { html: string; outline?: string }
    result: null
  }
  /**
   * A capability instance's definition and the person's grant, read by the
   * host with its own session: only an instance the module declared and the
   * person allowed.
   */
  'capability.describe': { params: { instanceId: string }; result: CapabilityOutcome }
  /** Records of an allowed instance, read by the host. */
  'capability.query': { params: CapabilityQueryParams; result: CapabilityOutcome }
  /** One of an allowed instance's allowed actions, run by the host. */
  'capability.invoke': { params: CapabilityInvokeParams; result: CapabilityOutcome }
  /** A page module publishing one of its declared outputs. */
  'module.output': { params: { name: string; value: unknown }; result: null }
  /** A person used a page module's frame: its next events are theirs. */
  'module.used': { params: Record<string, never>; result: null }
  /** A page module sending one of its declared events. */
  'module.emit': { params: { name: string; payload: unknown }; result: null }
  /**
   * A question about the App, put to the page's conversation with the App's
   * revision and `context`: what the App says is selected, its inputs and
   * outputs, the step it is on, what can be done there.
   */
  'dossier.ask': { params: { text: string; context: DossierContext }; result: null }
  /** The App's part of the conversation now; `dossier.changed` follows it. */
  'dossier.watch': { params: Record<string, never>; result: DossierState }
  /** Opens the App's source where `name` is written, for a person to read or edit. */
  'dossier.source': { params: { name: string }; result: { found: boolean } }
  /** A model trace written as a Rerun recording (`.rrd` bytes), for Rerun's viewer. */
  'trace.recording': { params: ModelTrace; result: Uint8Array }
  /**
   * A run's next observations, kept durably for this person: the run (a
   * `@theorem/runtime` RunRef) is recorded with its first observations, and
   * each call continues exactly where the last ended. `through` is the last
   * index stored; `source` is the revision the stored run names, which a
   * question about one of its moments names too.
   */
  'artifacts.record': {
    params: { run: unknown; domain: string; observations: Array<ArtifactObservation> }
    result: { through: string | null; source: unknown }
  }
  /** A result the App produced (a ResultRef), kept durably with its bytes. */
  'artifacts.result': { params: { result: unknown; bytes: Uint8Array }; result: { id: string } }
  /** Whether a subject (a SubjectRef) is held durably, exactly; never the latest instead. */
  'artifacts.resolve': { params: { subject: unknown }; result: ArtifactResolution }
  /** The revision running (an ArtifactSourceRef), for a result computed now to name. */
  'artifacts.source': { params: Record<string, never>; result: unknown }
  /** A kept result (a ResultRef) by id, with its bytes, both checked against their digests. */
  'artifacts.open': { params: { id: string }; result: { result: unknown; bytes: Uint8Array } }
  /**
   * A kept run (a RunRef) by id, with every moment it holds in order from
   * index 0 and its checkpoints; each moment is checked against its stored
   * chunk, and a kept state against its digest.
   */
  'artifacts.run': { params: { id: string }; result: ReopenedRun }
}

/** A kept run as it is read back, from this or any other conversation or App. */
export interface ReopenedRun {
  run: unknown
  observations: Array<ArtifactObservation & { domain: string }>
  checkpoints: Array<unknown>
}

/** One observation of a run as it is kept: its place, its time and its state's digest. */
export interface ArtifactObservation {
  index: string
  time: string
  stateDigest: string
  /**
   * The state `stateDigest` is the SHA-256 of, as its canonical JSON text
   * (`@theorem/runtime` canonicalJson). Kept with the observation, so the
   * moment can be read back once the App is closed; refused when it is not
   * the state the digest names.
   */
  state?: string
}

/** Whether a subject is held durably, and if not, why. */
export type ArtifactResolution =
  | { status: 'available' }
  | { status: 'unavailable'; reason: string }

/** A primitive value a model trace records: a number or text. */
export type TraceValue = number | string

/** What one settle of an App's model produced. */
export interface TraceFrame {
  cycle: number
  /** What caused it, such as `step` or `regb.value = 3`. */
  cause: string
  /** Port values by part path, then port name. */
  values: Record<string, Record<string, TraceValue>>
}

/** An App's model run, cycle by cycle, as Rerun's SDK is asked to write it. */
export interface ModelTrace {
  /** The App's choice: a run it shows again under a new id is a new recording. */
  recordingId: string
  frames: Array<TraceFrame>
  /** Sent when a recording opens: the viewer's layout. Without plots, one per top-level part. */
  layout?: { plots?: Array<TracePlot> }
}

/** One time series in the viewer: ports of parts, or state keys under `<part>/state`. */
export interface TracePlot {
  title: string
  ports: Array<{ part: string; port: string }>
}

/** What an App says about where the person is, for a question about it. JSON. */
export type DossierContext = Record<string, unknown>

/** One message of the App's part of the page's conversation. */
export interface DossierMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  status: 'running' | 'complete' | 'incomplete'
  /**
   * What the question was asked about (`@theorem/runtime`'s SubjectRef: a
   * source, a result or a run moment); a reply carries its question's. JSON,
   * read with readSubjectRef.
   */
  subject?: unknown
  /** Held until the conversation's current turn ends, so asking does not stop it. */
  queued?: boolean
  /** Why a held question could not be sent; it stays shown, not dropped. */
  undelivered?: string
}

/**
 * The questions asked from an App and the replies to them, in the page's one
 * conversation. Not `available` where the App is shown outside a conversation.
 */
export interface DossierState {
  available: boolean
  running: boolean
  messages: Array<DossierMessage>
}

/** What a page module is handed: its settings and its inputs' values. */
export interface ModuleValues {
  settings: Record<string, unknown>
  inputs: Record<string, unknown>
}

/** The largest snapshot a frame may send, in characters. */
export const MAX_SNAPSHOT = 512 * 1024

/** The largest outline of a page a frame may send, in characters. */
export const MAX_OUTLINE = 128 * 1024

/** Where a frame is shown: in a reply, in the side panel, or expanded over the page. */
export type PresentationMode = 'inline' | 'panel' | 'expanded'

/** A frame's presentation: where it is shown and the CSS pixels it has to fill. */
export interface Presentation {
  mode: PresentationMode
  width: number
  /** The height it may fill without the page scrolling past it. */
  height: number
}

/** What a control is, as the agent reads it. */
export type ControlKind = 'number' | 'boolean' | 'choice' | 'text' | 'action'

/** A control an App named for the agent, and its value now. */
export interface ControlState {
  name: string
  label: string
  kind: ControlKind
  value?: unknown
  min?: number
  max?: number
  step?: number
  /** A choice's values. */
  options?: Array<string>
  disabled?: boolean
}

/** What the agent asks of a control: a new value, or a press. */
export interface ControlAct {
  name: string
  action: 'set' | 'invoke'
  value?: unknown
}

/** Methods the sandbox serves; the page calls them. */
export interface SandboxMethods {
  'cell.run': {
    params: { runId: number; inputs: Record<string, unknown> }
    result: RunOutcome
  }
  'state.changed': {
    params: { name: string; value: Record<string, unknown> }
    result: null
  }
  /** A subscribed read's result, now and after each commit that changes it. */
  'db.changed': { params: { id: number; outcome: DbOutcome }; result: null }
  /** A page module's settings or inputs changed. */
  'module.inputs': { params: ModuleValues; result: null }
  /** A route reached one of a page module's declared actions. */
  'module.action': { params: { name: string; payload: unknown }; result: null }
  /** The App's part of the conversation changed, after `dossier.watch`. */
  'dossier.changed': { params: DossierState; result: null }
  /**
   * The page's theme changed. A notebook's frame is handed its tokens,
   * resolved, and its mode, for its root; a hosted App's is handed its look
   * (`scheme` tells them apart), for the host stylesheet under the App's own.
   */
  'theme.changed': { params: ThemeState | AppTheme; result: null }
  /** Where the frame is shown and the room it has, now and when either changes. */
  'presentation.changed': { params: Presentation; result: null }
  /** The controls the App named for the agent, each with its value now. */
  'controls.list': { params: Record<string, never>; result: Array<ControlState> }
  /**
   * Sets a named control or presses it, through the same function the visible
   * control calls, then reads it back once the App has drawn the change.
   */
  'controls.act': { params: ControlAct; result: ControlState }
  /**
   * The frame as it is now, without waiting for it to settle: what a snapshot
   * holds. Null when the copy is too large to send.
   */
  'frame.look': {
    params: Record<string, never>
    result: { html: string; outline: string; page?: PageAttributes } | null
  }
  /**
   * Live DOM measurements, validated by the host before evaluation: in the
   * scheme the frame was last handed, with `canvas` the colour the page
   * paints behind it.
   */
  'frame.design': {
    params: { captureId: string; scheme?: 'light' | 'dark'; canvas?: string }
    result: unknown
  }
}

/**
 * The attributes on a frame's root and body that its CSS reads: a snapshot is
 * the body's contents, and what styles them may be a class or a style on the
 * elements above.
 */
export interface PageAttributes {
  root: Record<string, string>
  body: Record<string, string>
  /**
   * The body's background colour, where the root has none. A browser paints
   * that behind the whole page and not in the body's box, so a copy has to be
   * told. Absent where the root has its own or neither has one.
   */
  background?: string
}

/** What a computed colour looks like; nothing else is drawn with. */
export const PAGE_BACKGROUND =
  /^(?:rgba?|color|oklch|oklab|lab|lch|hsla?)\([\w\s.,%/+-]{1,80}\)$/

/** The attributes carried: what CSS can select on or read, and nothing that runs. */
export const PAGE_ATTRIBUTE = /^(?:class|style|dir|lang|data-[\w-]{1,64})$/
/** A computed colour that paints nothing. */
export const TRANSPARENT = /^(?:transparent|rgba\(0, 0, 0, 0\))$/
/** The most text one page's carried attributes are, all together. */
export const MAX_PAGE_ATTRIBUTES = 32 * 1024

/** Something that carries messages: a MessagePort, a Worker or a worker's global scope. */
export interface MessageCarrier {
  postMessage: (message: unknown) => void
  onmessage: ((event: MessageEvent) => unknown) | null
}

export type Rpc = JSONRPCServerAndClient

/** A JSON-RPC peer over a message carrier: it serves methods and calls the other side's. */
export function rpcOver(carrier: MessageCarrier): Rpc {
  const rpc = new JSONRPCServerAndClient(
    // A refused call goes back to the caller as an error response; it is not
    // this side's error to log.
    new JSONRPCServer({ errorListener: () => {} }),
    new JSONRPCClient((request) => {
      carrier.postMessage(request)
    }),
  )
  carrier.onmessage = (event: MessageEvent) => {
    void rpc.receiveAndSend(event.data, undefined, undefined)
  }
  ;(carrier as Partial<MessagePort>).start?.()
  return rpc
}

/** A table of methods, each with its params and result. */
type MethodTable<TTable> = {
  [TMethod in keyof TTable]: { params: object; result: unknown }
}

/** Calls a method on the other side, typed by its table. */
export function call<
  TTable extends MethodTable<TTable>,
  TMethod extends keyof TTable & string,
>(
  rpc: Rpc,
  method: TMethod,
  params: TTable[TMethod]['params'],
): Promise<TTable[TMethod]['result']> {
  return Promise.resolve(
    rpc.request(method, params, undefined) as PromiseLike<
      TTable[TMethod]['result']
    >,
  )
}

/** Serves a method to the other side, typed by its table. */
export function serve<
  TTable extends MethodTable<TTable>,
  TMethod extends keyof TTable & string,
>(
  rpc: Rpc,
  method: TMethod,
  handler: (
    params: TTable[TMethod]['params'],
  ) => TTable[TMethod]['result'] | Promise<TTable[TMethod]['result']>,
): void {
  rpc.addMethod(method, (params) =>
    handler(params as TTable[TMethod]['params']),
  )
}

/** The messages that hand a sandbox document its port. */
export const READY_MESSAGE = 'theorem:block-ready'
export const CONNECT_MESSAGE = 'theorem:block-connect'
