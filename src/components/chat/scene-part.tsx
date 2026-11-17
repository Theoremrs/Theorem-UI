// SOURCING: the platform's <dialog> (open in the reply, showModal() to expand into the top layer) and postMessage to the scene page; React layout effects for the frame's lifetime as block-frame.tsx does; ui/button for the card's controls
//
// A reply's interactive scene, drawn in the reply. The frame is made with its
// address set and the listener in place before it is added to the page, as
// block-frame.tsx does, so the page's first `host-ready` is never missed.
//
// Expanding does not move the frame: moving an iframe in the document reloads
// it and the person loses where they were in the scene. The card is a
// <dialog> that is open in the reply and shown modal to expand. A modal
// dialog is drawn in the top layer, which a message row's
// `content-visibility: auto` containment cannot clip.
//
// The artifact is the agent's own code and draws its own title, so the card
// has no chrome: a corner control to expand it, and, when it is needed, a
// strip under the scene with the error that stopped the code and a Fix that
// asks the agent to mend it. Nothing of the card's is drawn over the scene.
// A part the reader picks gets a callout the page itself draws on the part;
// when the conversation can take a question the callout carries Ask, and the
// page tells the card which part was asked about. Inline, the card is wider
// than the reading column (--spacing-artifact), centred on it.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { useAui, useAuiState } from '@assistant-ui/react'
import { Icon } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { askAbout } from './composer-references'
import {
  checkpointFor,
  checkpointKey,
  dropCheckpoint,
  keepCheckpoint,
} from './scene-checkpoints'
import {
  errorLine,
  readFrameMessage,
  repairRequest,
  SCENE_HOST_PATH,
  SCENE_SANDBOX,
} from './scene-model'
import { useSceneTheme } from './scene-theme'
import type {
  HostMessage,
  ModuleError,
  Scene,
  SceneEntity,
  SceneLayout,
  SceneTheme,
} from './scene-model'

/**
 * Open in the reply. Not `show()`: that moves focus into the dialog, and a
 * reply that arrives while the person is typing must leave the composer
 * focused.
 */
function openInline(node: HTMLDialogElement) {
  node.setAttribute('open', '')
}

/** How long the page may take to draw the package before the card gives up. */
export const SCENE_MOUNT_TIMEOUT_MS = 20_000

/**
 * Where the scene page is loaded from and how long it may take to mount.
 * The authority's page by default; the review stories serve a committed
 * build of the same page.
 */
export const SceneHost = createContext({
  path: SCENE_HOST_PATH,
  mountTimeoutMs: SCENE_MOUNT_TIMEOUT_MS,
})

type Phase = 'loading' | 'ready' | 'failed'

/**
 * How many scenes in the conversation keep a live page at once. Past it, the
 * one longest out of view is suspended: its last checkpoint is kept, a still
 * of its stage stands in for it, and it mounts again where it was when it
 * comes back into view. Only a page that takes checkpoints is suspended.
 */
export const LIVE_SCENES = 3

type LiveScene = {
  onScreen: boolean
  seenAt: number
  canSuspend: () => boolean
  suspend: () => void
}

const liveScenes = new Set<LiveScene>()

function suspendExcess() {
  const offscreen = [...liveScenes]
    .filter((scene) => !scene.onScreen && scene.canSuspend())
    .sort((a, b) => a.seenAt - b.seenAt)
  const excess = liveScenes.size - LIVE_SCENES
  for (const scene of offscreen.slice(0, Math.max(0, excess))) scene.suspend()
}

/** Within this much of the viewport a scene counts as in view. */
const NEAR_VIEW = '600px 0px'

/** The error the agent's code stopped with, and whether Fix has asked about it. */
type Fault = { error: ModuleError; asked: boolean }

export type SceneCardProps = {
  scene: Scene
  /** The conversation's tokens, posted with the package. */
  theme: SceneTheme
  /**
   * Puts the part the reader asked about in the composer as a reference.
   * When set, the callout the page draws on a picked part carries Ask.
   */
  onAsk?: (entity: SceneEntity) => void
  /** Asks the agent to fix the code that failed. */
  onRepair?: (error: ModuleError) => void
  /**
   * `reply`: in the conversation, inline with an Expand into the top layer.
   * `panel`: filling a workspace panel in the full layout, with nothing to
   * expand into.
   */
  placement?: 'reply' | 'panel'
}

