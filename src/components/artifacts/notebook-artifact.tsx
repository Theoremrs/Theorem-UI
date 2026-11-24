// SOURCING: the hosted App frame (BlockFrame over FrameConnection: sandbox
// "allow-scripts" on an origin of its own, a CSP only when the person sets a limit),
// the bridge's theme.changed call and the platform MutationObserver (the
// page's theme followed into the frame, as live-terminal-theme follows it),
// the TanStack Highlight SyntaxHighlighter (the marimo source), ui/button,
// composer-references' askAbout with app-references' notebookReference (the
// path an HTML App's selection takes to the next turn), and artifact-host's
// react-query reads of the host description and the recorded outputs, and the
// App document owners an HTML App runs with (document-app's replica and pinned
// state, app-artifacts' run store, saved-artifact's head), and view-instances'
// receipt store, which an inline view reports to. No library hosts an
// Observable or marimo notebook in Theorem's sandbox.
//
// A notebook artifact shows what it computed. Observable cells run in the
// frame with the vendored modules and import anything else by URL. A marimo
// notebook shows its recorded outputs with code hidden; it runs in the browser
// only when the person starts it, and never claims a run it did not make.
//
// Which revision runs, and with what, follows the HTML App. The newest
// revision of a saved notebook is its document's head: its cells reach the
// document's state collections, its runs are kept against the revision
// running, and what its views are left at is saved for the next view to start
// from. An older revision is what its message pinned, and what changes in it
// stays in its frame. How the head's open view builds, starts and settles is
// reported as an inline view's is, so a check of the document can say what the
// person sees apart from what its own hidden run saw.
import {
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { ReactNode } from 'react'
import { SyntaxHighlighter } from '@/components/assistant-ui/elements/code-highlighter'
import { BlockFrame } from '@/components/blocks/block-frame'
import { BlockMessage } from '@/components/blocks/block-status'
import { askAbout } from '@/components/chat/composer-references'
import { Icon } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { OPENS_WHOLE } from '@/lib/face/things'
import { BridgeDenied } from '@/lib/blocks/bridge'
import type {
  AppArtifacts,
  BridgeHost,
  StateCollections,
} from '@/lib/blocks/bridge'
import { pinnedAppState, useDocumentReplica } from '@/lib/blocks/document-app'
import { trackRunningApp } from '@/lib/blocks/running-apps'
import type { FrameConnection } from '@/lib/blocks/executor'
import { call } from '@/lib/blocks/sandbox/protocol'
import type {
  AppSelection,
  CellStatus,
  FrameError,
  SandboxMethods,
} from '@/lib/blocks/sandbox/protocol'
import { resolvedTheme } from '@/lib/blocks/sandbox/theme'
import type { ThemeState } from '@/lib/blocks/sandbox/theme'
import { NOTEBOOK_FORM_VERSION, needsNativeHost } from '@/lib/notebooks/forms'
import type {
  MarimoNotebook,
  ObservableNotebook,
} from '@/lib/notebooks/forms'
import {
  BROWSER_RUN_HOSTS,
  islandsDocument,
  retainedOutputsDocument,
} from '@/lib/notebooks/marimo'
import {
  observableDocument,
  savedViewOf,
} from '@/lib/notebooks/observable-document'
import type { SavedView } from '@/lib/notebooks/observable-document'
import { appArtifacts } from '@/lib/theorem/app-artifacts'
import { notebookReference } from '@/lib/theorem/app-references'
import {
  useArtifactHost,
  useRetainedOutputs,
} from '@/lib/theorem/artifact-host'
import type { ArtifactInteraction } from '@/lib/theorem/artifact-host'
import {
  documentViewKey,
  notebookRevision,
  useViewInstances,
} from '@/lib/generative/view-instances'
import { describeError } from '@/lib/theorem/client'
import { cn } from '@/lib/utils'
import { useOpenLatest } from './app-history'
import { useSeed } from './app-revision-frame'
import type { TheoremArtifact } from './artifact-model'
import type { RendererProps } from './artifact-registry'
import { ArtifactOpener } from './artifact-view'
import { useSavedArtifact } from './saved-artifact'
import type { SavedHead } from './saved-artifact'

const denied = (what: string) => async () => {
  throw new BridgeDenied(`A notebook ${what}.`)
}

/**
 * What a frame is lent beyond its selections: its saved notebook's state
 * collections, and the store its runs and results are kept in.
 */
export type NotebookLoan = {
  state?: StateCollections
  artifacts?: AppArtifacts
}

const NO_STATE: StateCollections = {
  snapshot: () => ({}),
  set: denied('with no saved document keeps no state'),
  delete: denied('with no saved document keeps no state'),
  subscribe: () => () => {},
}

/**
 * What the page lends a notebook frame: its selections, and what `lent`
 * gives. It reads and writes no files and starts no agents.
 */
export function notebookHost(
  onSelection?: (selection: AppSelection) => void,
  onError?: (error: FrameError) => void,
  onStatus?: (status: CellStatus) => void,
  lent: NotebookLoan = {},
): BridgeHost {
  return {
    state: lent.state ?? NO_STATE,
    artifacts: lent.artifacts,
    client: {
      read: denied('reads no workspace files'),
      tree: denied('reads no workspace files'),
      write: denied('writes no workspace files'),
    },
    run: denied('starts no agents'),
    onSelection,
    onError,
    onStatus,
  }
}

/** Pushes the page's theme into a connected frame now and whenever it changes. */
function followTheme(connection: FrameConnection): () => void {
  // A frame that closed or never connected has no theme to follow.
  const push = () =>
    void connection.connected
      .then((rpc) =>
        call<SandboxMethods, 'theme.changed'>(rpc, 'theme.changed', resolvedTheme()),
      )
      .catch(() => {})
  push()
  const observer = new MutationObserver(push)
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['class', 'data-palette', 'style'],
  })
  return () => observer.disconnect()
}

