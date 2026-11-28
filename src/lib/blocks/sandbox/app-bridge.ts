// SOURCING: the modules beside it; the script the block listener adds to an
// HTML app's pages (served at /__runtime/app-bridge). It gives the app
// `window.theorem`: the same declared files, state and run calls a cell has,
// and the graph databases it declared.
// On a page, an app placed as a module also gets `theorem.module`: the values
// it is handed, the actions routes reach, and the outputs and events it
// declared. The host stylesheet ahead of the app's content follows the page's
// look as the page sends it (theme.ts).
import { CellContext } from './cell'
import { connectToPage } from './connect'
import { actOnControl, listControls, registerControl } from './controls'
import type { ControlSpec } from './controls'
import { Databases } from './db'
import { collectDesignObservations } from './design-collector'
import {
  lookNow,
  markSelectedCell,
  observeHeight,
  observeSnapshots,
} from './display'
import { CELL_STATUS_EVENT, MAX_CELL_ERROR, MAX_CELL_SHOWS, MAX_CELL_STATUSES, MAX_FRAME_ERRORS, call, rpcOver, serve } from './protocol'
import type {
  ArtifactObservation,
  CapabilityInvokeParams,
  CapabilityQueryParams,
  CellStatus,
  DossierContext,
  DossierState,
  FrameError,
  ModelTrace,
  ModuleValues,
  PageMethods,
  SandboxMethods,
} from './protocol'
import { applyPresentation, onPresentation, presentationNow } from './presentation'
import { THEME_EVENT, applyAppTheme, applyTheme } from './theme'

type ModuleListener = (values: ModuleValues) => void
let moduleValues: ModuleValues | undefined
const moduleListeners = new Set<ModuleListener>()
type ActionListener = (payload: unknown) => void
const actionListeners = new Map<string, Set<ActionListener>>()
type DossierListener = (state: DossierState) => void
let dossierState: DossierState | undefined
const dossierListeners = new Set<DossierListener>()
let dossierWatch: Promise<void> | undefined
const tellDossier = (state: DossierState) => {
  dossierState = state
  for (const listener of dossierListeners) listener(state)
}

/** What a view named of its selection with `theorem.select`, until it says otherwise. */
interface ViewSelection {
  label: string
  ids?: Array<string>
  state?: Record<string, unknown>
}
let chosen: ViewSelection | null = null
let reportSelection: (event?: Event) => void = () => {}

