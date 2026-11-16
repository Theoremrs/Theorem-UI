// SOURCING: @xyflow/react 12 (custom session, output and tools nodes; BaseEdge and getSmoothStepPath for the fork tree's edges, a floating quadratic arc over useInternalNode for session messages (React Flow's floating-edge pattern) with EdgeLabelRenderer for its count; Controls with a ControlButton to lay the graph out again, dotted Background, fitView), laid out by elkjs through lib/graph-layout on lib/theorem/session-graph-layout's policy, whose `arrange` decides what may move so that what is on screen stays put, and whose routes the fork tree's edges follow while both ends are where they were laid out (routePath, rounded as getSmoothStepPath rounds); a re-formed tree moves there on lib/motion's shift spring (anime.js, 220ms, critically damped), immediately under reduced motion; Base UI ContextMenu with coss menu parts for a session's right-click; coss Menu checkbox items for Show; ui/dialog and coss input for naming a view; date-fns for how long ago. The read is Theorem's session graph (lib/theorem/sessions), the projection lib/theorem/session-graph, and a saved view lib/program/api's session graph actions beside the programs. docs/plans/projects-sidebar-and-session-graph.md §9.
import {
  Background,
  BackgroundVariant,
  BaseEdge,
  ControlButton,
  Controls,
  EdgeLabelRenderer,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  ReactFlowProvider,
  getSmoothStepPath,
  useInternalNode,
  useReactFlow,
} from '@xyflow/react'
import type { Edge, EdgeProps, Node, NodeProps } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { ContextMenu } from '@base-ui/react/context-menu'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { formatDistanceToNowStrict } from 'date-fns'
import { createContext, use, useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import type { JSAnimation } from 'animejs'
import { animate } from 'animejs'
import { Alert, AlertDescription } from '@/components/coss/alert'
import { Badge } from '@/components/coss/badge'
import { Input } from '@/components/coss/input'
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuLinkItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from '@/components/coss/menu'
import { toastManager } from '@/components/coss/toast'
import { Icon } from '@/components/icons'
import { SessionGlyph } from '@/components/organize/glyphs'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  SESSION_GRAPH_FACETS,
  deleteSessionGraph,
  loadSessionGraph,
  programKeys,
  saveSessionGraph,
} from '@/lib/program/api'
import type {
  SavedSessionGraph,
  SessionGraphLayout,
  SessionGraphShow,
} from '@/lib/program/api'
import { describeError } from '@/lib/theorem/client'
import { useOrganization } from '@/lib/theorem/organization'
import {
  FACET_LABEL,
  SHOW_ALL,
  describeEdges,
  nodeName,
  projectSessionGraph,
} from '@/lib/theorem/session-graph'
import type {
  GraphEdge,
  GraphNode,
  OutputNode as OutputRecord,
  ProjectedGraph,
  Relation,
  SessionNode as SessionRecord,
  ToolsNode as ToolsRecord,
} from '@/lib/theorem/session-graph'
import {
  arrange,
  heldRoutes,
  layout,
  routeHolds,
  routePath,
} from '@/lib/graph-layout'
import type { Layout, Point, Route } from '@/lib/graph-layout'
import {
  layoutShape,
  rerooted,
  sessionLayout,
} from '@/lib/theorem/session-graph-layout'
import type { LayoutShape } from '@/lib/theorem/session-graph-layout'
import { sessionGraphQuery, useMakeMain } from '@/lib/theorem/sessions'
import type { GraphScope, SessionGraphRead } from '@/lib/theorem/sessions'
import { prefersReducedMotion, springs } from '@/lib/motion'
import { cn } from '@/lib/utils'

const ago = (atMs: number) =>
  Date.now() - atMs < 60_000
    ? 'just now'
    : `${formatDistanceToNowStrict(atMs)} ago`

const TOOLS_SHOWN = 4

function sizeOf(node: GraphNode) {
  if (node.kind === 'session') return { width: 232, height: 52 }
  if (node.kind === 'tools') {
    const rows =
      Math.min(node.tools.length, TOOLS_SHOWN) +
      (node.tools.length > TOOLS_SHOWN ? 1 : 0)
    return { width: 200, height: 30 + rows * 18 }
  }
  return { width: 200, height: 44 }
}

type FlowNode = Node<{ record: GraphNode }, GraphNode['kind']>
type FlowEdge = Edge<
  { edge: GraphEdge; route?: Route | undefined },
  'relation' | 'message'
>

/** Each relation by line, not by colour alone: solid, dashed, dotted, or fine. */
const LINE: Readonly<
  Record<Relation, { dash?: string; width: number; arrow: boolean }>
> = {
  fork: { width: 1.5, arrow: false },
  continued: { dash: '6 4', width: 1.5, arrow: true },
  message: { dash: '1.5 3.5', width: 1.75, arrow: true },
  made: { width: 1, arrow: false },
  used: { width: 1, arrow: false },
}

const LEGEND: Readonly<Record<Relation, string>> = {
  fork: 'fork, out from the main',
  continued: 'continues',
  message: 'session messages',
  made: 'made in',
  used: 'tools called',
}

const messageLabel = (edge: GraphEdge) =>
  `${edge.count ?? 1} ${edge.count === 1 ? 'message' : 'messages'}${edge.forPerson ? ' · for you' : ''}`

/** What a session's right-click and the inspector can do, given to the nodes without threading props through React Flow. */
type SessionActions = {
  makeMain: (node: SessionRecord) => void
  pending?: string
}
const Actions = createContext<SessionActions>({ makeMain: () => {} })

/** Whether a chat can be chosen as its tree's main, and if not, why. */
function mainBlock(node: SessionRecord): string | undefined {
  if (node.isMain) return 'Already the main chat'
  if (!node.treeId) return 'Not in a tree read here'
  if (node.status !== 'regular') return `Restore it to make it main`
  return undefined
}

