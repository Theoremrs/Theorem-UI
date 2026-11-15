// SOURCING: hand-roll over React's useSyncExternalStore and the wire's SemanticTree: no library renders an external accessibility tree as ARIA DOM. The reducer and store are semantic-overlay/tree.ts, the role, state and structure mapping is semantic-overlay/aria.ts (WAI-ARIA 1.2 and the Authoring Practices patterns named there), and the input mirror is semantic-overlay/mirror.ts. @base-ui/react has no component for this: it renders its own controls, not roles for cells drawn elsewhere.
import {
  createContext,
  memo,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import type { CSSProperties, ReactNode } from 'react'
import type { Node } from '@/lib/workbench/wire'
import type { WorkbenchHandle } from '@/terminal-wasm/theorem_terminal'
import {
  ACTIVATABLE,
  SPEAKS_ITS_NAME,
  ariaAttributes,
  describe,
  descriptionId,
  elementId,
  panelOf,
  primaryAction,
} from './semantic-overlay/aria'
import type { Placed } from './semantic-overlay/aria'
import { bindInput } from './semantic-overlay/input'
import { createStore, parseTree, parseUpdate } from './semantic-overlay/tree'
import type { Store } from './semantic-overlay/tree'
import type { SemanticsFeed, SurfaceParts } from './workbench'

/** What the overlay needs of the mounted core. `act` is optional: a core built before it existed still presents everything. */
export type OverlayHandle = Pick<WorkbenchHandle, 'semantics' | 'cell_size'> & {
  act?: (action: string, panel?: string) => string
}

/** What running an action answered: the core's own words, or why nothing ran. */
export type Activation =
  | { ran: true; outcome: 'accepted' | 'refused'; reason?: string }
  | { ran: false; why: 'no-action' | 'unavailable' | 'no-entry-point' }

/**
 * What a screen reader's activation of a node does: runs the node's first action as the person
 * through the core's `act`, the same path a key takes. A node with no action, an action that is
 * unavailable, or a core without `act` does nothing and says why; it never throws.
 */
export function activate(
  handle: Pick<OverlayHandle, 'act'> | undefined,
  node: Node,
  panel: string | undefined,
): Activation {
  const action = primaryAction(node)
  if (!action) return { ran: false, why: 'no-action' }
  if (!action.enabled || node.state.disabled) return { ran: false, why: 'unavailable' }
  if (!handle?.act) return { ran: false, why: 'no-entry-point' }
  try {
    const answer = JSON.parse(handle.act(action.id, panel)) as {
      outcome?: string
      reason?: string
    }
    return answer.outcome === 'refused'
      ? { ran: true, outcome: 'refused', reason: answer.reason }
      : { ran: true, outcome: 'accepted' }
  } catch {
    return { ran: false, why: 'no-entry-point' }
  }
}

/** The trailing wait before a status line is spoken, so a line that changes with every key is read once, at rest. */
const SETTLE_MS = 500

interface Context {
  store: Store
  prefix: string
  handle: OverlayHandle | undefined
  settleMs: number
}

const OverlayContext = createContext<Context | undefined>(undefined)

/** A cell count as a CSS length in the measured cell, relative to the element it sits in. */
const cells = (count: number, unit: 'w' | 'h') =>
  `calc(var(--wb-cell-${unit}) * ${Number.isFinite(count) ? Math.trunc(count) : 0})`

const HIDDEN_POINTER: CSSProperties = { pointerEvents: 'none' }

/**
 * A live region's words. It is empty when it first appears and filled a moment later, because a
 * region that exists before its words arrive is the one every screen reader speaks; later changes are
 * spoken once the text has held still for `settleMs` (0 for an alert, which is spoken as it arrives).
 */
function Spoken({ text, settleMs }: { text: string; settleMs: number }) {
  const [shown, setShown] = useState('')
  useEffect(() => {
    if (text === shown) return
    const wait = shown === '' ? 0 : settleMs
    const timer = setTimeout(() => setShown(text), wait)
    return () => clearTimeout(timer)
  }, [text, shown, settleMs])
  return shown
}

const NodeView = memo(function NodeView({
  placed,
  originX,
  originY,
}: {
  placed: Placed
  originX: number
  originY: number
}) {
  const context = useContext(OverlayContext)!
  const { store, prefix, handle, settleMs } = context
  const node = useSyncExternalStore(
    (listener) => store.subscribeNode(placed.id, listener),
    () => store.node(placed.id),
  )
  const mirrored = useSyncExternalStore(
    store.subscribeActive,
    () => store.mirrored() === placed.id,
  )
  if (!node) return null
  const id = elementId(prefix, node.id)
  const attributes = ariaAttributes(node, placed.role)
  const description = describe(node, panelOf(store.parent, node.id))
  const rect = node.rect
  const style: CSSProperties = {
    position: 'absolute',
    left: cells(rect.x - originX, 'w'),
    top: cells(rect.y - originY, 'h'),
    width: cells(rect.width, 'w'),
    height: cells(rect.height, 'h'),
  }
  const action = primaryAction(node)
  const onClick =
    action && ACTIVATABLE.has(placed.role)
      ? () => {
          activate(handle, node, panelOf(store.parent, node.id))
        }
      : undefined
  let words: ReactNode = node.text
  if (SPEAKS_ITS_NAME.has(placed.role))
    words = (
      <Spoken
        text={node.name}
        settleMs={placed.role === 'alert' ? 0 : node.id === 'notice' ? 0 : settleMs}
      />
    )
  return (
    <>
      <div
        {...attributes}
        id={id}
        style={style}
        onClick={onClick}
        aria-describedby={description ? descriptionId(id) : undefined}
        // The input field is this node's owner while it holds its text: one owner per node.
        aria-hidden={mirrored ? 'true' : undefined}
        data-node={node.id}
      >
        {words}
        {placed.children.map((child) => (
          <NodeView key={child.id} placed={child} originX={rect.x} originY={rect.y} />
        ))}
      </div>
      {description ? (
        <span id={descriptionId(id)} hidden>
          {description}
        </span>
      ) : null}
    </>
  )
})

/**
 * The semantic tree the core publishes, as the DOM that assistive technology reads over the cell
 * grid: one element per node, laid over the node's cells, invisible and never the target of the
 * pointer. The grid stays `aria-hidden`; this is the one accessible presentation of the interface.
 *
 * Focus stays in the input field. Where the core says focus is, the field's `aria-activedescendant`
 * names that node's element; when it is a text field the core publishes the text and caret of, the
 * field holds that text and caret itself (see `mirror.ts`) and is that node's one accessible owner.
 */
export function SemanticOverlay({
  feed,
  parts,
  settleMs = SETTLE_MS,
}: {
  feed: SemanticsFeed
  parts: SurfaceParts
  settleMs?: number
}) {
  const [store] = useState(createStore)
  const prefix = `wbo${useId().replace(/[^A-Za-z0-9-]/g, '')}`
  const layer = useRef<HTMLDivElement>(null)
  const handle = parts.handle as OverlayHandle | undefined

  const shape = useSyncExternalStore(store.subscribe, store.shape)

  // The feed into the store. A diff that does not fit means an update was missed: ask the core for
  // the whole tree instead of showing a half-patched interface.
  useEffect(() => {
    const resync = () => {
      const json = handle?.semantics()
      const tree = json ? parseTree(json) : undefined
      if (tree) store.replace(tree)
    }
    const take = (json: string) => {
      const update = parseUpdate(json)
      if (!update) return
      if (!store.push(update)) resync()
    }
    if (feed.latest !== undefined) take(feed.latest)
    else if (handle) resync()
    return feed.subscribe(take)
  }, [feed, handle, store])

  // The measured cell, as CSS lengths on the layer: a change of cell moves every element without
  // rendering one. The core reports it once a frame has measured, so wait for that.
  useEffect(() => {
    const element = layer.current
    if (!element || !handle) return
    let frame = 0
    const measure = () => {
      const json = handle.cell_size()
      if (!json) return false
      const cell = JSON.parse(json) as { width: number; height: number }
      element.style.setProperty('--wb-cell-w', `${cell.width}px`)
      element.style.setProperty('--wb-cell-h', `${cell.height}px`)
      return true
    }
    const wait = () => {
      if (!measure()) frame = requestAnimationFrame(wait)
    }
    wait()
    const stop = store.subscribe(() => void measure())
    const observer = new ResizeObserver(() => void measure())
    if (parts.root) observer.observe(parts.root)
    window.addEventListener('resize', wait)
    return () => {
      cancelAnimationFrame(frame)
      stop()
      observer.disconnect()
      window.removeEventListener('resize', wait)
    }
  }, [handle, parts.root, store])

  // Focus, for assistive technology, without moving it: the input field keeps DOM focus and names
  // the node the core says is focused; when that node is a text field it holds its text and caret.
  const { input, mirror } = parts
  useEffect(
    () => (input ? bindInput(input, mirror, store, prefix) : undefined),
    [input, mirror, prefix, store],
  )

  const context: Context = { store, prefix, handle, settleMs }
  return (
    <OverlayContext.Provider value={context}>
      <div
        ref={layer}
        data-semantic-overlay=""
        // Invisible and inert to the pointer: the cells are the interface, a press goes to the grid
        // beneath. Elements keep their layout, so a screen reader's focus ring and touch exploration
        // land on the node.
        style={{
          ...HIDDEN_POINTER,
          position: 'absolute',
          inset: 0,
          overflow: 'visible',
          opacity: 0,
          userSelect: 'none',
        }}
      >
        {shape ? <NodeView placed={shape} originX={0} originY={0} /> : null}
      </div>
    </OverlayContext.Provider>
  )
}
