// SOURCING: hand-roll — the mount of the Rust workbench (terminal/src/workbench.rs, Ratzilla on the DOM backend, loaded by terminal-screen's loadWasm exactly as the terminal drawer loads it): no library models a host element that forwards keys, pointer, wheel, IME and paste into a wasm Elm core. The owners are src/lib/workbench (connectEnvironment, createFiles, createLayout, createCheckpoints, createAdapter) and the terminal owner is that folder's terminalHost and TerminalSession from connectTerminalHost. The platform's ResizeObserver measures the host.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react'
import type { ReactNode } from 'react'
import { loadWasm } from '@/components/terminal/terminal-screen'
import { bootstrap, mutate, mutateThread, theorem } from '@/lib/theorem/client'
import { readOrganization } from '@/lib/theorem/organization'
import { createAdapter } from '@/lib/workbench/adapter'
import { setWorkbenchHandle } from '@/lib/workbench/agent/store'
import { useAppearance } from '@/lib/appearance'
import {
  createAppearancePort,
  tellAppearance,
} from '@/lib/workbench/appearance/appearance'
import type { AccountAdapter, Adapter } from '@/lib/workbench/adapter'
import { SignIn } from '@/components/auth/sign-in'
import { accountKey, createAccountWatch } from '@/lib/workbench/account'
import { statusOf } from '@/lib/workbench/environment/result'
import {
  connectEnvironment,
  connectTerminalHost,
} from '@/lib/workbench/environment/connect'
import { createConversation } from '@/lib/workbench/conversation/conversation'
import { createConversationPort } from '@/lib/workbench/conversation/port'
import { createThreadsPort } from '@/lib/workbench/threads/port'
import { createThreads } from '@/lib/workbench/threads/threads'
import { conversationServices } from '@/lib/workbench/conversation/runtime'
import { createSideChatModel } from '@/lib/workbench/conversation/side-chat-model'
import { createSideChats } from '@/lib/workbench/conversation/side-chats'
import { useConversationRuntime } from '@/lib/workbench/conversation/use-conversation-runtime'
import { createLanguage } from '@/lib/workbench/language/language'
import { deliverReducedMotion, languagePortFor } from './mount-wiring'
import { createRunner } from '@/lib/workbench/run/run'
import { createRunPort } from '@/lib/workbench/run/port'
import { createSearch } from '@/lib/workbench/search/search'
import { createSearchPort } from '@/lib/workbench/search/port'
import { createDocuments } from '@/lib/workbench/documents/documents'
import { createDraftStore } from '@/lib/workbench/documents/local'
import { createDocumentsPort } from '@/lib/workbench/documents/port'
import { createHistory } from '@/lib/workbench/documents/history'
import { createDelegations } from '@/lib/workbench/delegations/delegations'
import { createDelegationsPort } from '@/lib/workbench/delegations/port'
import { createFiles } from '@/lib/workbench/files/files'
import {
  checkpointDirectory,
  createCheckpoints,
  createLayout,
  createLocalStore,
} from '@/lib/workbench/layout'
import { createScm } from '@/lib/workbench/scm/scm'
import { createScmPort } from '@/lib/workbench/scm/port'
import { TerminalSession } from '@/lib/workbench/terminal'
import type { ArrangementMsg, Effect, Inbound } from '@/lib/workbench/wire'
import type { WorkbenchHandle } from '@/terminal-wasm/theorem_terminal'
import { createArtifactsPort, createClipboardPort } from './ports'
import { pointerJson } from './pointer-json'
import { isMac, isPasteChord } from './paste-chord'
import { WorkbenchCabinet } from '@/components/cabinet/workbench-cabinet'
import { WorkbenchFace } from './workbench-face'
import { IconLayer } from './icon-layer'
import { createIconStore } from './icon-layer/store'
import { SemanticOverlay } from './semantic-overlay'
import { settle, typedSince } from './semantic-overlay/mirror'
import type { InputMirror } from './semantic-overlay/mirror'
import { WORKBENCH_LABEL } from './label'

/** What the surface lets an adapter's builder do to the mounted core besides answering effects. */
export interface SurfaceHost {
  /** Delivers an arrangement message (load, save, apply, rename, delete) to the core. */
  arrangement: (message: ArrangementMsg) => void
  /** The presets and the account's saved arrangements, as the core lists them. */
  arrangements: () => { name: string; builtin: boolean }[]
  /** The person's key overrides (the core's `Overrides`, JSON): what the key table is rebuilt from. */
  setKeys: (overridesJson: string) => void
}