function SessionMenuItems({ node }: { node: SessionRecord }) {
  const actions = use(Actions)
  const blocked = mainBlock(node)
  return (
    <>
      <MenuItem
        disabled={blocked !== undefined || actions.pending === node.threadId}
        onClick={() => actions.makeMain(node)}
      >
        <Icon.Star className="size-4" />
        Make main chat
      </MenuItem>
      <MenuLinkItem
        render={<Link to="/c/$threadId" params={{ threadId: node.threadId }} />}
      >
        <Icon.Open className="size-4" />
        Open session
      </MenuLinkItem>
    </>
  )
}

function SessionMarks({ node }: { node: SessionRecord }) {
  // The only chat in its tree is its main and its origin by definition.
  if (node.solo) return null
  return (
    <>
      {node.isMain && <Badge size="sm">Main</Badge>}
      {node.isOrigin && (
        <Badge size="sm" variant="outline" title="Every fork leads back here">
          Origin
        </Badge>
      )}
    </>
  )
}

function SessionCard({
  data,
  selected,
}: NodeProps<Node<{ record: SessionRecord }>>) {
  const node = data.record
  const quiet = node.outside || node.status !== 'regular'
  const detail =
    node.status !== 'regular'
      ? node.status === 'archived'
        ? 'Archived'
        : 'Deleted'
      : node.outside
        ? node.treeId
          ? 'In another project'
          : 'Outside these trees'
        : ago(node.lastMovedMs)
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger
        render={<div />}
        title={node.title}
        style={sizeOf(node)}
        className={cn(
          'flex items-center gap-2.5 rounded-lg bg-raised px-3 text-start ring-1 ring-separator transition-shadow',
          node.isMain && !node.solo && 'ring-2 ring-ink/70',
          // A ring is a shadow and cannot be dashed; the outline can.
          quiet &&
            'bg-transparent text-ink-muted ring-0 outline-1 -outline-offset-1 outline-ink-faint outline-dashed',
          selected && 'ring-2 ring-focus',
        )}
      >
        <Handle type="target" position={Position.Left} className="invisible" />
        <SessionGlyph threadId={node.threadId} className="text-ink-muted" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span data-appearance-recipe="ui.label" className="truncate text-ink">
            {node.title}
          </span>
          <span className="flex min-w-0 items-center gap-1 text-xs text-ink-muted">
            <SessionMarks node={node} />
            <span className="truncate">{detail}</span>
          </span>
        </span>
        {node.running && (
          <span
            aria-label="Running"
            className="size-2 shrink-0 rounded-full bg-teal dark:bg-teal-ink"
          />
        )}
        <Handle type="source" position={Position.Right} className="invisible" />
      </ContextMenu.Trigger>
      <MenuPopup className="min-w-48" side="bottom" align="start">
        <SessionMenuItems node={node} />
      </MenuPopup>
    </ContextMenu.Root>
  )
}

function OutputCard({
  data,
  selected,
}: NodeProps<Node<{ record: OutputRecord }>>) {
  const node = data.record
  const Mark = node.kind === 'artifact' ? Icon.Artifact : Icon.Article
  return (
    <div
      title={node.title}
      style={sizeOf(node)}
      className={cn(
        'flex items-center gap-2 rounded-lg bg-sidebar px-3 ring-1 ring-separator',
        selected && 'ring-2 ring-focus',
      )}
    >
      <Handle type="target" position={Position.Left} className="invisible" />
      <Mark aria-hidden className="size-4 shrink-0 text-ink-muted" />
      <span className="flex min-w-0 flex-col">
        <span data-appearance-recipe="ui.label" className="truncate">
          {node.title}
        </span>
        <span className="truncate text-xs text-ink-muted">
          {node.kind === 'artifact' ? 'Artifact' : 'Document'} ·{' '}
          {ago(node.updatedAtMs)}
        </span>
      </span>
    </div>
  )
}

function ToolsCard({
  data,
  selected,
}: NodeProps<Node<{ record: ToolsRecord }>>) {
  const node = data.record
  const shown = node.tools.slice(0, TOOLS_SHOWN)
  const more = node.tools.length - shown.length
  return (
    <div
      style={sizeOf(node)}
      className={cn(
        'flex flex-col justify-center gap-0.5 rounded-lg bg-sidebar px-3 text-xs ring-1 ring-separator',
        selected && 'ring-2 ring-focus',
      )}
    >
      <Handle type="target" position={Position.Left} className="invisible" />
      <span className="flex items-center gap-1.5 text-ink">
        <Icon.ToolDone aria-hidden className="size-3.5 text-ink-muted" />
        <span data-appearance-recipe="ui.label">Tools</span>
      </span>
      {shown.map((tool) => (
        <span key={tool.name} className="flex gap-2 text-ink-muted">
          <span className="min-w-0 flex-1 truncate font-mono">{tool.name}</span>
          <span className="shrink-0 tabular-nums">
            ×{tool.calls}
            {tool.failed > 0 && ` · ${tool.failed} failed`}
          </span>
        </span>
      ))}
      {more > 0 && <span className="text-ink-muted">and {more} more</span>}
    </div>
  )
}

/** The edge on the track ELK routed it along, while both its ends are where they were laid out; otherwise a step path between the handles. */
function RelationEdge({
  id,
  source,
  target,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  markerEnd,
}: EdgeProps<FlowEdge>) {
  const edge = data!.edge
  const line = LINE[edge.relation]
  const from = useInternalNode(source)?.internals.positionAbsolute
  const to = useInternalNode(target)?.internals.positionAbsolute
  const path = routeHolds(data!.route, from, to)
    ? routePath(data!.route.points, 8)
    : getSmoothStepPath({
        sourceX,
        sourceY,
        targetX,
        targetY,
        sourcePosition,
        targetPosition,
        borderRadius: 8,
      })[0]
  const fine = edge.relation === 'made' || edge.relation === 'used'
  return (
    <BaseEdge
      id={id}
      path={path}
      markerEnd={markerEnd}
      style={{
        stroke: fine ? 'var(--color-ink-faint)' : 'var(--color-ink-muted)',
        strokeWidth: line.width,
        strokeDasharray: line.dash,
      }}
    />
  )
}