const context = connectToPage().then((port) => {
  const rpc = rpcOver(port)
  const cells = new CellContext(rpc, { show: () => {}, clear: () => {} })
  const databases = new Databases(rpc)
  serve<SandboxMethods, 'db.changed'>(rpc, 'db.changed', ({ id, outcome }) => {
    databases.changed(id, outcome)
    return null
  })
  serve<SandboxMethods, 'state.changed'>(
    rpc,
    'state.changed',
    async ({ name, value }) => {
      await cells.changed(name, value)
      return null
    },
  )
  // Served before the first message is read, so the first values are seen.
  serve<SandboxMethods, 'module.inputs'>(rpc, 'module.inputs', (values) => {
    moduleValues = values
    for (const listener of moduleListeners) listener(values)
    return null
  })
  serve<SandboxMethods, 'module.action'>(
    rpc,
    'module.action',
    ({ name, payload }) => {
      for (const listener of actionListeners.get(name) ?? []) listener(payload)
      return null
    },
  )
  serve<SandboxMethods, 'dossier.changed'>(rpc, 'dossier.changed', (state) => {
    tellDossier(state)
    return null
  })
  serve<SandboxMethods, 'theme.changed'>(rpc, 'theme.changed', (theme) => {
    if ('scheme' in theme) {
      // A hosted App's look follows into the host stylesheet, under the App's own.
      applyAppTheme(theme)
    } else {
      // The page's tokens on this document's root; CSS and cells that read them follow.
      applyTheme(theme)
      window.dispatchEvent(new Event(THEME_EVENT))
    }
    return null
  })
  serve<SandboxMethods, 'presentation.changed'>(rpc, 'presentation.changed', (presentation) => {
    applyPresentation(presentation)
    return null
  })
  serve<SandboxMethods, 'controls.list'>(rpc, 'controls.list', () => listControls())
  serve<SandboxMethods, 'controls.act'>(rpc, 'controls.act', (act) => actOnControl(act))
  // A page that never stops changing never settles into a snapshot, so the
  // page can ask for one.
  serve<SandboxMethods, 'frame.look'>(rpc, 'frame.look', () => lookNow())
  // The live document supplies layout and computed styles. A serialized
  // snapshot cannot reconstruct its font loading, line boxes or scroll sizes.
  // Measured at once, after the run: fonts still loading are reported as
  // such, and a timer here would be throttled past the host's deadline
  // whenever the person's tab is in the background.
  // A transition started by a theme change is ended first, so its colours are
  // the ones the App settles on rather than the ones it is leaving.
  serve<SandboxMethods, 'frame.design'>(
    rpc,
    'frame.design',
    ({ captureId, scheme, canvas }) => {
      for (const animation of document.getAnimations())
        if (animation instanceof CSSTransition) animation.finish()
      return collectDesignObservations({
        captureId,
        evidenceKind: 'rendered-artifact',
        maxElements: 300,
        maxNodes: 5000,
        maxTextLength: 160,
        colorScheme: scheme,
        canvas,
      })
    },
  )
  observeHeight((height, fills) => {
    void call<PageMethods, 'frame.resize'>(rpc, 'frame.resize', { height, fills })
  })
  observeSnapshots((html, outline) => {
    void call<PageMethods, 'frame.snapshot'>(rpc, 'frame.snapshot', {
      html,
      outline,
    })
  })
  const selection = (event?: Event) => {
    const selected = window.getSelection()
    const node = selected?.anchorNode
    const element = node instanceof Element ? node : node?.parentElement
    const active = document.activeElement
    const input =
      active instanceof HTMLInputElement ||
      active instanceof HTMLTextAreaElement
        ? active
        : null
    const text =
      input && input.selectionStart !== null
        ? input.value.slice(
            input.selectionStart,
            input.selectionEnd ?? input.selectionStart,
          )
        : (selected?.toString() ?? '')
    // A click on a lane or a bar selects it even when no text is selected.
    const pointed =
      event?.type === 'pointerup' && event.target instanceof Element
        ? event.target
        : null
    const target = input ?? pointed ?? element
    const entity = target?.closest('[data-entity-id]')
    const entityId = entity?.getAttribute('data-entity-id') ?? undefined
    const entityLabel =
      entity?.getAttribute('data-entity-label') ??
      entity?.getAttribute('aria-label') ??
      undefined
    const rowId =
      target?.closest('[data-row-id]')?.getAttribute('data-row-id') ?? undefined
    const field =
      target?.closest('[data-field]')?.getAttribute('data-field') ?? undefined
    // A notebook's cells are sections with an id; the one a selection names is marked.
    const cell = target?.closest('[data-cell-id]')
    markSelectedCell(cell)
    const cellId = cell?.getAttribute('data-cell-id') ?? undefined
    // In an App built from source, the element says where it was written.
    const source =
      target
        ?.closest('[data-theorem-source]')
        ?.getAttribute('data-theorem-source') ?? undefined
    // A view's own selection (a brush, a chosen node) stands until the view
    // clears it; a click inside the view does not replace it.
    void call<PageMethods, 'frame.selection'>(rpc, 'frame.selection', {
      text: text.slice(0, 4096),
      rowId: rowId?.slice(0, 200),
      field: field?.slice(0, 200),
      entityId: entityId?.slice(0, 200),
      entityLabel: (entityLabel ?? chosen?.label)?.slice(0, 200),
      cellId: cellId?.slice(0, 200),
      source: source?.slice(0, 300),
      ids: chosen?.ids?.slice(0, 200).map((id) => String(id).slice(0, 200)),
      state: chosen?.state,
    }).catch(() => {})
  }
  reportSelection = selection
  // A person's input inside the frame never reaches the page; say so, so a
  // module's next event starts its own chain.
  const used = () => {
    void call<PageMethods, 'module.used'>(rpc, 'module.used', {}).catch(
      () => {},
    )
  }
  document.addEventListener('pointerdown', used, true)
  document.addEventListener('keydown', used, true)
  // A click collapses the text selection after pointerup has reported what it
  // pointed at; only a selection with text in it is news.
  document.addEventListener('selectionchange', () => {
    if (window.getSelection()?.isCollapsed === false) selection()
  })
  document.addEventListener('pointerup', selection)
  document.addEventListener('keyup', selection)
  return { cells, databases }
})

// What the App's code throws and does not catch goes to the page, which
// knows the source it was built from. Listening starts now, before the App's
// own scripts run; the page hears once it has connected.
let reported = 0
function report(error: FrameError): void {
  if (reported++ >= MAX_FRAME_ERRORS) return
  void context
    .then(({ cells }) =>
      call<PageMethods, 'frame.error'>(cells.rpc, 'frame.error', {
        ...error,
        message: error.message.slice(0, 2000),
        name: error.name?.slice(0, 200),
        stack: error.stack?.slice(0, 8000),
      }),
    )
    .catch(() => {})
}
const thrown = (value: unknown): FrameError =>
  value instanceof Error
    ? { message: value.message, name: value.name, stack: value.stack }
    : { message: String(value) }