/** A hosted document as a blob URL, built once per `key` with the theme it opens in. */
function usePage(build: (theme: ThemeState) => Promise<string>, key: unknown) {
  const [page, setPage] = useState<{ key?: unknown; src?: string; error?: string }>({})
  useEffect(() => {
    let active = true
    let url: string | undefined
    void build(resolvedTheme()).then(
      (html) => {
        if (!active) return
        url = URL.createObjectURL(new Blob([html], { type: 'text/html' }))
        setPage({ key, src: url })
      },
      (failure) => {
        if (active) setPage({ key, error: describeError(failure, 'document') })
      },
    )
    return () => {
      active = false
      if (url) URL.revokeObjectURL(url)
    }
    // `build` closes over the notebook `key` names; a new closure alone is not a new page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  // A page built for an earlier key is not this one's: until this one is built, there is none.
  return page.key === key ? page : {}
}

/**
 * A notebook's frame: its document, the host with what `lend` gives, the
 * page's theme followed in. `onError` hears what its cells throw and nothing catches, and
 * a document that does not build, which `onBuildError` hears too; `onStatus`
 * hears how each cell first settles, and `onStage` when the document built
 * and when its frame started.
 */
export function NotebookFrame({
  build,
  buildKey,
  lend,
  title,
  loading,
  onSelection,
  onError,
  onStatus,
  onBuildError,
  onStage,
  documentId,
}: {
  build: (theme: ThemeState) => Promise<string>
  buildKey: unknown
  /** The saved notebook it runs, so the agent's app.control reaches its named controls. */
  documentId?: string
  lend?: NotebookLoan
  title: string
  loading: string
  onSelection: (selection: AppSelection) => void
  onError?: (error: FrameError) => void
  onStatus?: (status: CellStatus) => void
  onBuildError?: (message: string) => void
  onStage?: (stage: 'compiled' | 'mounted') => void
}) {
  const page = usePage(build, buildKey)
  const host = useMemo(
    () => notebookHost(onSelection, onError, onStatus, lend),
    [onSelection, onError, onStatus, lend],
  )
  useEffect(() => {
    if (!page.error) return
    onError?.({ message: page.error })
    onBuildError?.(page.error)
  }, [page.error, onError, onBuildError])
  useEffect(() => {
    if (page.src) onStage?.('compiled')
  }, [page.src, onStage])
  const onConnection = useCallback(
    (connection: FrameConnection) => {
      // The frame is made before its document loads; it has started once it connects.
      void connection.connected.then(() => onStage?.('mounted'), () => {})
      const unfollow = followTheme(connection)
      const untrack = documentId ? trackRunningApp(documentId, title, connection) : () => {}
      return () => {
        untrack()
        unfollow()
      }
    },
    [onStage, documentId, title],
  )
  if (page.error) return <BlockMessage tone="error">{page.error}</BlockMessage>
  if (!page.src)
    return (
      <p role="status" className="py-3 text-sm text-ink-muted">
        {loading}
      </p>
    )
  return (
    <BlockFrame
      src={page.src}
      host={host}
      title={title}
      onConnection={onConnection}
    />
  )
}

/**
 * The person's selection in one page of a notebook's frame. A new revision,
 * or a switch between the recorded and the running notebook, builds a new
 * page, which starts with nothing selected, so a reference never carries one
 * revision's selection to another.
 */
function usePageSelection(page: unknown) {
  const [held, setHeld] = useState<{ page: unknown; selection: AppSelection }>()
  const select = useCallback(
    (selection: AppSelection) => setHeld({ page, selection }),
    [page],
  )
  return [held && held.page === page ? held.selection : undefined, select] as const
}

/** How many open views report for each document, so the last to close forgets it. */
const openViews = new Map<string, number>()

/**
 * What an open view of a saved notebook's head tells the receipt store: the
 * revision it runs, when its page built and started, and how each cell first
 * settled. Views of one document report to one instance; the first to see a
 * cell settle says how. Undefined handlers for a view that does not report.
 */
function useOpenViewReport(
  documentId: string | undefined,
  notebook: ObservableNotebook,
) {
  const key = documentId && documentViewKey(documentId)
  const revision = useMemo(() => notebookRevision(notebook), [notebook])
  const { mount, advance, settle, error, unbuilt, forget } =
    useViewInstances.getState()
  // Mounted before the frame's own effects can report on it.
  useLayoutEffect(() => {
    if (!key) return
    mount(
      key,
      revision,
      notebook.cells.map((cell) => cell.id),
      notebook.cells.map((cell) => cell.source),
    )
    openViews.set(key, (openViews.get(key) ?? 0) + 1)
    return () => {
      const left = (openViews.get(key) ?? 1) - 1
      if (left > 0) return void openViews.set(key, left)
      openViews.delete(key)
      forget(key)
    }
  }, [key, revision, notebook, mount, forget])
  return useMemo(
    () =>
      key
        ? {
            onStatus: (status: CellStatus) => settle(key, revision, status),
            onError: (frame: FrameError) => error(key, revision, frame.message),
            onBuildError: (message: string) => unbuilt(key, revision, message),
            onStage: (stage: 'compiled' | 'mounted') =>
              advance(key, revision, stage),
          }
        : {},
    [key, revision, settle, error, unbuilt, advance],
  )
}

/** Whether the person pointed at something in the notebook. */
const pointedAt = (selection?: AppSelection) =>
  Boolean(selection?.entityId || selection?.cellId || selection?.text)

/**
 * What a notebook's frame runs with besides its cells: what its views start
 * from, what the page lends it, and `keep`, which saves what its views are
 * left at. `ready` is false until saved state has been read.
 */
type NotebookRun = {
  ready: boolean
  saved?: SavedView
  lend?: NotebookLoan
  keep?: (selection: AppSelection) => void
  error?: string
}

/** A notebook with no saved document: nothing to start from, nothing lent. */
const NO_DOCUMENT: NotebookRun = { ready: true }

/**
 * Where what a notebook's views are left at is kept: one record of its
 * document's state, which the agent reads as `app-state:notebook`.
 */
const VIEWS = { collection: 'notebook', id: 'saved' } as const

/** How long the views rest before they are saved, so a dragged slider saves once. */
const KEEP_AFTER_MS = 400

const savedIn = (state: StateCollections): SavedView | undefined => {
  const value = state.snapshot(VIEWS.collection)[VIEWS.id]
  return value !== null && typeof value === 'object' ? value : undefined
}

/**
 * The newest revision of a saved notebook runs with its document. Each view
 * runs its own cells and starts from what was saved when it was built; a
 * view open beside it is not driven by it. A view saves only what changes in
 * its own views, so what the next one starts from is the last view moved.
 * `key` is the notebook built: a state save moves the document's revision
 * but builds nothing, so the start and the revision runs name are read once
 * per notebook.
 */
function useHeadRun(head: SavedHead | undefined, key: unknown): NotebookRun {
  // Declared before the replica, so on unmount a waiting save goes out while
  // the replica is still there to send it.
  const waiting = useRef<{ timer: ReturnType<typeof setTimeout>; save: () => void }>(undefined)
  useEffect(
    () => () => {
      const pending = waiting.current
      if (!pending) return
      clearTimeout(pending.timer)
      pending.save()
    },
    [],
  )
  const live = useDocumentReplica(head?.app)
  const state = live.state?.state
  const [start, setStart] = useState<{
    key: unknown
    state: StateCollections
    saved?: SavedView
    /** `saved` as JSON: where this view's views stand until it reports otherwise. */
    text: string
    lend: NotebookLoan
  }>()
  if (state && head && (start?.key !== key || start?.state !== state)) {
    const saved = savedIn(state)
    setStart({
      key,
      state,
      saved,
      text: JSON.stringify(saved ?? null),
      lend: { state, artifacts: appArtifacts(head.snapshot) },
    })
  }
  // What this view last reported of its views, for the start it reported from.
  const last = useRef<{ start: typeof start; text: string }>(undefined)
  const [error, setError] = useState<string>()
  const keep = useCallback(
    (selection: AppSelection) => {
      if (!state) return
      const next = savedViewOf(selection)
      const text = JSON.stringify(next ?? null)
      // A click that moved nothing in this view's own views is not news.
      const held = last.current
      const seen = held && held.start === start ? held.text : start?.text
      if (text === seen) return
      last.current = { start, text }
      const save = () => {
        waiting.current = undefined
        void Promise.resolve(
          next
            ? state.set(VIEWS.collection, VIEWS.id, next)
            : state.delete(VIEWS.collection, VIEWS.id),
        ).then(
          () => setError(undefined),
          (failure: unknown) =>
            setError(
              `Where the views were left was not saved: ${describeError(failure, 'document')}`,
            ),
        )
      }
      if (waiting.current) clearTimeout(waiting.current.timer)
      waiting.current = { timer: setTimeout(save, KEEP_AFTER_MS), save }
    },
    [state, start],
  )
  if (!head) return NO_DOCUMENT
  // A document whose state cannot be read still runs its cells, keeping nothing.
  if (live.error) return { ready: true, error: live.error }
  return start && start.key === key && start.state === state
    ? { ready: true, saved: start.saved, lend: start.lend, keep, error }
    : { ready: false }
}

/**
 * An older revision runs as its message pinned it. It starts from the saved
 * document's state while it is still the current revision, and what changes
 * stays in its frame: nothing reaches the document.
 */
function usePinnedRun(artifact: TheoremArtifact): NotebookRun {
  const seed = useSeed(artifact)
  const [pinned, setPinned] = useState<{
    seed: object
    state: ReturnType<typeof pinnedAppState>
  }>()
  useEffect(() => {
    if (!seed) return
    const made = pinnedAppState(seed.bytes)
    let active = true
    void made.ready.then(() => {
      if (active) setPinned({ seed, state: made })
    })
    return () => {
      active = false
      made.dispose()
    }
  }, [seed])
  return useMemo(
    () =>
      pinned && pinned.seed === seed
        ? {
            ready: true,
            saved: savedIn(pinned.state.state),
            lend: { state: pinned.state.state },
          }
        : { ready: false },
    [pinned, seed],
  )
}

/** The revision an older view shows, and what Open latest does there. */
type Pinned = { position: string; openLatest: () => void }

/**
 * A notebook part as its renderer shows it. The newest revision of a saved
 * notebook is its document's head (saved-artifact.ts), run with its document;
 * an older revision is the one its message pinned; a notebook with no
 * document runs with nothing lent.
 */
export function NotebookArtifact({
  artifact,
  latest,
  form,
}: RendererProps & { form: 'observable' | 'marimo' }) {
  if (!artifact.documentId)
    return <NotebookOf artifact={artifact} form={form} run={NO_DOCUMENT} />
  return latest ? (
    <HeadNotebook artifact={artifact} form={form} />
  ) : (
    <PinnedNotebook artifact={artifact} form={form} />
  )
}

function HeadNotebook({
  artifact,
  form,
}: {
  artifact: TheoremArtifact
  form: 'observable' | 'marimo'
}) {
  const saved = useSavedArtifact(artifact, true)
  // A head this build cannot read is not run with: the message's revision is shown alone.
  const run = useHeadRun(
    saved.pending || saved.error ? undefined : saved.head,
    saved.artifact.notebook,
  )
  if (saved.pending)
    return (
      <p role="status" className="py-3 text-sm text-ink-muted">
        Opening the notebook…
      </p>
    )
  return (
    <NotebookOf
      artifact={saved.artifact}
      form={form}
      run={saved.error ? { ...run, error: saved.error } : run}
    />
  )
}

function PinnedNotebook({
  artifact,
  form,
}: {
  artifact: TheoremArtifact
  form: 'observable' | 'marimo'
}) {
  const run = usePinnedRun(artifact)
  const openLatest = useOpenLatest(artifact.artifactId)
  const pinned = useMemo(
    () => ({
      position: String(artifact.documentPosition ?? artifact.revision),
      openLatest,
    }),
    [artifact.documentPosition, artifact.revision, openLatest],
  )
  return <NotebookOf artifact={artifact} form={form} run={run} pinned={pinned} />
}

function NotebookOf({
  artifact,
  form,
  run,
  pinned,
}: {
  artifact: TheoremArtifact
  form: 'observable' | 'marimo'
  run: NotebookRun
  pinned?: Pinned
}) {
  const { notebook } = artifact
  if (form === 'observable' && notebook?.form === 'observable')
    return (
      <ObservableNotebookView
        artifact={artifact}
        notebook={notebook}
        run={run}
        pinned={pinned}
      />
    )
  if (form === 'marimo' && notebook?.form === 'marimo')
    return (
      <MarimoNotebookView
        artifact={artifact}
        notebook={notebook}
        run={run}
        pinned={pinned}
      />
    )
  return <UnreadableNotebook artifact={artifact} />
}

/**
 * The notebook surface: a quiet line of status and actions above the frame.
 * `notebook-surface` is the hook the paper material attaches to. Ask is there
 * when the part names its App document, which the reference points at.
 */
function NotebookSurface({
  artifact,
  form,
  cellIds,
  selection,
  status,
  actions,
  pinned,
  children,
}: {
  artifact: TheoremArtifact
  form: 'observable' | 'marimo'
  /** The cells this revision is known to have, which a locator may name. */
  cellIds: ReadonlyArray<string>
  selection?: AppSelection
  status?: ReactNode
  actions?: ReactNode
  pinned?: Pinned
  children: ReactNode
}) {
  const { documentId, documentPosition } = artifact
  const open = useContext(ArtifactOpener)
  return (
    <section
      aria-label={artifact.title}
      data-slot="notebook"
      data-form={form}
      className="notebook-surface flex flex-col gap-2"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-muted">
        <span role="status" className="min-w-0 flex-1">
          {pinned &&
            `Saved revision ${pinned.position}. Changes you make here are not saved. `}
          {status}
        </span>
        {actions}
        {documentId && documentPosition !== undefined && (
          <Button
            size="xs"
            variant="ghost"
            onClick={() =>
              askAbout(
                notebookReference(
                  {
                    documentId,
                    position: documentPosition,
                    title: artifact.title,
                    cellIds,
                  },
                  selection,
                ),
              )
            }
          >
            {pointedAt(selection) ? 'Ask about selection' : 'Ask about this'}
          </Button>
        )}
        {pinned && (
          <Button size="xs" variant="secondary" onClick={pinned.openLatest}>
            Open latest
          </Button>
        )}
        {open && (
          <Button
            variant="ghost"
            size="icon"
            aria-label="Open in larger view"
            {...OPENS_WHOLE}
            className="group/open size-7 p-1.5"
            onClick={open}
          >
            <Icon.Open className="size-4" />
          </Button>
        )}
      </div>
      {children}
    </section>
  )
}

/**
 * A notebook part this build cannot read: one written in a newer form
 * version, or one whose payload is not a notebook form.
 */
export function UnreadableNotebook({ artifact }: { artifact: TheoremArtifact }) {
  return (
    <BlockMessage tone="error">
      {(artifact.formVersion ?? 1) > NOTEBOOK_FORM_VERSION
        ? `This notebook is in form version ${artifact.formVersion}; this version of Theorem reads version ${NOTEBOOK_FORM_VERSION}.`
        : 'This notebook could not be read: its payload is not an Observable or marimo notebook.'}
    </BlockMessage>
  )
}

/** Where a frame would be, while the state it starts from is read. */
const Starting = ({ children }: { children: ReactNode }) => (
  <p role="status" className="py-3 text-sm text-ink-muted">
    {children}
  </p>
)

export function ObservableNotebookView({
  artifact,
  notebook,
  run,
  pinned,
}: {
  artifact: TheoremArtifact
  notebook: ObservableNotebook
  run: NotebookRun
  pinned?: Pinned
}) {
  const [selection, setSelection] = usePageSelection(notebook)
  const { keep, saved } = run
  const onSelection = useCallback(
    (next: AppSelection) => {
      setSelection(next)
      keep?.(next)
    },
    [setSelection, keep],
  )
  const cellIds = useMemo(() => notebook.cells.map((cell) => cell.id), [notebook])
  // Only the head reports: an older revision is not what a check of the
  // document runs, and a notebook with no document has none to check.
  const report = useOpenViewReport(
    pinned ? undefined : artifact.documentId,
    notebook,
  )
  return (
    <NotebookSurface
      artifact={artifact}
      form="observable"
      cellIds={cellIds}
      selection={selection}
      status={run.error}
      pinned={pinned}
    >
      {run.ready ? (
        <NotebookFrame
          build={(theme) => observableDocument(notebook, theme, { saved })}
          buildKey={notebook}
          lend={run.lend}
          title={notebook.title}
          loading="Starting the notebook…"
          onSelection={onSelection}
          {...(!pinned && artifact.documentId && { documentId: artifact.documentId })}
          {...report}
        />
      ) : (
        <Starting>Starting the notebook…</Starting>
      )}
    </NotebookSurface>
  )
}

const recordedAt = (ms: number) =>
  new Date(ms).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })

/**
 * Where a marimo notebook's outputs came from, said plainly. Recorded
 * outputs name the host that produced them, and say so when that run was of
 * a different source. A notebook that needs a native host says whether one
 * is connected (`connected`; unknown while the host description loads) and
 * waits rather than pretending to run.
 */
export function marimoStatus(
  notebook: MarimoNotebook,
  {
    running = false,
    stale = false,
    connected,
  }: { running?: boolean; stale?: boolean; connected?: boolean } = {},
): string {
  if (running)
    return 'Running in this page on Pyodide: no CUDA, and no true CPU parallelism.'
  const run = notebook.outputs?.execution
  const host = notebook.needs?.gpu ? 'a GPU host' : 'a native host'
  const missing =
    needsNativeHost(notebook) && connected === false
      ? ` Running it again needs ${host}; none is connected.`
      : ''
  if (run) {
    const on = run.device ? `${run.host}, ${run.device}` : run.host
    const of = stale ? ' of a different version of this notebook' : ''
    return `From a recorded run${of} on ${on}, ${recordedAt(run.finishedAtMs)}.${missing}`
  }
  if (!needsNativeHost(notebook)) return 'This notebook has not run yet.'
  return connected === false
    ? `Awaiting ${host}. This notebook has not run, so it has no outputs yet.`
    : 'This notebook has not run yet, so it has no outputs.'
}