/** Answers to the workbench: completions of its effects and events nobody asked for, each tagged by its channel. */
export type Dispatch = (message: Inbound) => void

/**
 * The semantic tree as Rust publishes it: the first tree, then diffs, each a JSON string
 * (`{type: "full", tree}` or `{type: "diff", diff}`). The overlay (a separate piece of work)
 * reads `latest` and subscribes; nothing here parses it.
 */
export interface SemanticsFeed {
  /** The last update published, `undefined` before the first. */
  readonly latest: string | undefined
  subscribe: (listener: (update: string) => void) => () => void
}

/** What the surface gives its children besides the feed: the mounted core, the element they are drawn in, and the input field. */
export interface SurfaceParts {
  /** The mounted core, once it is up. */
  handle: WorkbenchHandle | undefined
  /** The surface's own element, which the grid and the children share. */
  root: HTMLDivElement | null
  /** The one real text control, once it is mounted, and the text and caret the overlay has mirrored into it. */
  input: HTMLTextAreaElement | null
  mirror: { current: InputMirror | undefined }
}

const FeedContext = createContext<SemanticsFeed | undefined>(undefined)

/** The semantic feed of the enclosing workbench. */
export function useWorkbenchSemantics(): SemanticsFeed {
  const feed = useContext(FeedContext)
  if (!feed)
    throw new Error('useWorkbenchSemantics needs a Workbench around it')
  return feed
}