window.addEventListener('error', (event) => {
  // A resource that failed to load is an event with no message.
  if (!event.message && !event.error) return
  report({
    ...thrown(event.error ?? event.message),
    line: event.lineno || undefined,
    column: event.colno || undefined,
  })
})
window.addEventListener('unhandledrejection', (event) => {
  report(thrown(event.reason))
})

// How a notebook's cells first settle (notebook.ts), so the page can say
// when the first outputs are on screen and which cells failed.
let statuses = 0
window.addEventListener(CELL_STATUS_EVENT, (event) => {
  if (statuses++ >= MAX_CELL_STATUSES) return
  const { cell, stage, error, shows } = (event as CustomEvent<CellStatus>).detail
  const status: CellStatus = {
    cell: cell.slice(0, 200),
    stage,
    ...(error !== undefined && { error: error.slice(0, MAX_CELL_ERROR) }),
    ...(shows !== undefined && { shows: shows.slice(0, MAX_CELL_SHOWS) }),
  }
  void context
    .then(({ cells }) => call<PageMethods, 'frame.status'>(cells.rpc, 'frame.status', status))
    .catch(() => {})
})

const context_ = async () => (await context).cells

type Files = ReturnType<CellContext['files']>
/** One of the `files` calls, made once the page has connected: its own arguments, its own result. */
const files = <TName extends keyof Files>(name: TName): Files[TName] =>
  ((...args: Array<string>) =>
    context.then(({ cells }) =>
      (cells.files()[name] as (...a: Array<string>) => unknown)(...args),
    )) as unknown as Files[TName]