type Box = { x: number; y: number; width: number; height: number }

const centre = (box: Box): Point => ({
  x: box.x + box.width / 2,
  y: box.y + box.height / 2,
})

/** Where a line from the box's centre toward a point crosses its edge. */
function border(box: Box, toward: Point): Point {
  const { x, y } = centre(box)
  const dx = toward.x - x
  const dy = toward.y - y
  const scale = Math.min(
    dx === 0 ? Infinity : box.width / 2 / Math.abs(dx),
    dy === 0 ? Infinity : box.height / 2 / Math.abs(dy),
  )
  return Number.isFinite(scale)
    ? { x: x + dx * scale, y: y + dy * scale }
    : { x, y }
}

function useBox(id: string): Box | undefined {
  const node = useInternalNode<FlowNode>(id)
  if (!node) return undefined
  return {
    ...node.internals.positionAbsolute,
    width: node.measured.width ?? node.width ?? 0,
    height: node.measured.height ?? node.height ?? 0,
  }
}

/**
 * A session message, drawn as an arc between the two chats wherever they sit,
 * so it reads apart from the fork tree's square lines. It always bows to the
 * left of its direction, so messages each way between two chats are two arcs.
 */
function MessageEdge({
  id,
  source,
  target,
  data,
  markerEnd,
}: EdgeProps<FlowEdge>) {
  const edge = data!.edge
  const from = useBox(source)
  const to = useBox(target)
  if (!from || !to) return null
  const a = centre(from)
  const b = centre(to)
  const dx = b.x - a.x
  const dy = b.y - a.y
  const length = Math.hypot(dx, dy) || 1
  // Enough that an arc between two chats in a row clears the cards between them.
  const bow = Math.min(80, Math.max(24, length * 0.25))
  const control = {
    x: (a.x + b.x) / 2 + (dy / length) * bow,
    y: (a.y + b.y) / 2 - (dx / length) * bow,
  }
  const start = border(from, control)
  const end = border(to, control)
  const path = `M ${start.x} ${start.y} Q ${control.x} ${control.y} ${end.x} ${end.y}`
  // The curve's midpoint, where its label sits.
  const label = {
    x: (start.x + 2 * control.x + end.x) / 4,
    y: (start.y + 2 * control.y + end.y) / 4,
  }
  const line = LINE.message
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        style={{
          stroke: 'var(--color-ink-muted)',
          strokeWidth: line.width,
          strokeDasharray: line.dash,
        }}
      />
      <EdgeLabelRenderer>
        <span
          style={{
            transform: `translate(-50%, -50%) translate(${label.x}px, ${label.y}px)`,
          }}
          // Above the cards: a label an arc carries over a chat stays readable.
          className="pointer-events-none absolute z-[1000] rounded-sm bg-sheet px-1 text-[0.6875rem] leading-4 text-ink-muted"
        >
          {messageLabel(edge)}
        </span>
      </EdgeLabelRenderer>
    </>
  )
}

const nodeTypes = {
  session: SessionCard,
  artifact: OutputCard,
  document: OutputCard,
  tools: ToolsCard,
}
const edgeTypes = { relation: RelationEdge, message: MessageEdge }

function Legend({ graph }: { graph: ProjectedGraph }) {
  const present = (Object.keys(LINE) as Relation[]).filter((relation) =>
    graph.edges.some((e) => e.relation === relation),
  )
  const outside = graph.nodes.some((n) => n.kind === 'session' && n.outside)
  if (present.length === 0 && !outside) return null
  return (
    <ul
      aria-label="Legend"
      className="pointer-events-none absolute start-3 bottom-3 z-10 flex flex-col gap-1 rounded-lg bg-raised/90 px-3 py-2 text-xs text-ink-muted ring-1 ring-separator"
    >
      {present.map((relation) => (
        <li key={relation} className="flex items-center gap-2">
          <svg aria-hidden width="28" height="6">
            <line
              x1="0"
              y1="3"
              x2="28"
              y2="3"
              stroke="currentColor"
              strokeWidth={LINE[relation].width}
              strokeDasharray={LINE[relation].dash}
            />
          </svg>
          {LEGEND[relation]}
        </li>
      ))}
      {outside && (
        <li className="flex items-center gap-2">
          <span className="h-3 w-7 rounded-sm outline-1 -outline-offset-1 outline-ink-faint outline-dashed" />
          outside this graph's scope
        </li>
      )}
    </ul>
  )
}