function createFeed(): SemanticsFeed & { push: (update: string) => void } {
  const listeners = new Set<(update: string) => void>()
  const feed = {
    latest: undefined as string | undefined,
    subscribe(listener: (update: string) => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    push(update: string) {
      feed.latest = update
      for (const listener of listeners) listener(update)
    },
  }
  return feed
}

/** One Ratzilla mount per host element; its frames stop when the element leaves the page. */
type Sink = {
  effect: (json: string) => void
  semantics: (json: string) => void
  icons: (json: string) => void
}
const mounts = new WeakMap<
  HTMLElement,
  { handle: Promise<WorkbenchHandle>; sink: Sink }
>()

function mountWorkbench(host: HTMLElement) {
  let mounted = mounts.get(host)
  if (!mounted) {
    const sink: Sink = {
      effect: () => {},
      semantics: () => {},
      icons: () => {},
    }
    const handle = loadWasm().then((wasm) =>
      wasm.mount_workbench(
        host.id,
        (json: string) => sink.effect(json),
        (json: string) => sink.semantics(json),
        (json: string) => sink.icons(json),
      ),
    )
    mounted = { handle, sink }
    mounts.set(host, mounted)
  }
  return mounted
}

/**
 * The workbench over an adapter. `connect` builds the effect dispatcher once the wasm is up and
 * is given the handle's `dispatch`; it is called again if the surface remounts. Children receive
 * the semantic feed (the overlay's seam) and are drawn over the grid.
 */
export function WorkbenchSurface({
  connect,
  onDrawn,
  project,
  loadArrangements = false,
  shown = true,
  companion = false,
  children,
}: {
  connect: (dispatch: Dispatch, surface: SurfaceHost) => Adapter
  /** Whether the person can see it. Only then may a run's agent read and act on it (lib/workbench/agent). */
  shown?: boolean
  /** Whether it stands beside the conversation rather than taking the whole sheet; the core decides what that leaves out. */
  companion?: boolean
  /** Called once, after the first frame is on the page: what a story or an oracle waits for. */
  onDrawn?: () => void
  /** The project whose artifacts the Artifacts panel shows; absent, the panel's page side is not mounted. */
  project?: { id: string; title: string }
  /** Ask the core to load the account's arrangements once the adapter is ready. */
  loadArrangements?: boolean
  children?: (feed: SemanticsFeed, parts: SurfaceParts) => ReactNode
}) {
  const hostId = `workbench-${useId().replace(/[^A-Za-z0-9_-]/g, '')}`
  const host = useRef<HTMLDivElement>(null)
  // One cell wide and one line tall in the grid's own font: it changes size when the person's text
  // size changes, which the host's box does not.
  const probe = useRef<HTMLSpanElement>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  const [inputElement, setInputElement] = useState<HTMLTextAreaElement | null>(
    null,
  )
  // What the overlay has put into the input: a cell the overlay writes and the input path reads.
  const [mirror] = useState<{ current: InputMirror | undefined }>(() => ({
    current: undefined,
  }))
  const handle = useRef<WorkbenchHandle>(undefined)
  // The same handle as state, for the page parts that are drawn over the grid once it is up.
  const [mountedHandle, setMountedHandle] = useState<WorkbenchHandle>()
  const [root, setRoot] = useState<HTMLDivElement | null>(null)
  const arranging = useRef(loadArrangements)
  const latest = useRef(connect)
  const drawn = useRef(onDrawn)
  useEffect(() => {
    latest.current = connect
    drawn.current = onDrawn
    arranging.current = loadArrangements
  })

  const [feed] = useState(createFeed)
  const [icons] = useState(createIconStore)

  useEffect(() => {
    const element = host.current
    if (!element) return
    let disposed = false
    let adapter: Adapter | undefined
    let stopMotion = () => {}
    const { handle: mounting, sink } = mountWorkbench(element)
    sink.semantics = (json) => feed.push(json)
    sink.icons = (json) => icons.set(json)
    void mounting.then((mounted) => {
      if (disposed) return
      handle.current = mounted
      setMountedHandle(mounted)
      // The frames drawn before this sink was taken carry icons it has not seen.
      icons.set(mounted.icons())
      stopMotion = deliverReducedMotion(mounted)
      adapter = latest.current(
        (message) => {
          if (!disposed) mounted.dispatch(JSON.stringify(message))
        },
        {
          arrangement: (message) => {
            if (!disposed) mounted.arrangement(JSON.stringify(message))
          },
          arrangements: () =>
            JSON.parse(mounted.arrangements()) as {
              name: string
              builtin: boolean
            }[],
          setKeys: (json) => {
            if (!disposed) mounted.set_keys(json)
          },
        },
      )
      sink.effect = (json) => adapter?.perform(JSON.parse(json) as Effect)
      // The adapter is ready (and can take the load's effect): read the account's saved arrangements.
      if (arranging.current)
        mounted.arrangement(JSON.stringify({ type: 'load' }))
      mounted.resize()
      // The keyboard works from load: take focus unless the person is already typing elsewhere.
      const active = document.activeElement
      const typing =
        active instanceof HTMLElement &&
        active !== input.current &&
        (active.isContentEditable ||
          ['INPUT', 'TEXTAREA', 'SELECT'].includes(active.tagName))
      if (!typing) input.current?.focus({ preventScroll: true })
      mounted.when_drawn(() => {
        if (!disposed) drawn.current?.()
      })
    })
    const observer = new ResizeObserver(() => handle.current?.resize())
    observer.observe(element)
    // Ratzilla's DOM backend measures a cell and rebuilds the grid only on a window `resize` event,
    // so a change of the grid's font size (the probe's box) is announced the way it expects; the
    // frame loop then follows the grid it built. The first report is the starting size.
    let probed: string | undefined
    const textSize = new ResizeObserver(([entry]) => {
      if (!entry) return
      const size = `${entry.contentRect.width}x${entry.contentRect.height}`
      if (probed !== undefined && probed !== size)
        window.dispatchEvent(new Event('resize'))
      probed = size
    })
    if (probe.current) textSize.observe(probe.current)
    // The wheel needs preventDefault, which React's passive listener cannot do.
    const wheel = (event: WheelEvent) => {
      event.preventDefault()
      handle.current?.pointer(pointerJson('wheel', event))
    }
    element.addEventListener('wheel', wheel, { passive: false })
    return () => {
      disposed = true
      sink.effect = () => {}
      sink.icons = () => {}
      stopMotion()
      observer.disconnect()
      textSize.disconnect()
      element.removeEventListener('wheel', wheel)
      adapter?.dispose()
      handle.current = undefined
      setMountedHandle(undefined)
    }
  }, [feed, icons])

  // A run's agent reaches the workbench only while the person can see it: a
  // closed one is opened first (lib/workbench/agent/operations.ts).
  useEffect(() => {
    if (!shown || !mountedHandle) return
    setWorkbenchHandle(mountedHandle)
    return () => setWorkbenchHandle(undefined)
  }, [shown, mountedHandle])

  useEffect(() => {
    mountedHandle?.set_companion(companion)
  }, [companion, mountedHandle])

  return (
    <FeedContext.Provider value={feed}>
      <div
        ref={setRoot}
        className="relative flex h-full min-h-0 w-full flex-1 flex-col font-mono text-[length:calc(12.5px*var(--appearance-scale-code,1))]"
        onKeyDown={(event) => {
          // Keys pressed during an IME composition belong to the composition, never to the
          // workbench; some browsers report them only as keyCode 229.
          if (
            event.nativeEvent.isComposing ||
            event.nativeEvent.keyCode === 229
          )
            return
          // The browser's paste chord is answered by its `paste` event, which carries the text;
          // passing the key on too would paste twice.
          if (isPasteChord(event.nativeEvent, isMac(navigator))) return
          if (handle.current?.key(event.nativeEvent)) {
            event.preventDefault()
            event.stopPropagation()
          }
        }}
      >
        <span
          ref={probe}
          aria-hidden="true"
          className="pointer-events-none invisible absolute top-0 left-0 h-[1lh] w-[1ch]"
        />
        <div
          ref={host}
          id={hostId}
          aria-hidden="true"
          data-base-ui-swipe-ignore=""
          // A press on a non-focusable element would move focus to the page; the input keeps it.
          // The press goes in from `mousedown`, the one event whose `detail` is the click count.
          onMouseDown={(event) => {
            event.preventDefault()
            input.current?.focus({ preventScroll: true })
            handle.current?.pointer(pointerJson('down', event))
          }}
          onPointerDown={(event) =>
            event.currentTarget.setPointerCapture(event.pointerId)
          }
          onPointerUp={(event) =>
            handle.current?.pointer(pointerJson('up', event))
          }
          onPointerMove={(event) =>
            handle.current?.pointer(pointerJson('move', event))
          }
          onContextMenu={(event) => event.preventDefault()}
          // `normal` is the leading Ratzilla measures a cell with and pitches rows by. Under the
          // page's inherited 1.5 a line box is taller than its row: it overlaps the next row, runs
          // past the host's last row and sets every row's background low.
          className="relative min-h-0 flex-1 cursor-default touch-none overflow-hidden bg-term leading-[normal] whitespace-pre text-term-ink outline-none"
        />
        {/* The host-input service (ARCHITECTURE section 8): the one real text control. It takes
            IME composition, typed text and paste, and forwards what was committed. It sits
            outside the host, whose contents Ratzilla replaces. */}
        <textarea
          ref={(element) => {
            input.current = element
            setInputElement(element)
          }}
          aria-label={`${WORKBENCH_LABEL} input`}
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          rows={1}
          // `sr-only` sets `white-space: nowrap`; WebKit then stores a typed space as U+00A0 so it
          // survives collapsing. A text control keeps its own white space.
          className="sr-only whitespace-pre-wrap!"
          onFocus={() => handle.current?.set_focused(true)}
          onBlur={() => handle.current?.set_focused(false)}
          onInput={(event) => {
            const field = event.currentTarget
            if (
              event.nativeEvent instanceof InputEvent &&
              event.nativeEvent.isComposing
            )
              return
            // Undo and redo are the workbench's own (Cmd+Z and Cmd+Shift+Z reach the panel as
            // keys); the field's native history would replay stale text into it.
            if (
              event.nativeEvent instanceof InputEvent &&
              event.nativeEvent.inputType.startsWith('history')
            ) {
              settle(field, mirror.current)
              return
            }
            // The overlay may have mirrored the focused field's text into this one: only what is
            // new against the mirror was typed.
            const typed = typedSince(mirror.current, field.value)
            if (typed)
              handle.current?.text_input(JSON.stringify({ text: typed }))
            settle(field, mirror.current)
          }}
          onCompositionStart={() =>
            handle.current?.composition(JSON.stringify({ type: 'start' }))
          }
          onCompositionUpdate={(event) =>
            handle.current?.composition(
              JSON.stringify({ type: 'update', text: event.data }),
            )
          }
          onCompositionEnd={(event) => {
            // The committed text goes in as the end of the composition, once; the input event
            // that follows it in some browsers finds the field already cleared.
            handle.current?.composition(
              JSON.stringify({ type: 'end', text: event.data }),
            )
            settle(event.currentTarget, mirror.current)
          }}
          onPaste={(event) => {
            event.preventDefault()
            handle.current?.paste(event.clipboardData.getData('text'))
          }}
        />
        {/* Over the grid, under whatever the page draws over it (the cabinet, the face). */}
        <IconLayer store={icons} handle={mountedHandle} />
        {mountedHandle && project ? (
          <WorkbenchCabinet
            host={mountedHandle}
            overlay={root}
            projectId={project.id}
            projectTitle={project.title}
          />
        ) : null}
        {mountedHandle ? <WorkbenchFace host={mountedHandle} /> : null}
        {children?.(feed, {
          handle: mountedHandle,
          root,
          input: inputElement,
          mirror,
        })}
      </div>
    </FeedContext.Provider>
  )
}

/** What `Workbench` owns for one signed-in account; all of it lets go together. */
type Owners = { adapter: AccountAdapter; stop: () => void }

/**
 * The workbench of a project: the environment, then every owner that has a module (files, documents,
 * scm, language, run and search, the conversation and its side chats, the layout, the terminal, and the
 * clipboard and artifact cabinet of this app) under the adapter. Capabilities come from the adapter,
 * which derives them from the host's operations.
 *
 * Everything kept on this device is scoped by the signed-in account (`session.bootstrap`). When the
 * account changes the adapter retires itself and tells the core; the owners of the old account are then
 * let go, new ones are built for the new account, and the core is asked to load that account's
 * arrangements. A sign-out or a revoked access shows the app's own sign-in page instead.
 */
export function Workbench({
  projectId,
  projectTitle = 'This project',
  shown = true,
  companion = false,
  children,
}: {
  projectId: string
  projectTitle?: string
  /** Whether the person can see it (WorkbenchSurface). */
  shown?: boolean
  /** Whether it stands beside the conversation (WorkbenchSurface). */
  companion?: boolean
  children?: (feed: SemanticsFeed) => ReactNode
}) {
  const runtime = useConversationRuntime()
  // One side-chat owner per project: a fresh side chat makes its thread in the project shown now,
  // and switching projects lets the old project's side chats go (React's "adjust state when a prop
  // changes" pattern, so the switch happens in the same render).
  const ownSideChats = () => ({
    projectId,
    chats: createSideChats((request) =>
      createSideChatModel(projectId, request),
    ),
  })
  const [side, setSide] = useState(ownSideChats)
  if (side.projectId !== projectId) setSide(ownSideChats())
  const sideChats = side.chats
  const [access, setAccess] = useState<{
    code: 'signed_out' | 'forbidden'
    reason: string
  }>()
  const connect = useCallback(
    (dispatch: Dispatch, surface: SurfaceHost): Adapter => {
      let disposed = false
      let current: Owners | undefined
      /** Effects asked for while no adapter serves (before the account is known, or between accounts). */
      let waiting: Effect[] = []
      // The core keeps the person's current appearance so a saved arrangement can carry it: told
      // now, before any save or the arrangements load, and again on every change.
      const stopTelling = tellAppearance(useAppearance, (value) =>
        surface.arrangement({ type: 'appearance', value }),
      )

      async function build(force: boolean): Promise<Owners> {
        const identity = await bootstrap(force)
        const account = accountKey(identity)
        const directory = checkpointDirectory(account)
        const environment = connectEnvironment(projectId)
        const workspaceId = environment.workspaceId
        // The core is told which workspace it shows as soon as it is known, and again when the
        // host's environment (its epoch) changes.
        let announced: string | undefined
        const announce = () => {
          const { workspaceId: workspace, epoch } = environment.identity
          const key = `${workspace}/${epoch ?? ''}`
          if (key === announced) return
          announced = key
          dispatch({
            channel: 'host',
            type: 'workspaceChanged',
            workspace,
            ...(epoch ? { environment: epoch } : {}),
          })
        }
        announce()
        const unsubscribe = environment.subscribe(announce)
        // One store per account: the layout checkpoint and the document drafts share it.
        const store = createLocalStore({ directory, account })
        const checkpoints = createCheckpoints({ directory, account, store })
        const layout = createLayout({ environment, checkpoints })
        // The terminal owner and its live stream come from the environment's own SDK build.
        const { host, stop: stopTerminal } = connectTerminalHost(environment)
        const files = createFiles(environment)
        const language = createLanguage(environment)
        const runner = createRunner(environment)
        const search = createSearch(environment)
        const conversation = createConversation({
          runtime,
          sideChats: sideChats.sideChats,
          services: conversationServices,
          workspaceId,
        })
        const threads = createThreads({
          client: theorem(),
          organization: readOrganization,
          mutate,
          mutateThread,
          open: () => {
            const threadId = conversation.snapshot().conversationId
            return threadId ? { projectId, threadId } : undefined
          },
        })
        // The listing marks the open thread; it is read again when another conversation opens.
        let openThread = conversation.snapshot().conversationId
        const stopFollowing = conversation.subscribe((snapshot) => {
          if (snapshot.conversationId === openThread) return
          openThread = snapshot.conversationId
          threads.refresh()
        })
        const drafts = createDraftStore({ store, workspaceId })
        const documentOwner = createDocuments(environment, { drafts })
        const documents = createDocumentsPort({
          documents: documentOwner,
          files,
          history: (flush) => createHistory(environment, { flush }),
        })
        const watch = createAccountWatch({
          identify: () => bootstrap(true),
          initial: identity,
        })
        const delegations = createDelegations({
          workspaceId,
          client: theorem(),
          onAccountChange: (listener) => watch.onChange(() => listener()),
        })
        const refresh = () => void watch.refresh()
        window.addEventListener('focus', refresh)
        const adapter = createAdapter({
          environment,
          files,
          terminal: { create: () => new TerminalSession(host), host },
          layout,
          documents,
          scm: createScmPort(createScm(environment)),
          language: languagePortFor(language, documents),
          run: createRunPort(runner),
          search: createSearchPort(search),
          conversation: createConversationPort({
            conversation,
            project: projectId,
          }),
          threads: createThreadsPort(threads),
          artifacts: createArtifactsPort(projectId),
          delegations: createDelegationsPort(delegations),
          clipboard: createClipboardPort(),
          appearance: createAppearancePort(useAppearance),
          dispatch,
          account: watch,
          retiring: [store, { retire: () => documentOwner.dispose() }],
        })
        return {
          adapter,
          stop() {
            window.removeEventListener('focus', refresh)
            watch.dispose()
            unsubscribe()
            adapter.dispose()
            language.dispose()
            delegations.dispose()
            runner.dispose()
            search.dispose()
            stopFollowing()
            conversation.dispose()
            stopTerminal()
            void checkpoints.dispose()
            environment.dispose()
          },
        }
      }

      async function start(force: boolean) {
        let owners: Owners
        try {
          owners = await build(force)
        } catch (error) {
          if (disposed) return
          const status = statusOf(error)
          if (status === 401 || status === 403)
            setAccess({
              code: status === 401 ? 'signed_out' : 'forbidden',
              reason: error instanceof Error ? error.message : String(error),
            })
          else console.warn('The workbench could not start', error)
          return
        }
        if (disposed) {
          owners.stop()
          return
        }
        current = owners
        owners.adapter.onRetired((retirement) => {
          if (disposed || current !== owners) return
          current = undefined
          owners.stop()
          if (retirement.code === 'account_changed') void start(true)
          else setAccess(retirement)
        })
        for (const effect of waiting.splice(0)) owners.adapter.perform(effect)
        // The new account's saved arrangements. The old adapter already told the core the
        // account changed; the core is not told again.
        surface.arrangement({ type: 'load' })
      }
      void start(false)

      return {
        perform(effect) {
          if (current) current.adapter.perform(effect)
          else waiting.push(effect)
        },
        dispose() {
          disposed = true
          stopTelling()
          waiting = []
          current?.stop()
          current = undefined
        },
      }
    },
    [projectId, runtime, sideChats],
  )
  if (access)
    return (
      <SignIn
        failure={access.code === 'forbidden' ? 'access_denied' : undefined}
        returnTo="/"
      />
    )
  return (
    <WorkbenchSurface
      key={projectId}
      connect={connect}
      project={{ id: projectId, title: projectTitle }}
      shown={shown}
      companion={companion}
    >
      {(feed, parts) => (
        <>
          <sideChats.Hosts />
          <SemanticOverlay feed={feed} parts={parts} />
          {children?.(feed)}
        </>
      )}
    </WorkbenchSurface>
  )
}