const theorem = {
  /**
   * The page's one conversation. A question asked here goes to the page's
   * agent with this App's revision and the `context` given, and its reply is
   * in the conversation like any other; `watch` follows the questions asked
   * from this App and their replies.
   */
  dossier: {
    ask: async (text: string, context: DossierContext = {}) => {
      await call<PageMethods, 'dossier.ask'>((await context_()).rpc, 'dossier.ask', { text, context })
    },
    /** Calls `listener` with the App's part of the conversation, and again when it changes. */
    watch(listener: DossierListener): () => void {
      dossierListeners.add(listener)
      if (dossierState) listener(dossierState)
      dossierWatch ??= context_()
        .then(({ rpc }) => call<PageMethods, 'dossier.watch'>(rpc, 'dossier.watch', {}))
        .then(tellDossier, () => tellDossier({ available: false, running: false, messages: [] }))
      return () => dossierListeners.delete(listener)
    },
    /** Opens this App's source where `name` is written, for the person to read. */
    source: async (name: string) =>
      (await call<PageMethods, 'dossier.source'>((await context_()).rpc, 'dossier.source', { name })).found,
  },
  /**
   * A model's run, cycle by cycle, written as a Rerun recording by Rerun's
   * own SDK: `.rrd` bytes for `LogChannel.send_rrd` in Rerun's web viewer.
   */
  trace: {
    recording: async (trace: ModelTrace) =>
      call<PageMethods, 'trace.recording'>((await context_()).rpc, 'trace.recording', trace),
  },
  /**
   * Keeps runs and results beyond this open App, for this person: a question
   * about a moment or a result can then be resolved exactly from another
   * conversation or App. Each is written once; writing it again is a no-op.
   */
  artifacts: {
    /**
     * Records a run's next observations (`@theorem/runtime`'s RunRef, then
     * observations continuing from index 0 with no gaps). A run that names no
     * source is recorded as run by this App's revision.
     */
    record: async (run: object, domain: string, observations: Array<ArtifactObservation>) =>
      call<PageMethods, 'artifacts.record'>((await context_()).rpc, 'artifacts.record', {
        run,
        domain,
        observations,
      }),
    /** Keeps a result (a ResultRef whose `content` is the digest of `bytes`) with its bytes. */
    result: async (result: object, bytes: Uint8Array) =>
      call<PageMethods, 'artifacts.result'>((await context_()).rpc, 'artifacts.result', { result, bytes }),
    /** Whether a subject is held exactly; never answered with the latest instead. */
    resolve: async (subject: object) =>
      call<PageMethods, 'artifacts.resolve'>((await context_()).rpc, 'artifacts.resolve', { subject }),
    /** The revision running (an ArtifactSourceRef), for a result computed now to name as its source. */
    source: async () => call<PageMethods, 'artifacts.source'>((await context_()).rpc, 'artifacts.source', {}),
    /**
     * A kept result and its bytes, by the result's id, from this or any other
     * conversation or App; both are checked against their digests.
     */
    open: async (id: string) =>
      call<PageMethods, 'artifacts.open'>((await context_()).rpc, 'artifacts.open', { id }),
    /**
     * A kept run by its id, from this or any other conversation or App: the
     * RunRef, every moment it holds in order from index 0 (each with its state
     * when one was kept, checked against its digest) and its checkpoints.
     */
    run: async (id: string) =>
      call<PageMethods, 'artifacts.run'>((await context_()).rpc, 'artifacts.run', { id }),
  },
  /**
   * Theorem's computations, the same calls the agent's `compute` operation
   * takes, run for this person: `call({ action: 'rerun', job, params })`
   * recomputes a job with new parameters and no model; `run`, `submit`,
   * `status`, `wait`, `receipt`, `compare` and `discover` work the same way.
   * A job's outputs are read by name with `output(job, name)`. A refusal
   * rejects with the backend's code in its message.
   */
  compute: {
    call: async (request: { action: string; [key: string]: unknown }) =>
      call<PageMethods, 'compute.call'>((await context_()).rpc, 'compute.call', { request }),
    output: async (job: string, name: string) =>
      call<PageMethods, 'compute.output'>((await context_()).rpc, 'compute.output', { job, name }),
  },
  /**
   * Capability instances a page module's manifest declared and the person
   * allowed, reached through the page with its own session: the App never
   * holds a credential. A refusal comes back as `{ ok: false, error }` with
   * the capability's code; an instance, method or action that was not allowed
   * is refused by the page before anything is reached.
   */
  capability: {
    describe: async (instanceId: string) =>
      call<PageMethods, 'capability.describe'>((await context_()).rpc, 'capability.describe', { instanceId }),
    query: async (request: CapabilityQueryParams) =>
      call<PageMethods, 'capability.query'>((await context_()).rpc, 'capability.query', request),
    invoke: async (request: CapabilityInvokeParams) =>
      call<PageMethods, 'capability.invoke'>((await context_()).rpc, 'capability.invoke', request),
  },
  /**
   * Names what the person selected in a view the DOM cannot see, such as a
   * brushed range or a chosen node: a `label`, the records' `ids` and the
   * view's `state` (JSON, at most 4 KB). The page carries it into the next
   * question asked about this App. `null` clears it.
   */
  select: async (selection: ViewSelection | null) => {
    chosen = selection
    await context
    reportSelection()
  },
  /** Resolves once the page has connected this app. */
  ready: context.then(() => undefined),
  /**
   * The controls this App names for the agent. Register a control with the
   * functions its visible element already calls; the agent reads and changes
   * it through them (the client operation `app.control`), and the reply says
   * the value read back. `@theorem/ui`'s controls do this when given a
   * `control` name.
   */
  controls: {
    /** Names a control for the agent until the returned function is called. */
    register: (spec: ControlSpec): (() => void) => registerControl(spec),
    /** Every registered control, with its value now. */
    list: listControls,
  },
  /**
   * Where the page shows this App (`inline` in a reply, the side `panel`, or
   * `expanded`) and the CSS pixels it may fill. Also on the root as
   * `data-theorem-presentation` and `--theorem-available-width/height`.
   */
  presentation: {
    now: presentationNow,
    /** Calls `listener` with the presentation now, if any, and after each change. */
    onChange: onPresentation,
  },
  files: {
    text: files('text'),
    json: files('json'),
    csv: files('csv'),
    bytes: files('bytes'),
    list: files('list'),
    write: files('write'),
  },
  state: async (name: string) => (await context).cells.state(name),
  /** A graph database kept in this browser, declared with `db("name")`. */
  db: async (name: string) => (await context).databases.open(name),
  run: async (target: string) =>
    call<PageMethods, 'run.request'>((await context).cells.rpc, 'run.request', {
      target,
    }),
  module: {
    /** Calls `listener` with the current values, and again when they change. */
    onInputs(listener: ModuleListener): () => void {
      moduleListeners.add(listener)
      if (moduleValues) listener(moduleValues)
      return () => moduleListeners.delete(listener)
    },
    /** Calls `listener` each time a route reaches the declared action `name`. */
    onAction(name: string, listener: ActionListener): () => void {
      const listeners = actionListeners.get(name) ?? new Set<ActionListener>()
      actionListeners.set(name, listeners)
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    output: async (name: string, value: unknown) =>
      call<PageMethods, 'module.output'>(
        (await context).cells.rpc,
        'module.output',
        {
          name,
          value,
        },
      ),
    emit: async (name: string, payload: unknown) =>
      call<PageMethods, 'module.emit'>(
        (await context).cells.rpc,
        'module.emit',
        {
          name,
          payload,
        },
      ),
  },
}

/**
 * What an App reaches as `window.theorem`. The checker's declarations for it
 * are written from this type (scripts/app-declarations.ts), so what an App is
 * checked against is what it is given.
 */
export type TheoremApp = typeof theorem

Object.defineProperty(window, 'theorem', { value: theorem })