/** The selected node and every relation it takes part in, in words, with what can be done to it. */
function Inspector({
  graph,
  node,
  onClose,
}: {
  graph: ProjectedGraph
  node: GraphNode
  onClose: () => void
}) {
  const actions = use(Actions)
  const touching: ProjectedGraph = {
    ...graph,
    edges: graph.edges.filter(
      (e) => e.source === node.id || e.target === node.id,
    ),
  }
  const sentences = describeEdges(touching)
  const forkedFrom =
    node.kind === 'session' && node.forkedFromThreadId
      ? graph.nodes.find(
          (n) => n.kind === 'session' && n.threadId === node.forkedFromThreadId,
        )
      : undefined
  const blocked = node.kind === 'session' ? mainBlock(node) : undefined
  return (
    <aside
      aria-label="Selected"
      className="absolute end-3 top-16 z-10 flex w-64 flex-col gap-3 rounded-xl bg-raised p-4 shadow-md ring-1 ring-separator"
    >
      <div className="flex items-start gap-2">
        <h3
          data-appearance-recipe="ui.section"
          className="min-w-0 flex-1 text-ink"
        >
          {nodeName(node)}
        </h3>
        <button
          type="button"
          aria-label="Close"
          onClick={onClose}
          className="flex size-6 items-center justify-center rounded-md text-ink-muted hover:bg-hover hover:text-ink"
        >
          <Icon.Close className="size-3.5" />
        </button>
      </div>
      {node.kind === 'session' && (
        <div className="flex flex-wrap items-center gap-1 text-xs text-ink-muted">
          <SessionMarks node={node} />
          <span>
            Last moved {ago(node.lastMovedMs)}
            {node.running ? ' · running' : ''}
          </span>
        </div>
      )}
      {(sentences.length > 0 || forkedFrom) && (
        <ul className="flex flex-col gap-1 text-sm">
          {forkedFrom && <li>Forked from {nodeName(forkedFrom)}</li>}
          {sentences.map((text) => (
            <li key={text}>{text}</li>
          ))}
        </ul>
      )}
      {node.kind === 'session' && (
        <div className="flex flex-wrap gap-2">
          <Link
            to="/c/$threadId"
            params={{ threadId: node.threadId }}
            className="rounded-md px-2 py-1 text-sm text-ink ring-1 ring-separator hover:bg-hover"
          >
            Open session
          </Link>
          {!node.isMain && (
            <Button
              variant="outline"
              size="sm"
              title={blocked}
              disabled={
                blocked !== undefined || actions.pending === node.threadId
              }
              onClick={() => actions.makeMain(node)}
            >
              Make main chat
            </Button>
          )}
        </div>
      )}
    </aside>
  )
}

type Direction = NonNullable<SessionGraphLayout['direction']>

// The header bar floats over the top of the canvas, so the fit keeps clear of it.
const PAD = { top: 88, bottom: 32, x: 32 } as const
// Large graphs stay readable: past this zoom the canvas pans instead of shrinking.
const FIT = {
  padding: { top: `${PAD.top}px`, bottom: `${PAD.bottom}px`, x: `${PAD.x}px` },
  maxZoom: 1,
  minZoom: 0.6,
} as const

/** The zoom a laid-out graph fits its panel at, up to actual size. */
const fitZoom = (
  graph: { width: number; height: number },
  panel: { width: number; height: number },
) =>
  Math.min(
    1,
    (panel.width - PAD.x * 2) / Math.max(graph.width, 1),
    (panel.height - PAD.top - PAD.bottom) / Math.max(graph.height, 1),
  )

/**
 * What the canvas last laid out. The graph view keeps it, so switching to the
 * list and back, or hiding everything and showing it again, finds each node
 * where it was.
 */
type LaidOut = {
  shape?: LayoutShape
  way?: Direction
  /** Every node's last place, including nodes hidden since. */
  seen: Record<string, Point>
  /** Every edge's last route, with where its ends were when it was routed. */
  routes: Record<string, Route>
}

/** Part way from where each node is drawn to where it is going. */
const between = (
  from: Readonly<Record<string, Point>>,
  to: Readonly<Record<string, Point>>,
  t: number,
) =>
  Object.fromEntries(
    Object.entries(to).map(([id, end]) => {
      const start = from[id]
      return [
        id,
        start
          ? {
              x: start.x + (end.x - start.x) * t,
              y: start.y + (end.y - start.y) * t,
            }
          : end,
      ]
    }),
  )

