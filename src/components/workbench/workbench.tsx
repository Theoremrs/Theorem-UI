// SOURCING: hand-roll — the mount of the Rust workbench (terminal/src/workbench.rs, Ratzilla on the DOM backend, loaded by terminal-screen's loadWasm exactly as the terminal drawer loads it): no library models a host element that forwards keys, pointer, wheel, IME and paste into a wasm Elm core. The owners are src/lib/workbench (connectEnvironment, createFiles, createLayout, createCheckpoints, createAdapter) and the terminal owner is that folder's terminalHost and TerminalSession over the SDK's WorkspaceLive. The platform's ResizeObserver measures the host.
import { WorkspaceLive } from '@theoremharness/sdk'
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
import { bootstrap } from '@/lib/theorem/client'
import { createAdapter } from '@/lib/workbench/adapter'
import type { Adapter } from '@/lib/workbench/adapter'
import { connectEnvironment } from '@/lib/workbench/environment/connect'
import { createConversation } from '@/lib/workbench/conversation/conversation'
import { createConversationPort } from '@/lib/workbench/conversation/port'
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
import { createDocumentsPort } from '@/lib/workbench/documents/port'
import { createFiles } from '@/lib/workbench/files/files'
import {
  checkpointDirectory,
  createCheckpoints,
  createLayout,
} from '@/lib/workbench/layout'
import { createScm } from '@/lib/workbench/scm/scm'
import { createScmPort } from '@/lib/workbench/scm/port'
import { TerminalSession, terminalHost } from '@/lib/workbench/terminal'
import type { Effect, Inbound } from '@/lib/workbench/wire'
import type { WorkbenchHandle } from '@/terminal-wasm/theorem_terminal'
import { createArtifactsPort, createClipboardPort } from './ports'
import { pointerJson } from './pointer-json'

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
}
const mounts = new WeakMap<
  HTMLElement,
  { handle: Promise<WorkbenchHandle>; sink: Sink }
>()

function mountWorkbench(host: HTMLElement) {
  let mounted = mounts.get(host)
  if (!mounted) {
    const sink: Sink = { effect: () => {}, semantics: () => {} }
    const handle = loadWasm().then((wasm) =>
      wasm.mount_workbench(
        host.id,
        (json: string) => sink.effect(json),
        (json: string) => sink.semantics(json),
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
  children,
}: {
  connect: (dispatch: Dispatch) => Adapter
  /** Called once, after the first frame is on the page: what a story or an oracle waits for. */
  onDrawn?: () => void
  children?: (feed: SemanticsFeed) => ReactNode
}) {
  const hostId = `workbench-${useId().replace(/[^A-Za-z0-9_-]/g, '')}`
  const host = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  const handle = useRef<WorkbenchHandle>(undefined)
  const latest = useRef(connect)
  const drawn = useRef(onDrawn)
  useEffect(() => {
    latest.current = connect
    drawn.current = onDrawn
  })

  const [feed] = useState(createFeed)

  useEffect(() => {
    const element = host.current
    if (!element) return
    let disposed = false
    let adapter: Adapter | undefined
    let stopMotion = () => {}
    const { handle: mounting, sink } = mountWorkbench(element)
    sink.semantics = (json) => feed.push(json)
    void mounting.then((mounted) => {
      if (disposed) return
      handle.current = mounted
      stopMotion = deliverReducedMotion(mounted)
      adapter = latest.current((message) => {
        if (!disposed) mounted.dispatch(JSON.stringify(message))
      })
      sink.effect = (json) => adapter?.perform(JSON.parse(json) as Effect)
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
    // The wheel needs preventDefault, which React's passive listener cannot do.
    const wheel = (event: WheelEvent) => {
      event.preventDefault()
      handle.current?.pointer(pointerJson('wheel', event))
    }
    element.addEventListener('wheel', wheel, { passive: false })
    return () => {
      disposed = true
      sink.effect = () => {}
      stopMotion()
      observer.disconnect()
      element.removeEventListener('wheel', wheel)
      adapter?.dispose()
      handle.current = undefined
    }
  }, [feed])

  return (
    <FeedContext.Provider value={feed}>
      <div
        className="relative flex h-full min-h-0 w-full flex-1 flex-col font-mono text-[12.5px]"
        onKeyDown={(event) => {
          // Keys pressed during an IME composition belong to the composition, never to the
          // workbench; some browsers report them only as keyCode 229.
          if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)
            return
          if (handle.current?.key(event.nativeEvent)) {
            event.preventDefault()
            event.stopPropagation()
          }
        }}
      >
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
          className="relative min-h-0 flex-1 cursor-default touch-none overflow-hidden bg-term whitespace-pre text-term-ink outline-none"
        />
        {/* The host-input service (ARCHITECTURE section 8): the one real text control. It takes
            IME composition, typed text and paste, and forwards what was committed. It sits
            outside the host, whose contents Ratzilla replaces. */}
        <textarea
          ref={input}
          aria-label="Workbench input"
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          rows={1}
          className="sr-only"
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
              field.value = ''
              return
            }
            if (field.value)
              handle.current?.text_input(JSON.stringify({ text: field.value }))
            field.value = ''
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
            event.currentTarget.value = ''
          }}
          onPaste={(event) => {
            event.preventDefault()
            handle.current?.paste(event.clipboardData.getData('text'))
          }}
        />
        {children?.(feed)}
      </div>
    </FeedContext.Provider>
  )
}

/**
 * The workbench of a project: the environment, then every owner that has a module (files, documents,
 * scm, language, run and search, the conversation and its side chats, the layout, the terminal, and the
 * clipboard and artifact cabinet of this app) under the adapter. Capabilities come from the adapter,
 * which derives them from the host's operations.
 */
export function Workbench({
  projectId,
  children,
}: {
  projectId: string
  children?: (feed: SemanticsFeed) => ReactNode
}) {
  const runtime = useConversationRuntime()
  const [sideChats] = useState(() =>
    createSideChats((request) => createSideChatModel(projectId, request)),
  )
  const connect = useCallback(
    (dispatch: Dispatch): Adapter => {
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
      const checkpoints = createCheckpoints({
        directory: checkpointDirectory(workspaceId),
      })
      const layout = createLayout({ environment, checkpoints })
      // The terminal owner listens to its own live stream for the terminal events.
      const live = new WorkspaceLive({
        client: environment.client,
        workspaceId,
      })
      void live.start()
      const host = terminalHost({
        client: environment.client,
        live,
        workspaceId,
        csrfToken: async () => (await bootstrap()).csrfToken,
      })
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
      const documents = createDocumentsPort({
        documents: createDocuments(environment),
        files,
      })
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
        artifacts: createArtifactsPort(projectId),
        clipboard: createClipboardPort(),
        dispatch,
      })
      return {
        perform: adapter.perform,
        dispose() {
          unsubscribe()
          adapter.dispose()
          language.dispose()
          runner.dispose()
          search.dispose()
          conversation.dispose()
          live.close()
          void checkpoints.dispose()
          environment.dispose()
        },
      }
    },
    [projectId, runtime, sideChats],
  )
  return (
    <WorkbenchSurface key={projectId} connect={connect}>
      {(feed) => (
        <>
          <sideChats.Hosts />
          {children?.(feed)}
        </>
      )}
    </WorkbenchSurface>
  )
}