/** Whether the host's execution environment can run a notebook that needs a native host. */
const hostRuns = (notebook: MarimoNotebook, execute?: string) =>
  notebook.needs?.gpu
    ? execute === 'native-gpu'
    : execute === 'native' || execute === 'native-gpu'

export function MarimoNotebookView({
  artifact,
  notebook,
  run: lent,
  pinned,
}: {
  artifact: TheoremArtifact
  notebook: MarimoNotebook
  run: NotebookRun
  pinned?: Pinned
}) {
  const [running, setRunning] = useState(false)
  const [source, setSource] = useState(false)
  const host = useArtifactHost()
  const fetched = useRetainedOutputs(
    notebook.outputs ? undefined : notebook.retainedOutputs,
  )
  const run = useMemo(
    () =>
      notebook.outputs
        ? { outputs: notebook.outputs, stale: false }
        : fetched.data,
    [notebook.outputs, fetched.data],
  )
  // The frames read the outputs off the notebook. A stale run's cells may not
  // line up with this source's, so a browser run starts without them.
  const shown = useMemo(
    () => ({ ...notebook, outputs: run?.outputs }),
    [notebook, run],
  )
  const fresh = useMemo(
    () => ({ ...notebook, outputs: run?.stale ? undefined : run?.outputs }),
    [notebook, run],
  )
  const cellIds = useMemo(
    () => (run && !run.stale ? run.outputs.cells.map((cell) => cell.id) : []),
    [run],
  )
  const [selection, setSelection] = usePageSelection(running ? fresh : shown)
  const execute = host.data?.availability.marimo.execute
  const connected = host.isPending
    ? undefined
    : host.isError
      ? undefined
      : hostRuns(notebook, execute)
  // The host labels what it offers; a Theorem without a host description
  // offers what every browser can: the recorded view and a Pyodide run.
  const offers = host.data?.interactions.marimo
  const offer = (interaction: ArtifactInteraction, fallback: string) =>
    offers
      ? offers.find((o) => o.interaction === interaction)?.label
      : fallback
  const viewLabel = offer('view', 'View result') ?? 'View result'
  const runLabel = offer('kernel', 'Run notebook')
  // Pyodide has no CUDA and no native packages, so only a browser notebook can run here.
  const runnable =
    !needsNativeHost(notebook) && execute !== 'none' && runLabel !== undefined
  const recorded = Boolean(
    run?.outputs.cells.some((cell) => cell.outputs.length),
  )
  const status = fetched.isLoading && !running
    ? 'Opening the recorded outputs…'
    : fetched.isError && !running
      ? `The recorded outputs could not be read: ${describeError(fetched.error, 'document')}`
      : marimoStatus(shown, { running, stale: run?.stale, connected })
  return (
    <NotebookSurface
      artifact={artifact}
      form="marimo"
      cellIds={cellIds}
      selection={selection}
      status={[status, lent.error].filter(Boolean).join(' ')}
      pinned={pinned}
      actions={
        <>
          {runnable && (
            <Button
              size="xs"
              variant={running ? 'ghost' : 'outline'}
              title={
                running
                  ? undefined
                  : `Runs on Pyodide in this page, with no CUDA and no true CPU parallelism. Loads marimo and the notebook's packages from ${BROWSER_RUN_HOSTS.join(', ')}.`
              }
              onClick={() => setRunning((value) => !value)}
            >
              {running ? viewLabel : runLabel}
            </Button>
          )}
          <Button
            size="xs"
            variant="ghost"
            aria-expanded={source}
            onClick={() => setSource((value) => !value)}
          >
            {source ? 'Hide source' : 'Source'}
          </Button>
        </>
      }
    >
      {!lent.ready ? (
        <Starting>Opening the notebook…</Starting>
      ) : running ? (
        <NotebookFrame
          key="browser-run"
          build={(theme) => islandsDocument(fresh, theme)}
          buildKey={fresh}
          lend={lent.lend}
          title={notebook.title}
          loading="Preparing the browser run…"
          onSelection={setSelection}
        />
      ) : recorded ? (
        <NotebookFrame
          key="recorded"
          build={(theme) => retainedOutputsDocument(shown, theme)}
          buildKey={shown}
          lend={lent.lend}
          title={notebook.title}
          loading="Opening the recorded outputs…"
          onSelection={setSelection}
        />
      ) : null}
      {source && (
        <SyntaxHighlighter
          className={cn(
            '[&_pre]:rounded-lg! [&_pre]:border! [&_pre]:border-separator! [&_pre]:text-[13px]',
          )}
          language="python"
          code={notebook.source}
        />
      )}
    </NotebookSurface>
  )
}