function Flow({
  graph,
  placed,
  onPlace,
  onArrange,
  direction,
  onDirection,
  memory,
}: {
  graph: ProjectedGraph
  /** Positions a person dragged nodes to; the rest are laid out. */
  placed: Readonly<Record<string, Point>>
  onPlace: (id: string, at: Point) => void
  /** The person asked for a fresh layout: what they dragged goes back to it. */
  onArrange: () => void
  /** Which way the forks run; until a view has one, the way that fits its panel larger. */
  direction?: Direction
  onDirection: (direction: Direction) => void
  memory: { read: () => LaidOut; write: (laidOut: LaidOut) => void }
}) {
  const [shown, setShown] = useState<Record<string, Point>>()
  const [routes, setRoutes] = useState<Record<string, Route>>({})
  const [selected, setSelected] = useState<string>()
  const [dragging, setDragging] = useState<Record<string, Point>>({})
  // Each press of "Lay the graph out again", and each layout that landed.
  const [arranged, setArranged] = useState(0)
  const [settled, setSettled] = useState(0)
  const flow = useReactFlow()
  const frame = useRef<HTMLDivElement>(null)
  // Until the person pans, zooms or drags, the graph follows its panel's size.
  const moved = useRef(false)
  // Where the layout has each node drawn this frame, mid-glide included.
  const drawn = useRef<Record<string, Point>>({})
  const glide = useRef<JSAnimation | undefined>(undefined)
  const pins = useRef(placed)
  const ran = useRef(0)

  // Only what is laid out: a refetch that changes a status or a time, or
  // adds a message, gives the same key and lays nothing out.
  const key = useMemo(() => JSON.stringify(layoutShape(graph, sizeOf)), [graph])
  const shape = useMemo(() => JSON.parse(key) as LayoutShape, [key])

  // Read by the layout below without re-running it: a drop moves only what was dropped.
  useEffect(() => {
    pins.current = { ...placed, ...dragging }
  })

  useEffect(() => {
    const show = (next: Record<string, Point>) => {
      drawn.current = next
      setShown(next)
    }
    const land = (next: Record<string, Point>, move: boolean) => {
      const gliding = glide.current !== undefined
      glide.current?.cancel()
      glide.current = undefined
      const from = drawn.current
      if (
        !(move || gliding) ||
        Object.keys(from).length === 0 ||
        prefersReducedMotion()
      ) {
        show(next)
        setSettled((n) => n + 1)
        return
      }
      // From wherever each node is drawn now, so a glide that is interrupted
      // turns towards the new place instead of starting over.
      const progress = { t: 0 }
      glide.current = animate(progress, {
        t: 1,
        ease: springs.shift,
        onUpdate: () => show(between(from, next, progress.t)),
        onComplete: () => {
          glide.current = undefined
          show(next)
          setSettled((n) => n + 1)
        },
      })
    }

    const before = memory.read()
    const way = direction ?? before.way
    // Laid out from scratch: the first time, a new direction, or on request.
    const anew =
      !before.shape ||
      (way !== undefined && way !== before.way) ||
      arranged !== ran.current
    const relayout = anew
      ? new Set(shape.nodes.map((n) => n.id))
      : rerooted(before.shape!, shape)
    const commit = (
      next: Record<string, Point>,
      chosen: Direction,
      held: Record<string, Route> = {},
    ) => {
      // A route kept from before still holds while its ends have not moved.
      const kept = { ...before.routes, ...held }
      memory.write({
        shape,
        way: chosen,
        seen: { ...before.seen, ...next },
        routes: kept,
      })
      ran.current = arranged
      setRoutes(kept)
      land(next, relayout.size > 0)
    }

    if (
      way &&
      relayout.size === 0 &&
      shape.nodes.every((n) => before.seen[n.id])
    ) {
      // Everything already has a place, as when a hidden facet comes back.
      commit(
        Object.fromEntries(shape.nodes.map((n) => [n.id, before.seen[n.id]!])),
        way,
      )
      return
    }

    // A layout finishing after the graph changed is dropped.
    const run = { live: true }
    const lay = (to: Direction) => layout(shape, sessionLayout(to))
    const settle = (laid: Layout, chosen: Direction) => {
      const next = arrange({
        graph: shape,
        fresh: laid.positions,
        previous: before.seen,
        pinned: pins.current,
        relayout,
        across: chosen === 'RIGHT',
      })
      commit(
        next,
        chosen,
        heldRoutes({
          edges: shape.edges,
          routes: laid.routes,
          fresh: laid.positions,
          placed: next,
        }),
      )
    }
    void (async () => {
      if (way) {
        const next = await lay(way)
        if (run.live) settle(next, way)
        return
      }
      // A tree wider than its panel reads larger running down it; the choice
      // is kept, so showing or hiding a facet does not turn the graph.
      const [across, down] = await Promise.all([lay('RIGHT'), lay('DOWN')])
      if (!run.live) return
      const panel = {
        width: frame.current?.clientWidth ?? 0,
        height: frame.current?.clientHeight ?? 0,
      }
      const chosen =
        fitZoom(down, panel) > fitZoom(across, panel) * 1.15 ? 'DOWN' : 'RIGHT'
      settle(chosen === 'DOWN' ? down : across, chosen)
      onDirection(chosen)
    })()
    return () => {
      run.live = false
    }
  }, [shape, direction, arranged, onDirection, memory])

  useEffect(
    () => () => {
      glide.current?.cancel()
    },
    [],
  )

  const arrangeAgain = () => {
    // What is drawn stays put until the new layout glides in from it.
    const now = { ...drawn.current, ...placed }
    drawn.current = now
    setShown(now)
    moved.current = false
    onArrange()
    setArranged((n) => n + 1)
  }

  useEffect(() => {
    const element = frame.current
    if (!settled || !element) return
    const fit = async () => {
      await flow.fitView(FIT)
      if (flow.getZoom() > FIT.minZoom + 0.001) return
      // Too big to fit at a readable size: start from the main, at the left
      // or the top, with the other axis centred while it fits.
      const bounds = flow.getNodesBounds(flow.getNodes())
      const zoom = FIT.minZoom
      const width = element.clientWidth
      const height = element.clientHeight
      const centred = (
        start: number,
        size: number,
        room: number,
        before: number,
        after: number,
      ) =>
        size * zoom + before + after < room
          ? before + (room - before - after - size * zoom) / 2 - start * zoom
          : before - start * zoom
      await flow.setViewport({
        x:
          direction === 'DOWN'
            ? centred(bounds.x, bounds.width, width, PAD.x, PAD.x)
            : PAD.x - bounds.x * zoom,
        y:
          direction === 'DOWN'
            ? PAD.top - bounds.y * zoom
            : centred(bounds.y, bounds.height, height, PAD.top, PAD.bottom),
        zoom,
      })
    }
    const observer = new ResizeObserver(() => {
      if (!moved.current) void fit()
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [settled, flow, direction])

  const nodes = useMemo(
    (): FlowNode[] =>
      graph.nodes.map((record) => {
        const size = sizeOf(record)
        return {
          id: record.id,
          type: record.kind,
          position: dragging[record.id] ??
            placed[record.id] ??
            shown?.[record.id] ?? { x: 0, y: 0 },
          data: { record },
          selected: record.id === selected,
          width: size.width,
          height: size.height,
          ariaLabel:
            record.kind === 'session'
              ? `${record.title}${record.isMain && !record.solo ? ', main chat' : ''}${record.isOrigin && !record.solo ? ', origin' : ''}`
              : record.kind === 'tools'
                ? 'Tools called'
                : `${record.kind === 'artifact' ? 'Artifact' : 'Document'} ${record.title}`,
        }
      }),
    [graph.nodes, shown, placed, dragging, selected],
  )
  const edges = useMemo(
    (): FlowEdge[] =>
      graph.edges.map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        type: edge.relation === 'message' ? 'message' : 'relation',
        selectable: false,
        focusable: false,
        data: { edge, route: routes[edge.id] },
        markerEnd: LINE[edge.relation].arrow
          ? {
              type: MarkerType.ArrowClosed,
              width: 14,
              height: 14,
              color: 'var(--color-ink-muted)',
            }
          : undefined,
      })),
    [graph.edges, routes],
  )
  const node = graph.nodes.find((n) => n.id === selected)

  return (
    <div ref={frame} className="absolute inset-0">
      {/* Mounted once ELK has placed everything, so the first fit sees the real positions. */}
      {shown && (
        <ReactFlow<FlowNode, FlowEdge>
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          fitView
          fitViewOptions={FIT}
          onMoveStart={(event) => {
            // Only a person's gesture carries an event; a fit does not.
            if (event) moved.current = true
          }}
          onNodesChange={(changes) => {
            for (const change of changes)
              if (change.type === 'position' && change.position) {
                moved.current = true
                const at = change.position
                if (change.dragging)
                  setDragging((held) => ({ ...held, [change.id]: at }))
                else {
                  onPlace(change.id, at)
                  setDragging(({ [change.id]: _, ...rest }) => rest)
                }
              }
          }}
          minZoom={0.2}
          maxZoom={1.5}
          nodesConnectable={false}
          elementsSelectable
          deleteKeyCode={null}
          onNodeClick={(_, n) => setSelected(n.id)}
          onPaneClick={() => setSelected(undefined)}
          proOptions={{ hideAttribution: true }}
        >
          <Background
            variant={BackgroundVariant.Dots}
            gap={20}
            size={1}
            color="var(--color-separator)"
          />
          <Controls showInteractive={false} position="bottom-right">
            <ControlButton
              aria-label="Lay the graph out again"
              title="Lay the graph out again"
              onClick={arrangeAgain}
            >
              <Icon.Organize />
            </ControlButton>
          </Controls>
        </ReactFlow>
      )}
      <Legend graph={graph} />
      {node && (
        <Inspector
          graph={graph}
          node={node}
          onClose={() => setSelected(undefined)}
        />
      )}
    </div>
  )
}