export function SceneCard({
  scene,
  theme,
  onAsk,
  onRepair,
  placement = 'reply',
}: SceneCardProps) {
  const inPanel = placement === 'panel'
  const dialog = useRef<HTMLDialogElement>(null)
  const holder = useRef<HTMLDivElement>(null)
  const expandButton = useRef<HTMLButtonElement>(null)
  const frame = useRef<HTMLIFrameElement | null>(null)
  const switching = useRef(false)
  // What the current page last drew with; empty until it can take a mount.
  const drawnWith = useRef<{ theme: string; asks: boolean } | undefined>(
    undefined,
  )
  const [phase, setPhase] = useState<Phase>('loading')
  const [layout, setLayout] = useState<SceneLayout>(inPanel ? 'full' : 'inline')
  const [fault, setFault] = useState<Fault>()
  const [suspended, setSuspended] = useState(false)
  // A still of the stage while the scene is suspended and until it mounts again.
  const [poster, setPoster] = useState('')
  // The page takes checkpoints, live theme changes and poster requests.
  const capable = useRef(false)
  const suspending = useRef(false)
  const posterWaiter = useRef<((image: string) => void) | undefined>(undefined)
  const label = scene.title ?? 'Interactive scene'
  const host = useContext(SceneHost)
  const asks = onAsk !== undefined
  const themeKey = JSON.stringify(theme)

  // The latest values the frame's listener reads, without making a new frame.
  const latest = useRef({ scene, layout, theme, themeKey, asks, onAsk })
  useEffect(() => {
    latest.current = { scene, layout, theme, themeKey, asks, onAsk }
  })

  const post = useCallback((message: HostMessage) => {
    // The page's origin is opaque, so no narrower target can be named; the
    // page reads only messages whose source is its parent.
    frame.current?.contentWindow?.postMessage(message, '*')
  }, [])

  /** Draw the package in the current theme, from where the reader had got to. */
  const mount = useCallback(() => {
    const current = latest.current
    drawnWith.current = { theme: current.themeKey, asks: current.asks }
    const checkpoint = checkpointFor(checkpointKey(current.scene))
    post({
      type: 'sceneos:mount',
      package: current.scene.scenePackage,
      theme: current.theme,
      ask: current.asks,
      ...(checkpoint && { checkpoint }),
    })
  }, [post])

  const place = useCallback(
    (next: SceneLayout) => {
      const node = dialog.current
      if (!node) return
      switching.current = true
      try {
        if (node.open) node.close()
        if (next === 'full') node.showModal()
        else openInline(node)
      } finally {
        switching.current = false
      }
      setLayout(next)
      post({ type: 'sceneos:layout', layout: next })
    },
    [post],
  )

  const collapse = useCallback(() => {
    if (inPanel || latest.current.layout !== 'full') return
    place('inline')
    expandButton.current?.focus()
  }, [place, inPanel])

  // Shown before the frame is added, so the page first lays out at its size.
  useLayoutEffect(() => {
    const node = dialog.current
    if (node && !node.open) openInline(node)
  }, [])

  // One frame per scene package: a reply that streams more text re-renders
  // this card without reloading the scene.
  const sceneKey = scene.packageHash ?? scene.sceneId
  useLayoutEffect(() => {
    const parent = holder.current
    if (!parent || suspended) return
    setPhase('loading')
    setFault(undefined)
    drawnWith.current = undefined
    const element = document.createElement('iframe')
    element.title = label
    element.setAttribute('sandbox', SCENE_SANDBOX)
    element.referrerPolicy = 'no-referrer'
    element.className = 'block size-full border-0 bg-transparent'
    let mounted = false
    const timer = window.setTimeout(() => {
      if (mounted) return
      setPhase('failed')
      // A page that took the package and never answered is stuck in the
      // agent's code; a page that never loaded is not the agent's to fix.
      if (drawnWith.current !== undefined)
        setFault({
          error: {
            stage: 'mount',
            message: `mount did not return within ${host.mountTimeoutMs / 1000} seconds`,
          },
          asked: false,
        })
    }, host.mountTimeoutMs)
    const onMessage = (event: MessageEvent) => {
      if (!element.contentWindow || event.source !== element.contentWindow)
        return
      const message = readFrameMessage(event.data)
      if (!message) return
      switch (message.type) {
        case 'sceneos:host-ready':
          // Also after the page reloads, so it is told again.
          mount()
          post({ type: 'sceneos:layout', layout: latest.current.layout })
          return
        case 'sceneos:mounted':
          mounted = true
          window.clearTimeout(timer)
          capable.current = message.restore !== undefined
          // A checkpoint for another revision, or one the page could not
          // replay, is not offered again.
          if (message.restore === 'stale' || message.restore === 'incompatible')
            dropCheckpoint(checkpointKey(latest.current.scene))
          setPoster('')
          setPhase(message.ok ? 'ready' : 'failed')
          setFault(message.error && { error: message.error, asked: false })
          return
        case 'sceneos:state':
          keepCheckpoint(
            checkpointKey(latest.current.scene),
            message.checkpoint,
          )
          return
        case 'sceneos:poster':
          posterWaiter.current?.(message.image)
          return
        case 'sceneos:error':
          setFault({ error: message.error, asked: false })
          return
        case 'sceneos:ask':
          // Ask on the callout the page drew on the picked part.
          latest.current.onAsk?.(message.entity)
          return
        case 'sceneos:dismiss':
          collapse()
      }
    }
    window.addEventListener('message', onMessage)
    element.src = host.path
    parent.append(element)
    frame.current = element
    return () => {
      window.removeEventListener('message', onMessage)
      window.clearTimeout(timer)
      element.remove()
      if (frame.current === element) frame.current = null
    }
    // `label` names the frame when it is made; a later title does not remake it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sceneKey, host, post, collapse, mount, suspended])

  // A palette or mode switch repaints the running scene in place. A
  // conversation that starts or stops taking questions, or a page that cannot
  // repaint, draws the package again in the same frame, from the last
  // checkpoint when the page keeps them.
  useEffect(() => {
    const drawn = drawnWith.current
    if (drawn === undefined) return
    if (drawn.theme === themeKey && drawn.asks === asks) return
    if (capable.current && drawn.asks === asks) {
      drawnWith.current = { theme: themeKey, asks }
      post({ type: 'sceneos:theme', theme: latest.current.theme })
      return
    }
    mount()
  }, [themeKey, asks, post, mount])

  // Out of view in a long conversation: past LIVE_SCENES live pages, the
  // scene longest out of view gives up its page for a still of its stage.
  const suspend = useCallback(async () => {
    const expanded = () => latest.current.layout === 'full'
    if (suspending.current || expanded()) return
    suspending.current = true
    const image = await new Promise<string>((resolve) => {
      const timer = window.setTimeout(() => resolve(''), 1500)
      posterWaiter.current = (still) => {
        window.clearTimeout(timer)
        resolve(still)
      }
      post({ type: 'sceneos:poster-request' })
    })
    posterWaiter.current = undefined
    suspending.current = false
    // Expanded while the still was taken: it stays live.
    if (expanded()) return
    setPoster(image)
    setSuspended(true)
  }, [post])

  useEffect(() => {
    const node = dialog.current
    if (inPanel || !node || typeof IntersectionObserver === 'undefined') return
    if (suspended) {
      // Back in view: mount again, where the reader was.
      const observer = new IntersectionObserver(
        ([entry]) => entry?.isIntersecting && setSuspended(false),
        { rootMargin: NEAR_VIEW },
      )
      observer.observe(node)
      return () => observer.disconnect()
    }
    const live: LiveScene = {
      onScreen: true,
      seenAt: Date.now(),
      canSuspend: () => capable.current,
      suspend: () => void suspend(),
    }
    liveScenes.add(live)
    const observer = new IntersectionObserver(
      ([entry]) => {
        live.onScreen =
          Boolean(entry?.isIntersecting) || latest.current.layout === 'full'
        if (live.onScreen) live.seenAt = Date.now()
        else suspendExcess()
      },
      { rootMargin: NEAR_VIEW },
    )
    observer.observe(node)
    suspendExcess()
    return () => {
      observer.disconnect()
      liveScenes.delete(live)
    }
  }, [inPanel, suspended, suspend])

  // Escape asks a modal dialog to close: collapse instead. Where the browser
  // does not let that be refused, the dialog closes and is shown again inline.
  useEffect(() => {
    const node = dialog.current
    if (!node) return
    const onCancel = (event: Event) => {
      event.preventDefault()
      collapse()
    }
    const onClose = () => {
      // place() closes and reopens in one task: its own close is either seen
      // while it switches or, where the event is queued, after the dialog is
      // open again. A dialog that is still closed was closed by the browser.
      if (switching.current || node.open) return
      openInline(node)
      setLayout('inline')
      post({ type: 'sceneos:layout', layout: 'inline' })
      expandButton.current?.focus()
    }
    node.addEventListener('cancel', onCancel)
    node.addEventListener('close', onClose)
    return () => {
      node.removeEventListener('cancel', onCancel)
      node.removeEventListener('close', onClose)
    }
  }, [collapse, post])

  const full = layout === 'full'
  const failed = phase === 'failed'
  const repair =
    fault && onRepair
      ? () => {
          onRepair(fault.error)
          setFault({ ...fault, asked: true })
        }
      : undefined

  return (
    <dialog
      ref={dialog}
      aria-label={label}
      data-slot="theorem-scene-card"
      data-scene-id={scene.sceneId}
      data-layout={layout}
      data-phase={phase}
      data-suspended={suspended || undefined}
      className={cn(
        'relative max-w-none flex-col overflow-hidden p-0 text-ink open:flex',
        inPanel
          ? // In a panel: the panel is the frame.
            'static m-0 size-full max-h-none bg-transparent'
          : [
              // A shown dialog sits in the reply like any other card, wider
              // than the reading column and centred on it.
              'my-3 rounded-artifact border border-separator bg-artifact',
              '[--scene-width:min(calc(100cqw-5rem),var(--spacing-artifact))] mx-[calc((100%-var(--scene-width))/2)] w-(--scene-width)',
              // Expanded: the top layer, over the whole window.
              '[&:modal]:fixed [&:modal]:inset-2 [&:modal]:m-0 [&:modal]:size-auto [&:modal]:max-h-none sm:[&:modal]:inset-6',
              'backdrop:bg-black/40 supports-backdrop-filter:backdrop:backdrop-blur-xs',
            ],
      )}
    >
      <div
        className={cn(
          'relative w-full',
          full ? 'min-h-0 flex-1' : 'h-[min(520px,72dvh)]',
          failed && 'hidden',
        )}
      >
        <div ref={holder} className="size-full" />
        {poster && (suspended || phase === 'loading') && (
          // The stage as it was, while the scene is away and until it is back.
          <img
            src={poster}
            alt=""
            className="pointer-events-none absolute inset-0 size-full object-contain"
          />
        )}
        {phase === 'loading' && !poster && (
          <p
            role="status"
            className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-ink-faint"
          >
            Drawing the scene…
          </p>
        )}
      </div>
      {!failed && fault && (
        // Under the scene, not over it: the scene stays whole and usable.
        <FaultNotice
          fault={fault}
          onFix={repair}
          role="status"
          className="shrink-0 border-t border-separator px-3 py-2"
        />
      )}
      {failed && (
        <div role="status" className="flex flex-col gap-2 p-4 text-sm">
          <p className="text-ink-muted">This scene could not be drawn.</p>
          {fault && <FaultNotice fault={fault} onFix={repair} />}
          {scene.fallbackText && <p>{scene.fallbackText}</p>}
        </div>
      )}
      {!inPanel && (!failed || full) && (
        <Button
          ref={expandButton}
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-expanded={full}
          onClick={() => {
            if (full) collapse()
            else {
              place('full')
              // The dialog moves focus into itself; keep it on the toggle,
              // where Escape or a second press collapses it.
              expandButton.current?.focus()
            }
          }}
          className="absolute top-2 right-2 z-10 bg-artifact/70 text-ink-muted hover:text-ink pointer-coarse:size-11"
        >
          {full ? <Icon.Close aria-hidden /> : <Icon.Expand aria-hidden />}
          <span className="sr-only">{full ? 'Collapse' : 'Expand'}</span>
        </Button>
      )}
    </dialog>
  )
}

/**
 * A scene in a reply, wired to its conversation: Fix sends the failure to
 * the agent as the next turn, and a pick becomes a reference to this reply
 * with what was picked as its excerpt. Drawn for a saved `theorem-scene` part
 * and for a scene artifact alike.
 */
export function SceneInReply({ scene }: { scene: Scene }) {
  const aui = useAui()
  const theme = useSceneTheme()
  const threadId = useAuiState((s) => s.threadListItem.remoteId)
  const messageId = useAuiState((s) => s.message.id)
  return (
    <SceneCard
      scene={scene}
      theme={theme}
      onRepair={(error) => aui.thread.append(repairRequest(scene.title, error))}
      onAsk={
        threadId
          ? (entity) =>
              askAbout({
                label: `${scene.title ?? 'Scene'}: ${entity.label ?? entity.id}`,
                excerpt: JSON.stringify({
                  scene: { sceneId: scene.sceneId, title: scene.title },
                  entity,
                }),
                location: {
                  resource: { kind: 'message', threadId, messageId },
                },
              })
          : undefined
      }
    />
  )
}

/** The line the code failed at, and Fix, which asks once per failure. */
function FaultNotice({
  fault,
  onFix,
  role,
  className,
}: {
  fault: Fault
  onFix?: () => void
  role?: 'status'
  className?: string
}) {
  return (
    <div role={role} className={cn('flex items-start gap-2', className)}>
      <code className="line-clamp-3 min-w-0 flex-1 font-mono text-xs break-words text-ink-muted">
        {errorLine(fault.error)}
      </code>
      {onFix && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={fault.asked}
          onClick={onFix}
          className="shrink-0 pointer-coarse:min-h-11"
        >
          Fix
        </Button>
      )}
    </div>
  )
}
