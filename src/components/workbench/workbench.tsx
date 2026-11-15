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
import { createFiles } from '@/lib/workbench/files/files'
import {
  checkpointDirectory,
  createCheckpoints,
  createLayout,
} from '@/lib/workbench/layout'
import { TerminalSession, terminalHost } from '@/lib/workbench/terminal'
import type { Completion, Effect, HostMessage } from '@/lib/workbench/wire'
import type { WorkbenchHandle } from '@/terminal-wasm/theorem_terminal'

/** Answers to the workbench: completions of its effects and events nobody asked for. */
export type Dispatch = (message: Completion | HostMessage) => void

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

function pointerJson(
  type: 'down' | 'up' | 'move' | 'wheel',
  event: PointerEvent | WheelEvent | React.PointerEvent,
) {
  return JSON.stringify({
    type,
    button: ['left', 'middle', 'right'][
      'button' in event && event.button >= 0 && event.button <= 2
        ? event.button
        : 0
    ],
    clientX: event.clientX,
    clientY: event.clientY,
    deltaX: 'deltaX' in event ? event.deltaX : 0,
    deltaY: 'deltaY' in event ? event.deltaY : 0,
    deltaMode: 'deltaMode' in event ? event.deltaMode : 0,
    // The press count, as the DOM gives it; a pointer event that carries none is a single press.
    detail: event.detail || 1,
    ctrlKey: event.ctrlKey,
    altKey: event.altKey,
    shiftKey: event.shiftKey,
    metaKey: event.metaKey,
  })
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
    const { handle: mounting, sink } = mountWorkbench(element)
    sink.semantics = (json) => feed.push(json)
    void mounting.then((mounted) => {
      if (disposed) return
      handle.current = mounted
      adapter = latest.current((message) => {
        if (!disposed)
          mounted.dispatch(
            // The core's inbound type is tagged by channel; a completion is the one with an effect.
            JSON.stringify({
              channel: 'effect' in message ? 'completion' : 'host',
              ...message,
            }),
          )
      })
      sink.effect = (json) => adapter?.perform(JSON.parse(json) as Effect)
      mounted.resize()
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
          if (event.nativeEvent.isComposing) return
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
          onMouseDown={(event) => {
            event.preventDefault()
            input.current?.focus({ preventScroll: true })
          }}
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId)
            handle.current?.pointer(pointerJson('down', event))
          }}
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
            if (field.value)
              handle.current?.text_input(JSON.stringify({ text: field.value }))
            field.value = ''
          }}
          onCompositionEnd={(event) => {
            if (event.data)
              handle.current?.text_input(JSON.stringify({ text: event.data }))
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
 * The workbench of a project: the environment, then the owners that exist today (files, layout, the
 * terminal) under the adapter. Owners with no module yet are left out, so the adapter answers their
 * effects `owner_unavailable`.
 */
export function Workbench({
  projectId,
  children,
}: {
  projectId: string
  children?: (feed: SemanticsFeed) => ReactNode
}) {
  const connect = useCallback(
    (dispatch: Dispatch): Adapter => {
      const environment = connectEnvironment(projectId)
      const workspaceId = environment.workspaceId
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
      // The core is told which workspace it shows as soon as it is known, and again when the
      // host's environment (its epoch) changes.
      let announced: string | undefined
      const announce = () => {
        const { workspaceId: workspace, epoch } = environment.identity
        const key = `${workspace}/${epoch ?? ''}`
        if (key === announced) return
        announced = key
        dispatch({
          type: 'workspaceChanged',
          workspace,
          ...(epoch ? { environment: epoch } : {}),
        })
      }
      announce()
      const unsubscribe = environment.subscribe(announce)
      const adapter = createAdapter({
        environment,
        files: createFiles(environment),
        terminal: { create: () => new TerminalSession(host), host },
        layout,
        dispatch,
      })
      return {
        perform: adapter.perform,
        dispose() {
          unsubscribe()
          adapter.dispose()
          live.close()
          void checkpoints.dispose()
          environment.dispose()
        },
      }
    },
    [projectId],
  )
  return (
    <WorkbenchSurface key={projectId} connect={connect}>
      {children}
    </WorkbenchSurface>
  )
}