/** The graph as text: every relation and every session, for reading without the canvas. */
function GraphList({ graph }: { graph: ProjectedGraph }) {
  const sentences = describeEdges(graph)
  const sessions = graph.nodes.filter(
    (n): n is SessionRecord => n.kind === 'session',
  )
  return (
    <div className="flex h-full flex-col gap-4 overflow-auto px-4 pt-16 pb-4 text-sm">
      <section>
        <h3 data-appearance-recipe="ui.section" className="mb-1 text-ink">
          Relations
        </h3>
        {sentences.length ? (
          <ul className="flex flex-col gap-1">
            {sentences.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ul>
        ) : (
          <p className="text-ink-muted">None shown.</p>
        )}
      </section>
      {sessions.length > 0 && (
        <section>
          <h3 data-appearance-recipe="ui.section" className="mb-1 text-ink">
            Sessions
          </h3>
          <ul className="flex flex-col gap-1">
            {sessions.map((n) => (
              <li key={n.id} className="flex flex-wrap items-center gap-1">
                <Link
                  to="/c/$threadId"
                  params={{ threadId: n.threadId }}
                  className="hover:underline"
                >
                  {n.title}
                </Link>
                <SessionMarks node={n} />
                {n.outside && (
                  <span className="text-ink-muted"> · outside this scope</span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}

/** What a tree's main resolution needs said: a stand-in main, or none at all. */
function mainNotes(read: SessionGraphRead): string[] {
  return read.trees.flatMap((tree) => {
    const title = (id?: string) =>
      tree.nodes.find((n) => n.threadId === id)?.title || 'a session'
    if (tree.mainResolution === 'fallback')
      return [
        `${title(tree.chosenMainThreadId ?? tree.originThreadId)} is not open, so ${title(tree.mainThreadId)} stands in as main until it is restored.`,
      ]
    if (tree.mainResolution === 'none')
      return [
        `No chat in ${title(tree.originThreadId)}'s tree is open; restore one to choose a main.`,
      ]
    return []
  })
}

type NameProps = {
  initial: string
  title: string
  action: string
  pending: boolean
  error?: unknown
  onCancel: () => void
  onSubmit: (name: string) => void
}

/** Mounted each time the dialog opens, so the field starts from the current name. */
function NameForm({
  initial,
  title,
  action,
  pending,
  error,
  onCancel,
  onSubmit,
}: NameProps) {
  const [name, setName] = useState(initial)
  const submit = (event: FormEvent) => {
    event.preventDefault()
    const trimmed = name.trim()
    if (trimmed) onSubmit(trimmed)
  }
  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>
          A saved graph keeps its layout and what it shows. The sessions are
          read fresh each time it opens.
        </DialogDescription>
      </DialogHeader>
      <Input
        aria-label="Name"
        value={name}
        maxLength={200}
        autoFocus
        onChange={(event) => setName(event.target.value)}
      />
      {error ? (
        <p className="text-sm text-destructive-foreground">
          {describeError(error)}
        </p>
      ) : null}
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={pending || !name.trim()}>
          {action}
        </Button>
      </DialogFooter>
    </form>
  )
}

function NameDialog({
  open,
  onOpenChange,
  ...form
}: Omit<NameProps, 'onCancel'> & {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        {open && <NameForm {...form} onCancel={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  )
}

const toViewScope = (scope: GraphScope) =>
  scope.kind === 'project'
    ? { kind: 'project' as const, id: scope.projectId }
    : { kind: 'tree' as const, id: scope.treeId }

const refused = (title: string) => (error: Error) =>
  toastManager.add({ type: 'error', title, description: describeError(error) })

/**
 * A session or project graph on the canvas: what Theorem reads for the scope,
 * shown by the facets the person picked, laid out where they put it. Opening
 * it changes nothing; making a chat main and saving the view are the only
 * writes, and each says so.
 */
function SessionGraph({
  scope,
  saved,
}: {
  scope: GraphScope
  saved?: SavedSessionGraph
}) {
  const client = useQueryClient()
  const navigate = useNavigate()
  const read = useQuery(sessionGraphQuery(scope))
  const { data: organization } = useOrganization()
  const [show, setShow] = useState<SessionGraphShow>({
    ...SHOW_ALL,
    ...saved?.show,
  })
  const [placed, setPlaced] = useState<Record<string, Point>>(
    saved?.layout.nodes ?? {},
  )
  const [direction, setDirection] = useState(saved?.layout.direction)
  const laidOut = useRef<LaidOut>({ seen: {}, routes: {} })
  const memory = useMemo(
    () => ({
      read: () => laidOut.current,
      write: (next: LaidOut) => {
        laidOut.current = next
      },
    }),
    [],
  )
  // Every edit counts; the view is unsaved while an edit is newer than the
  // last save, including an edit made while that save was on its way.
  const [edits, setEdits] = useState(0)
  const [savedAt, setSavedAt] = useState(0)
  const dirty = edits !== savedAt
  const edited = () => setEdits((n) => n + 1)
  // The revision these edits build on. A reload that brings a newer one,
  // saved elsewhere, does not change it, so saving over that is refused.
  const [base, setBase] = useState(saved?.revision)
  const [asList, setAsList] = useState(false)
  const [naming, setNaming] = useState<'save' | 'rename'>()

  const titles = useMemo(
    () =>
      new Map((organization?.threads ?? []).map((t) => [t.threadId, t.title])),
    [organization],
  )
  const graph = useMemo(
    () => read.data && projectSessionGraph(read.data, show, titles),
    [read.data, show, titles],
  )

  const defaultName = useMemo(() => {
    if (scope.kind === 'project')
      return (
        organization?.projects.find((p) => p.projectId === scope.projectId)
          ?.title ?? 'Project sessions'
      )
    const tree = read.data?.trees[0]
    const origin = tree?.nodes.find((n) => n.threadId === tree.originThreadId)
    return origin?.title || titles.get(scope.treeId) || 'Session tree'
  }, [scope, organization, read.data, titles])
  const name = saved?.name ?? defaultName

  const makeMain = useMakeMain()
  const actions = useMemo(
    (): SessionActions => ({
      pending: makeMain.isPending ? makeMain.variables.threadId : undefined,
      makeMain: (node) =>
        makeMain.mutate(
          { threadId: node.threadId, expectedRevision: node.revision },
          {
            onSuccess: () =>
              toastManager.add({
                type: 'success',
                title: `${node.title} is now the main chat`,
                description:
                  'It can message the others in its tree on your behalf.',
              }),
            onError: refused(`Could not make ${node.title} the main chat`),
          },
        ),
    }),
    [makeMain],
  )

  const save = useMutation({
    mutationFn: (as: { name: string; at: number }) =>
      saveSessionGraph({
        name: as.name,
        scope: toViewScope(scope),
        layout: { nodes: placed, direction } satisfies SessionGraphLayout,
        show,
        ...(saved ? { node_id: saved.node_id, expected_revision: base } : {}),
      }),
    onSuccess: (view, as) => {
      client.setQueryData(programKeys.sessionGraph(view.node_id), view)
      void client.invalidateQueries({ queryKey: programKeys.sessionGraphs() })
      setSavedAt(as.at)
      setBase(view.revision)
      setNaming(undefined)
      if (!saved)
        void navigate({
          to: '/canvas',
          search: { view: view.node_id },
          replace: true,
        })
    },
  })
  const remove = useMutation({
    mutationFn: () => deleteSessionGraph(saved!.node_id),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: programKeys.sessionGraphs() })
      void navigate({ to: '/canvas', search: {}, replace: true })
    },
    onError: refused('Could not delete this graph'),
  })

  const toggle = (facet: keyof SessionGraphShow, on: boolean) => {
    setShow((held) => ({ ...held, [facet]: on }))
    edited()
  }
  const notServed = new Map(
    (read.data?.notServed ?? []).map((n) => [n.facet, n.reason]),
  )
  const notes = read.data ? mainNotes(read.data) : []
  const sessionCount =
    read.data?.trees.reduce((n, t) => n + t.nodes.length, 0) ?? 0

  return (
    <Actions value={actions}>
      <div className="relative h-full min-h-0 bg-sheet">
        <header className="absolute inset-x-3 top-3 z-20 flex flex-wrap items-center gap-2 rounded-xl bg-raised/95 px-3 py-2 shadow-sm ring-1 ring-separator">
          <div className="flex min-w-0 flex-1 flex-col">
            <h2
              data-appearance-recipe="ui.section"
              className="truncate text-ink"
            >
              {name}
            </h2>
            <p className="truncate text-xs text-ink-muted">
              {scope.kind === 'project' ? 'Project graph' : 'Session tree'}
              {read.data &&
                ` · ${sessionCount} ${sessionCount === 1 ? 'session' : 'sessions'}`}
              {graph?.lone
                ? ` · ${graph.lone} on ${graph.lone === 1 ? 'its' : 'their'} own, not drawn`
                : ''}
              {saved ? (dirty ? ' · unsaved changes' : ' · saved') : ''}
            </p>
          </div>
          <Menu>
            <MenuTrigger render={<Button variant="ghost" size="sm" />}>
              <Icon.Eye className="size-4" />
              Show
            </MenuTrigger>
            <MenuPopup align="end" className="min-w-56">
              <MenuGroup>
                <MenuGroupLabel>Show</MenuGroupLabel>
                {SESSION_GRAPH_FACETS.map((facet) => {
                  const reason = notServed.get(facet)
                  // Forks and connections join sessions; with none drawn there is nothing to join.
                  const joins =
                    (facet === 'forks' || facet === 'connections') &&
                    !show.sessions
                  return (
                    <MenuCheckboxItem
                      key={facet}
                      closeOnClick={false}
                      checked={show[facet]}
                      disabled={joins}
                      title={
                        reason ?? (joins ? 'Shown with sessions' : undefined)
                      }
                      onCheckedChange={(on) => toggle(facet, on)}
                    >
                      <span className="flex min-w-0 flex-col">
                        {FACET_LABEL[facet]}
                        {reason && (
                          <span className="text-xs text-ink-muted">
                            Not served yet
                          </span>
                        )}
                      </span>
                    </MenuCheckboxItem>
                  )
                })}
              </MenuGroup>
            </MenuPopup>
          </Menu>
          <Button
            variant="ghost"
            size="sm"
            aria-pressed={asList}
            onClick={() => setAsList((v) => !v)}
          >
            {asList ? 'Show graph' : 'Show as list'}
          </Button>
          <Button
            variant={saved && !dirty ? 'ghost' : 'outline'}
            size="sm"
            disabled={save.isPending || (saved !== undefined && !dirty)}
            onClick={() =>
              saved ? save.mutate({ name, at: edits }) : setNaming('save')
            }
          >
            {saved && !dirty ? 'Saved' : 'Save'}
          </Button>
          {saved && (
            <Menu>
              <MenuTrigger
                render={
                  <Button variant="ghost" size="icon-sm" aria-label="More" />
                }
              >
                <Icon.More className="size-4" />
              </MenuTrigger>
              <MenuPopup align="end" className="min-w-44">
                <MenuItem onClick={() => setNaming('rename')}>
                  <Icon.Edit className="size-4" />
                  Rename
                </MenuItem>
                <MenuSeparator />
                <MenuItem
                  variant="destructive"
                  disabled={remove.isPending}
                  onClick={() => remove.mutate()}
                >
                  <Icon.Delete className="size-4" />
                  Delete graph
                </MenuItem>
              </MenuPopup>
            </Menu>
          )}
          {(notes.length > 0 || (save.error && !naming)) && (
            <div className="flex basis-full flex-col gap-1 text-xs">
              {notes.map((note) => (
                <p key={note} className="text-ink-muted">
                  {note}
                </p>
              ))}
              {save.error && !naming && (
                <p className="text-destructive-foreground">
                  {describeError(save.error)}
                </p>
              )}
            </div>
          )}
        </header>

        {read.isError ? (
          <div className="flex h-full items-center justify-center p-8">
            <Alert variant="error" className="max-w-md">
              <AlertDescription>{describeError(read.error)}</AlertDescription>
            </Alert>
          </div>
        ) : !graph ? (
          <div
            aria-busy="true"
            className="flex h-full items-center justify-center text-sm text-ink-muted"
          >
            Reading sessions…
          </div>
        ) : graph.nodes.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-1 p-8 text-center">
            <p data-appearance-recipe="ui.section" className="text-ink">
              Nothing to draw
            </p>
            <p className="max-w-sm text-sm text-ink-muted">
              {sessionCount === graph.lone
                ? 'No sessions here have been forked, continued or messaged yet.'
                : 'Everything here is hidden. Choose what to show above.'}
            </p>
          </div>
        ) : asList ? (
          <GraphList graph={graph} />
        ) : (
          <ReactFlowProvider>
            <Flow
              graph={graph}
              placed={placed}
              onPlace={(id, at) => {
                setPlaced((held) => ({ ...held, [id]: at }))
                edited()
              }}
              onArrange={() => {
                if (Object.keys(placed).length === 0) return
                setPlaced({})
                edited()
              }}
              direction={direction}
              onDirection={setDirection}
              memory={memory}
            />
          </ReactFlowProvider>
        )}
      </div>
      <NameDialog
        open={naming !== undefined}
        onOpenChange={(open) => {
          if (!open) setNaming(undefined)
        }}
        initial={name}
        title={naming === 'rename' ? 'Rename graph' : 'Save graph'}
        action={naming === 'rename' ? 'Rename' : 'Save'}
        pending={save.isPending}
        error={save.error}
        onSubmit={(next) => save.mutate({ name: next, at: edits })}
      />
    </Actions>
  )
}

/** A saved graph: its scope, layout and facets from the view, its sessions read fresh. */
function SavedSessionGraphView({ viewId }: { viewId: string }) {
  const view = useQuery({
    queryKey: programKeys.sessionGraph(viewId),
    queryFn: () => loadSessionGraph(viewId),
  })
  if (view.isError)
    return (
      <div className="flex h-full items-center justify-center p-8">
        <Alert variant="error" className="max-w-md">
          <AlertDescription>{describeError(view.error)}</AlertDescription>
        </Alert>
      </div>
    )
  if (!view.data)
    return (
      <div
        aria-busy="true"
        className="flex h-full items-center justify-center text-sm text-ink-muted"
      >
        Opening graph…
      </div>
    )
  const { scope } = view.data
  return (
    <SessionGraph
      // A save bumps the revision; the canvas keeps its state through it.
      key={view.data.node_id}
      saved={view.data}
      scope={
        scope.kind === 'project'
          ? { kind: 'project', projectId: scope.id }
          : { kind: 'tree', treeId: scope.id }
      }
    />
  )
}

export function SessionGraphSurface(
  props: { viewId: string } | { scope: GraphScope },
) {
  return 'viewId' in props ? (
    <SavedSessionGraphView viewId={props.viewId} />
  ) : (
    <SessionGraph scope={props.scope} />
  )
}
