// SOURCING: coss ui sidebar, collapsible, menu and input over Base UI, the shadcn button, @dnd-kit/core (DndContext, useDroppable and DragOverlay: a thread dragged onto a project moves there), @dnd-kit/sortable with @dnd-kit/modifiers and @dnd-kit/utilities (a project dragged to another place in its list, as the rail's destinations are), @tanstack/react-router, the shell's tenant, useGlideHighlight from components/motion, lib/theorem/organization, assistant-ui's thread-search element for search in the header (rows are assistant-ui thread-list items, see thread-row), lib/theorem/sidebar-prefs for pins. The shape (search in the header, New thread, Pinned, Projects, Recent, the Librarian below; rows, marks and labels after the ChatGPT and Codex sidebars the owner's review on 2026-11-14 named) is docs/plans/projects-sidebar-and-session-graph.md §5, after the Linear, Claude and Twenty sidebars on Mobbin; thread membership is translated from mikecann/threadbear@78b77e1 (MIT, Mike Cann).
import { ContextMenu } from '@base-ui/react/context-menu'
import { useAuiState } from '@assistant-ui/react'
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCenter,
  pointerWithin,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import type {
  Active,
  CollisionDetection,
  DragEndEvent,
  DragStartEvent,
  Modifier,
} from '@dnd-kit/core'
import {
  restrictToParentElement,
  restrictToVerticalAxis,
} from '@dnd-kit/modifiers'
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Link, useNavigate, useParams } from '@tanstack/react-router'
import { Folder, FolderOpen } from 'lucide-react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { ThreadFromFailure } from '@/components/assistant-ui/elements/thread-list.aui'
import { ThreadSearch } from '@/components/assistant-ui/elements/thread-search'
import type { SearchableThread } from '@/components/assistant-ui/elements/thread-search'
import { focusComposer } from '@/components/chat/composer-references'
import { Button } from '@/components/ui/button'
import {
  Collapsible,
  CollapsiblePanel,
  CollapsibleTrigger,
} from '@/components/coss/collapsible'
import {
  Menu,
  MenuItem,
  MenuLinkItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from '@/components/coss/menu'
import {
  SidebarContent,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from '@/components/coss/sidebar'
import { Icon } from '@/components/icons'
import { useGlideHighlight } from '@/components/motion'
import { DocumentTile, FolderTile } from '@/components/ui/folder'
import { FilesystemItem, FilesystemMarks } from '@/components/ui/filesystem-item'
import { SessionGlyph } from './glyphs'
import { ProjectStateDialog } from './project-state-dialog'
import { SessionTypeDialog } from './session-type-dialog'
import {
  TREE_TICK,
  OrganizeTree,
  ThreadRow,
  useRevealOpenThread,
} from './thread-row'
import type { RowDrag } from './thread-row'
import { neighbour } from '@/lib/theorem/row-neighbour'
import { useShellMode } from '@/components/shell/modes'
import { useCreateProject, useTenant } from '@/components/shell/projects'
import { useShell } from '@/components/shell/shell-state'
import { describeError } from '@/lib/theorem/client'
import {
  lastMoved,
  nestByOrigin,
  primaryProjectId,
  rootOf,
  organizationKey,
  organizationQuery,
  useLibrarianControl,
  useMoveThread,
  useOrganization,
  useOrganizedViews,
  useProjectOutputs,
} from '@/lib/theorem/organization'
import { projectHasSessionGraph, scopeParam } from '@/lib/theorem/sessions'
import type {
  OrganizationRead,
  ProjectEntry,
  ThreadEntry,
} from '@/lib/theorem/organization'
import {
  isPinned,
  livePins,
  useSidebarPrefs,
} from '@/lib/theorem/sidebar-prefs'
import type { Pin } from '@/lib/theorem/sidebar-prefs'
import { cn } from '@/lib/utils'
import { LibrarianFooter, librarianHasNews } from './librarian-footer'

const HIGHLIGHTED = '[data-organize-row="primary"]'
const panelMotion =
  'duration-(--duration-glide) ease-glide data-ending-style:duration-(--duration-exit) data-ending-style:ease-exit'

/** Remembers a section being open, per browser, with a default until it is touched. */
function useSectionOpen(key: string, fallback: boolean) {
  const open = useShell((s) => s.organizeOpen[key] ?? fallback)
  const set = useShell((s) => s.setOrganizeOpen)
  return [open, (next: boolean) => set(key, next)] as const
}

/** Threads a project lists before "Show more", so one busy project does not push the others away. */
const THREADS_SHOWN = 4
/** Chats outside every project list more: that is where a chat goes until it is filed. */
const CHATS_SHOWN = 8

/** Where a dragged thread can land: a project, or out of every project (null). */
type DropTarget = { projectId: string | null }

const projectItem = (projectId: string) => `project:${projectId}`

/** The thread a drag carries; a dragged project carries none. */
const threadOf = (active: Active | null) =>
  (active?.data.current as Partial<RowDrag> | undefined)?.thread

/** Whether a place takes what is dragged: a thread that is not already there. */
function takes(active: Active | null, projectId: string | null) {
  const thread = threadOf(active)
  if (!thread) return false
  return projectId === null
    ? thread.memberships.length > 0
    : !thread.memberships.some((m) => m.projectId === projectId)
}

const dropRing = 'rounded-lg bg-selected/50 outline-1 outline-focus'

/**
 * A group's name: the rows' own size a step heavier, in the quieter ink, with
 * the space above the group setting it apart instead of a rule (the sidebar
 * rhythm in chat-shell.css).
 */
const HEADING = 'px-2'
/** The group gap comes from the navigation's spacing role, not each group. */
const GROUP = 'p-0'

/** A thread lands on what the pointer is over; a project takes the place of the nearest project. */
const collide: CollisionDetection = (args) =>
  threadOf(args.active)
    ? pointerWithin(args)
    : closestCenter({
        ...args,
        droppableContainers: args.droppableContainers.filter(
          (place) => place.data.current?.sortable,
        ),
      })

/** A project moves up and down its list only; a thread goes where the pointer does. */
const keepProjectsInList: Modifier = (args) =>
  threadOf(args.active)
    ? args.transform
    : restrictToParentElement({
        ...args,
        transform: restrictToVerticalAxis(args),
      })

/**
 * Cancels the click a drag's release makes. dnd-kit stops that click at the
 * document, before React hears it, and leaves its default: Firefox sends it to
 * the dragged row's link, which then loads its page. The window hears it first.
 */
function cancelReleaseClick() {
  const cancel = (event: Event) => event.preventDefault()
  window.addEventListener('click', cancel, { capture: true, once: true })
  // As long as dnd-kit's own guard stays up after a drag.
  setTimeout(
    () => window.removeEventListener('click', cancel, { capture: true }),
    50,
  )
}

/** The chat being started where the composer will file it, until its first message makes it a thread. */
function useStartingIn() {
  const { threadId } = useParams({ strict: false })
  const mode = useShellMode()
  const projectId = useShell((s) => s.projectId)
  return mode === 'chat' && threadId === undefined ? projectId : undefined
}

function StartingRow() {
  return (
    <SidebarMenuSubItem className={TREE_TICK}>
      <SidebarMenuSubButton
        data-organize-row="primary"
        data-appearance-recipe="ui.label"
        aria-current
        className="relative z-[1] w-full translate-x-0"
        render={<button type="button" onClick={() => void focusComposer()} />}
      >
        <Icon.NewChat aria-hidden />
        <span className="min-w-0 flex-1 truncate text-start">New thread</span>
      </SidebarMenuSubButton>
    </SidebarMenuSubItem>
  )
}

/** The rows of a list, forks and continuations nested under their source. */
function ThreadRows({
  threads,
  place,
  first = THREADS_SHOWN,
}: {
  threads: readonly ThreadEntry[]
  place: string
  /** How many show before "Show more". */
  first?: number
}) {
  const { roots, children } = useMemo(() => nestByOrigin(threads), [threads])
  const { threadId: openThreadId } = useParams({ strict: false })
  const [showAll, setShowAll] = useState(false)
  // The first few, and the open one wherever it is, so it stays visibly in its project.
  // A nested open one keeps the root it shows under.
  const openRoot = openThreadId && rootOf(threads, openThreadId)
  const shown = showAll
    ? roots
    : roots.filter(
        (thread, index) => index < first || thread.threadId === openRoot,
      )
  const hidden = roots.length - shown.length
  return (
    <>
      {shown.map((thread) => (
        <ThreadRow
          key={thread.threadId}
          thread={thread}
          place={place}
          childThreads={children.get(thread.threadId)}
          childrenOf={children}
        />
      ))}
      {hidden > 0 && (
        <SidebarMenuSubItem className={TREE_TICK}>
          <SidebarMenuSubButton
            data-appearance-recipe="ui.label"
            className="w-full translate-x-0 text-ink-muted"
            render={<button type="button" onClick={() => setShowAll(true)} />}
          >
            Show {hidden} more
          </SidebarMenuSubButton>
        </SidebarMenuSubItem>
      )}
    </>
  )
}

function ProjectNode({
  project,
  threads,
  starting,
  onNewThread,
  onMove,
  served,
}: {
  project: ProjectEntry
  threads: readonly ThreadEntry[]
  /** A new chat is being started here, so its sessions are shown. */
  starting: boolean
  onNewThread: (projectId: string) => void
  /** Moves the project one place up or down the list, where there is one. */
  onMove: { up?: () => void; down?: () => void }
  served: boolean
}) {
  const [stored, setOpen] = useSectionOpen(
    `project:${project.projectId}`,
    false,
  )
  const open = stored || starting
  const [editingState, setEditingState] = useState(false)
  const pin: Pin = { kind: 'project', id: project.projectId }
  const pinned = useSidebarPrefs((s) => isPinned(s.pins, pin))
  const togglePin = useSidebarPrefs((s) => s.togglePin)
  const { projectId: openProjectId } = useParams({ strict: false })
  const current = openProjectId === project.projectId
  // A graph is offered only where there is something to draw: a fork, a continuation or a message.
  const { data: hasGraph } = useQuery({
    ...organizationQuery(),
    select: (read) => projectHasSessionGraph(read, project.projectId),
  })
  // One node does both: a dragged thread drops on it, and it is dragged among the projects.
  const {
    setNodeRef,
    listeners,
    transform,
    transition,
    isDragging,
    isOver,
    active,
  } = useSortable({
    id: projectItem(project.projectId),
    data: { projectId: project.projectId } satisfies DropTarget,
  })
  const accepting = isOver && takes(active, project.projectId)
  const subtree = `project-tree-${project.projectId}`
  return (
    <SidebarMenuItem
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(
        'group/project',
        accepting && dropRing,
        isDragging &&
          'z-10 rounded-lg bg-raised shadow-md ring-1 ring-separator',
      )}
    >
      <FilesystemItem
        open={open}
        row={
          <>
            <ContextMenu.Root>
              <ContextMenu.Trigger
                render={
                  <SidebarMenuButton
                    {...listeners}
                    data-appearance-recipe="ui.label"
                    data-organize-row={current ? 'primary' : undefined}
                    aria-current={current ? 'page' : undefined}
                    className="relative z-[1] ps-8 pe-8 hover:bg-hover"
                    render={
                      <Link
                        draggable={false}
                        to="/projects/$projectId"
                        params={{ projectId: project.projectId }}
                        onClick={() =>
                          useShell.getState().setProjectId(project.projectId)
                        }
                      />
                    }
                  />
                }
              >
                <span className="min-w-0 flex-1 truncate">{project.title}</span>
              </ContextMenu.Trigger>
              <MenuPopup anchor={undefined} className="min-w-48">
                <MenuItem onClick={() => onNewThread(project.projectId)}>
                  <Icon.NewChat className="size-4" />
                  New thread here
                </MenuItem>
                <MenuItem onClick={() => togglePin(pin)}>
                  {pinned ? (
                    <Icon.Unpin className="size-4" />
                  ) : (
                    <Icon.Pin className="size-4" />
                  )}
                  {pinned ? 'Unpin' : 'Pin'}
                </MenuItem>
                {served && (
                  <MenuItem onClick={() => setEditingState(true)}>
                    <Icon.Notes className="size-4" />
                    Where it stands
                  </MenuItem>
                )}
                {hasGraph && (
                  <MenuLinkItem
                    render={
                      <Link
                        to="/canvas"
                        search={{
                          sessions: scopeParam({
                            kind: 'project',
                            projectId: project.projectId,
                          }),
                        }}
                      />
                    }
                  >
                    <Icon.Graph className="size-4" />
                    Open graph
                  </MenuLinkItem>
                )}
                <MenuSeparator />
                <MenuItem disabled={!onMove.up} onClick={onMove.up}>
                  <Icon.ArrowUp className="size-4" />
                  Move up
                </MenuItem>
                <MenuItem disabled={!onMove.down} onClick={onMove.down}>
                  <Icon.ArrowDown className="size-4" />
                  Move down
                </MenuItem>
              </MenuPopup>
            </ContextMenu.Root>
            {/* The folder opens the project's entries, as a chevron would; the name beside it opens the project. */}
            <button
              type="button"
              aria-expanded={open}
              aria-controls={subtree}
              aria-label={`${open ? 'Hide' : 'Show'} sessions in ${project.title}`}
              onClick={() => setOpen(!open)}
              className="absolute start-1.5 top-1 z-[2] flex size-6 items-center justify-center rounded-md outline-none hover:bg-selected focus-visible:outline-2 focus-visible:outline-focus"
            >
              <FilesystemMarks folder open={open} chevron={false} />
            </button>
            <ProjectStateDialog
              project={project}
              open={editingState}
              onOpenChange={setEditingState}
            />
            {/* The project's new thread is its own target at the row's end. It shows under the pointer or keyboard, as Linear's and Claude's row actions do, so a list of projects is not a column of repeated buttons; only a click, Enter or Space starts one. */}
            <SidebarMenuAction
              aria-label={`New thread in ${project.title}`}
              title={`New thread in ${project.title}`}
              className="top-0.5 text-ink-muted transition-opacity hover:bg-selected hover:text-ink focus-visible:opacity-100 group-hover/project:opacity-100 md:opacity-0 pointer-coarse:opacity-100"
              onClick={() => onNewThread(project.projectId)}
            >
              <Icon.NewChat className="size-3.5" />
            </SidebarMenuAction>
          </>
        }
      >
        <SidebarMenuSub id={subtree} className="ms-4 me-0 gap-px border-l-0 pe-0">
          <ThreadRows threads={threads} place={project.projectId} />
          {project.outputCount > 0 && <ProjectOutputs project={project} />}
          {threads.length === 0 && project.outputCount === 0 && (
            <li className="px-2 py-1 text-xs text-ink-muted">
              No sessions yet. Drag one here, or start a new thread.
            </li>
          )}
        </SidebarMenuSub>
      </FilesystemItem>
    </SidebarMenuItem>
  )
}

const OUTPUT_MARK = {
  app: Icon.Apps,
  artifact: Icon.Artifact,
  upload: Icon.Attachment,
  review: Icon.Approval,
} as const

/**
 * What the project's sessions made, as a folder in its tree: the agent's
 * folder colour, read when it is opened. An entry opens the session that
 * made it.
 */
function ProjectOutputs({ project }: { project: ProjectEntry }) {
  const [open, setOpen] = useSectionOpen(`outputs:${project.projectId}`, false)
  const outputs = useProjectOutputs(open ? project.projectId : undefined)
  const list = `project-outputs-${project.projectId}`
  return (
    <SidebarMenuSubItem className={TREE_TICK}>
      <FilesystemItem
        open={open}
        row={
          <SidebarMenuSubButton
            data-appearance-recipe="ui.label"
            aria-expanded={open}
            aria-controls={list}
            className="w-full translate-x-0 gap-1.5 ps-1 hover:bg-hover"
            render={<button type="button" onClick={() => setOpen(!open)} />}
          >
            <FilesystemMarks
              folder
              open={open}
              chevron={false}
              icon={
                open ? (
                  <FolderOpen
                    aria-hidden="true"
                    className="size-4 shrink-0 fill-folder-agent/35 text-folder-agent"
                  />
                ) : (
                  <Folder
                    aria-hidden="true"
                    className="size-4 shrink-0 fill-folder-agent text-folder-agent"
                  />
                )
              }
            />
            <span className="min-w-0 flex-1 truncate text-start">Outputs</span>
            <span data-appearance-recipe="ui.meta" className="text-xs text-ink-muted tabular-nums">
              {project.outputCount}
            </span>
          </SidebarMenuSubButton>
        }
      >
        <SidebarMenuSub id={list} className="me-0 gap-px border-l-0 pe-0">
          {outputs.isPending && (
            <li className="px-2 py-1 text-xs text-ink-muted">Reading…</li>
          )}
          {outputs.error && (
            <li role="alert" className="px-2 py-1 text-xs text-error-ink">
              {describeError(outputs.error)}
            </li>
          )}
          {outputs.data?.items.map((output) => {
            const Mark = OUTPUT_MARK[output.kind]
            return (
              <SidebarMenuSubItem key={output.outputId} className={TREE_TICK}>
                <SidebarMenuSubButton
                  data-appearance-recipe="ui.label"
                  title={`${output.title}, from its session`}
                  className="w-full translate-x-0 hover:bg-hover"
                  render={
                    <Link to="/c/$threadId" params={{ threadId: output.threadId }} />
                  }
                >
                  <Mark aria-hidden className="text-ink-muted" />
                  <span className="min-w-0 flex-1 truncate">{output.title}</span>
                </SidebarMenuSubButton>
              </SidebarMenuSubItem>
            )
          })}
        </SidebarMenuSub>
      </FilesystemItem>
    </SidebarMenuSubItem>
  )
}

/** Pin order: move one up or down, from the pinned row's menu. */
function PinOrderItems({ index, count }: { index: number; count: number }) {
  const movePin = useSidebarPrefs((s) => s.movePin)
  return (
    <>
      <MenuItem
        disabled={index === 0}
        onClick={() => movePin(index, index - 1)}
      >
        <Icon.ArrowUp className="size-4" />
        Move up in Pinned
      </MenuItem>
      <MenuItem
        disabled={index === count - 1}
        onClick={() => movePin(index, index + 1)}
      >
        <Icon.ArrowDown className="size-4" />
        Move down in Pinned
      </MenuItem>
      <MenuSeparator />
    </>
  )
}

/**
 * One pinned tile: a folder for a project, a page for a session, and its
 * name under it. A link like the row it stands for; its menu (right-click,
 * or the context-menu key) moves it in the shelf or unpins it.
 */
function PinnedTile({
  pin,
  title,
  index,
  count,
  current,
}: {
  pin: Pin
  title: string
  index: number
  count: number
  current: boolean
}) {
  const togglePin = useSidebarPrefs((s) => s.togglePin)
  const link =
    pin.kind === 'project' ? (
      <Link
        to="/projects/$projectId"
        params={{ projectId: pin.id }}
        onClick={() => useShell.getState().setProjectId(pin.id)}
      />
    ) : (
      <Link to="/c/$threadId" params={{ threadId: pin.id }} />
    )
  return (
    <li className="min-w-0">
      <ContextMenu.Root>
        <ContextMenu.Trigger
          data-pinned-tile={pin.kind}
          aria-current={current ? 'page' : undefined}
          title={title}
          className="group flex w-full min-w-0 flex-col items-center gap-1 rounded-lg px-1 pt-2 pb-1 text-ink outline-none transition-colors duration-100 hover:bg-hover focus-visible:outline-2 focus-visible:outline-focus aria-[current=page]:bg-hover"
          render={link}
        >
          {pin.kind === 'project' ? (
            <FolderTile className="mt-0.5" />
          ) : (
            <DocumentTile>
              <SessionGlyph
                threadId={pin.id}
                className="size-2.5 text-ink-muted dark:text-raised"
              />
            </DocumentTile>
          )}
          <span
            data-appearance-recipe="ui.meta"
            className="line-clamp-2 w-full text-center text-[11px] leading-3.5 break-words"
          >
            {title}
          </span>
        </ContextMenu.Trigger>
        <MenuPopup anchor={undefined} className="min-w-48">
          <PinOrderItems index={index} count={count} />
          <MenuItem onClick={() => togglePin(pin)}>
            <Icon.Unpin className="size-4" />
            Unpin
          </MenuItem>
        </MenuPopup>
      </ContextMenu.Root>
    </li>
  )
}

/**
 * The sessions and projects this person keeps at the top, in their order,
 * as a shelf of tiles three across. Kept in this browser until Theorem
 * serves a pin per person; pinning moves nothing and locks nothing.
 */
function PinnedGroup({
  projects,
  byId,
}: {
  projects: readonly ProjectEntry[]
  byId: ReadonlyMap<string, ThreadEntry>
}) {
  const pins = useSidebarPrefs((s) => s.pins)
  const [open, setOpen] = useSectionOpen('pinned', true)
  const { projectId: openProjectId, threadId: openThreadId } = useParams({
    strict: false,
  })
  // Each pin with what it stands for, in the person's order; a pin whose
  // project or session is gone is left out.
  const shelf = pins.flatMap((pin) => {
    if (pin.kind === 'project') {
      const project = projects.find((p) => p.projectId === pin.id)
      return project
        ? [{ pin, title: project.title, current: openProjectId === pin.id }]
        : []
    }
    const thread = byId.get(pin.id)
    return thread
      ? [
          {
            pin,
            title: thread.title || 'New chat',
            current: openThreadId === pin.id,
          },
        ]
      : []
  })
  // Shown once something is pinned, as Linear shows Favorites: an empty
  // heading and a standing hint cost a sidebar row on every visit, and Pin is
  // in every row's menu.
  if (shelf.length === 0) return null
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <SidebarGroup className={GROUP}>
        <SidebarGroupLabel
          data-appearance-recipe="ui.section"
          className={HEADING}
          render={
            <CollapsibleTrigger className="w-full justify-start gap-1 hover:bg-hover focus-visible:outline-2 focus-visible:outline-focus" />
          }
        >
          Pinned
          <Icon.ChevronRight
            aria-hidden
            className="size-3.5 text-ink-muted transition-transform duration-(--duration-snap) ease-snap in-data-panel-open:rotate-90"
          />
        </SidebarGroupLabel>
        <CollapsiblePanel className={panelMotion}>
          <ul aria-label="Pinned" className="grid grid-cols-3 gap-1 px-1 pt-1">
            {shelf.map(({ pin, title, current }) => (
              <PinnedTile
                key={`${pin.kind}:${pin.id}`}
                pin={pin}
                title={title}
                current={current}
                index={pins.indexOf(pin)}
                count={pins.length}
              />
            ))}
          </ul>
        </CollapsiblePanel>
      </SidebarGroup>
    </Collapsible>
  )
}

/**
 * The chats outside every project, beside the projects and not among them: a
 * chat started with no project is listed here, and a thread dragged here
 * leaves its projects.
 */
function ChatsGroup({
  threads,
  starting,
  onNewChat,
}: {
  threads: readonly ThreadEntry[]
  starting: boolean
  onNewChat: () => void
}) {
  const { setNodeRef, isOver, active } = useDroppable({
    id: 'unsorted',
    data: { projectId: null } satisfies DropTarget,
  })
  const accepting = isOver && takes(active, null)
  return (
    // It runs to the bottom of the list, so the space under the chats takes a thread out of its projects too.
    <SidebarGroup
      ref={setNodeRef}
      className={cn(GROUP, 'flex-1', accepting && dropRing)}
    >
      <SidebarGroupLabel
        data-appearance-recipe="ui.section"
        className={HEADING}
      >
        Recent
      </SidebarGroupLabel>
      <SidebarGroupAction
        aria-label="New chat"
        title="New chat"
        className="top-1 right-1"
        onClick={onNewChat}
      >
        <Icon.Add />
      </SidebarGroupAction>
      {/* The rows a project nests, here at the top level: no guide line, no ticks. */}
      <SidebarMenuSub className="mx-0 translate-x-0 gap-px border-l-0 px-0 *:before:hidden">
        {starting && <StartingRow />}
        <ThreadRows threads={threads} place="unsorted" first={CHATS_SHOWN} />
      </SidebarMenuSub>
    </SidebarGroup>
  )
}

/**
 * The sidebar's search: assistant-ui's thread search over every thread the
 * tree draws, grouped by project, pins first. Its list takes the tree's place
 * while there is a query.
 */
function SidebarSearch({
  views,
  query,
  onQueryChange,
}: {
  views: ReturnType<typeof useOrganizedViews>
  query: string
  onQueryChange: (query: string) => void
}) {
  const navigate = useNavigate()
  const pins = useSidebarPrefs((s) => s.pins)
  const [activeId, setActiveId] = useState('')
  const threads = useMemo(() => {
    const titles = new Map(
      views.projects.map(({ project }) => [project.projectId, project.title]),
    )
    const listed = new Map<string, ThreadEntry>()
    for (const project of views.projects)
      for (const thread of project.threads) listed.set(thread.threadId, thread)
    for (const thread of views.unsorted) listed.set(thread.threadId, thread)
    return [...listed.values()]
      .sort((a, b) => lastMoved(b) - lastMoved(a))
      .map(
        (thread): SearchableThread => ({
          id: thread.threadId,
          title: thread.title || 'New chat',
          group: titles.get(primaryProjectId(thread)) ?? 'Recent',
          preview: thread.summary?.text ?? '',
          pinned: isPinned(pins, { kind: 'thread', id: thread.threadId }),
        }),
      )
  }, [views, pins])
  // The first match is active until the arrows move it.
  const needle = query.toLowerCase()
  const matches = threads.filter((thread) =>
    `${thread.title} ${thread.preview}`.toLowerCase().includes(needle),
  )
  const active = matches.some((thread) => thread.id === activeId)
    ? activeId
    : (matches.find((thread) => thread.pinned) ?? matches[0])?.id ?? ''
  const open = (threadId: string) => {
    const thread = views.byId.get(threadId)
    if (thread) useShell.getState().setProjectId(primaryProjectId(thread))
    onQueryChange('')
    void navigate({ to: '/c/$threadId', params: { threadId } })
  }
  return (
    <ThreadSearch
      threads={threads}
      query={query}
      onQueryChange={onQueryChange}
      activeId={active}
      onActiveChange={setActiveId}
      onSelect={open}
      placeholder="Search"
      listWhenEmpty={false}
      data-sidebar-search=""
      className={cn(
        'max-w-none gap-1 rounded-none border-0 bg-transparent p-0 dark:bg-transparent',
        query && 'min-h-0 flex-1',
      )}
      fieldClassName="h-8 rounded-md bg-raised/55 px-2 py-0 ring-1 ring-separator ring-inset has-focus-visible:outline-2 has-focus-visible:outline-focus dark:bg-raised/55 [&_input]:outline-none! [&_input]:text-sm [&_input]:text-ink [&_input]:placeholder:text-ink-muted [&_svg]:text-ink-muted"
      listClassName="min-h-0 flex-1 overflow-y-auto pt-1"
    />
  )
}

function WorkspaceHeader({
  organization,
  onNewProject,
  search,
  searching,
}: {
  organization: OrganizationRead | undefined
  onNewProject: () => void
  search: React.ReactNode
  searching: boolean
}) {
  const tenant = useTenant()
  const control = useLibrarianControl()
  const librarian = organization?.served ? organization.librarian : undefined
  return (
    <div
      className={cn(
        'flex shrink-0 flex-col gap-1 px-1.5 pt-1.5 pb-1',
        searching && 'min-h-0 flex-1',
      )}
    >
      <Menu>
        <MenuTrigger
          render={
            <Button
              variant="ghost"
              className="h-12 w-full justify-start gap-2 rounded-lg px-2 text-start font-normal hover:bg-hover data-popup-open:bg-hover"
            />
          }
        >
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="truncate text-[1.0625rem] leading-tight font-semibold">
              Theorem
            </span>
            <span className="truncate text-xs leading-tight text-ink-faint-sheet">
              {tenant ?? 'Personal workspace'}
            </span>
          </span>
          <Icon.UpDown className="size-3.5 shrink-0 text-ink-faint" />
        </MenuTrigger>
        <MenuPopup align="start" className="min-w-52">
          <MenuItem onClick={onNewProject}>
            <Icon.Folder className="size-4" />
            New project
          </MenuItem>
          {librarian && (
            <MenuItem
              onClick={() => control.mutate({ paused: !librarian.paused })}
            >
              <Icon.Librarian className="size-4" />
              {librarian.paused
                ? 'Resume the Librarian'
                : 'Pause the Librarian'}
            </MenuItem>
          )}
          <MenuSeparator />
          <MenuLinkItem render={<Link to="/settings" />}>
            <Icon.Settings className="size-4" />
            Settings
          </MenuLinkItem>
        </MenuPopup>
      </Menu>
      {search}
    </div>
  )
}

/** Keeps the tree honest about what this tab just did: a new thread, a run ending. */
function useFreshAfterRuns(known: (threadId: string) => boolean) {
  const client = useQueryClient()
  const { threadId } = useParams({ strict: false })
  const running = useAuiState((s) => s.thread.isRunning)
  const missing = threadId !== undefined && !known(threadId)
  useEffect(() => {
    void client.invalidateQueries({ queryKey: organizationKey })
  }, [client, running, missing])
}

/** Chat's panel: search in its header, New thread, the person's pins, a stable project tree and the chats outside it, the Librarian below. */
export function OrganizedPanel() {
  const { data, error, isPending, dataUpdatedAt } = useOrganization()
  const navigate = useNavigate()
  const create = useCreateProject()
  const views = useOrganizedViews()
  const [query, setQuery] = useState('')
  const searching = query.trim() !== ''
  useRevealOpenThread(views)
  useFreshAfterRuns((threadId) => views.byId.has(threadId))

  const inbox = data?.projects.find((project) => project.isInbox)
  const startingIn = useStartingIn()
  // A chat started outside every project shows under Recent until it is filed.
  const startingUnsorted =
    startingIn !== undefined &&
    (startingIn === inbox?.projectId ||
      !views.projects.some((p) => p.project.projectId === startingIn))

  const newThread = (projectId = inbox?.projectId) => {
    const shell = useShell.getState()
    if (projectId) {
      shell.setProjectId(projectId)
      if (projectId !== inbox?.projectId)
        shell.setOrganizeOpen(`project:${projectId}`, true)
    }
    void navigate({ to: '/' }).then(() =>
      requestAnimationFrame(() => void focusComposer()),
    )
  }

  const { threadId: openThreadId } = useParams({ strict: false })
  const listRef = useRef<HTMLDivElement>(null)
  const pillRef = useRef<HTMLDivElement>(null)
  useGlideHighlight(listRef, pillRef, HIGHLIGHTED, 'data-organize-row')

  // The arrow keys walk the threads in the order the tree draws them. A pinned
  // session is listed twice, so the walk goes by row, not by address.
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    if ((event.target as HTMLElement).closest('input, [role="menu"]')) return
    const links = [
      ...(listRef.current?.querySelectorAll<HTMLAnchorElement>(
        'a[href^="/c/"]',
      ) ?? []),
    ]
    if (!links.length) return
    const focused = (event.target as HTMLElement).closest('a')
    const openHref = openThreadId ? `/c/${openThreadId}` : undefined
    const at = focused
      ? links.indexOf(focused)
      : links.findIndex((link) => link.getAttribute('href') === openHref)
    const rows = links.map((_, index) => String(index))
    const next = neighbour(
      rows,
      at < 0 ? undefined : String(at),
      event.key === 'ArrowDown' ? 1 : -1,
    )
    if (next === undefined) return
    event.preventDefault()
    links[Number(next)]?.focus()
  }

  // A pin whose session or project is gone goes too, once a complete read
  // from Theorem has said so.
  const prunePins = useSidebarPrefs((s) => s.prunePins)
  useEffect(() => {
    const exists = data && livePins(data)
    if (exists) prunePins(exists)
  }, [data, prunePins])

  // A drag starts after a few pixels, so a click on a row still opens it.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  )
  const mover = useMoveThread()
  /** The thread being dragged; a dragged project is its own row. */
  const [dragging, setDragging] = useState<RowDrag>()
  /** A project is being dragged, so rows sit away from where they are laid out. */
  const [sorting, setSorting] = useState(false)
  const projectIds = views.projects.map(({ project }) => project.projectId)
  const projectItems = projectIds.map(projectItem)
  const setProjectOrder = useShell((s) => s.setProjectOrder)
  // A new project opens on its own page, its name ready to type over.
  const createProject = () => {
    if (create.isPending) return
    create.mutate('New project', {
      onSuccess: ({ record }) => {
        // It stays where it was made: first in the list.
        setProjectOrder([record.projectId, ...projectIds])
        void navigate({
          to: '/projects/$projectId',
          params: { projectId: record.projectId },
          search: { naming: true },
        })
      },
    })
  }
  const placeProject = (from: number, to: number) => {
    if (from < 0 || to < 0 || from === to || to >= projectIds.length) return
    setProjectOrder(arrayMove(projectIds, from, to))
  }
  const onDragStart = ({ active }: DragStartEvent) => {
    if (threadOf(active)) setDragging(active.data.current as RowDrag)
    else setSorting(true)
  }
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    setDragging(undefined)
    setSorting(false)
    cancelReleaseClick()
    if (!over) return
    const drag = active.data.current as Partial<RowDrag>
    if (!drag.thread || drag.from === undefined) {
      placeProject(
        projectItems.indexOf(String(active.id)),
        projectItems.indexOf(String(over.id)),
      )
      return
    }
    const { projectId } = over.data.current as DropTarget
    mover.move(drag.thread, drag.from, projectId)
    if (projectId)
      useShell.getState().setOrganizeOpen(`project:${projectId}`, true)
  }
  const onDragCancel = () => {
    setDragging(undefined)
    setSorting(false)
    cancelReleaseClick()
  }

  const tree = useMemo(
    () => ({
      projects: data?.projects ?? [],
      views,
      served: data?.served ?? false,
      readAtMs: dataUpdatedAt,
    }),
    [data, views, dataUpdatedAt],
  )

  return (
    <div data-organize-panel className="flex h-full flex-col">
      <WorkspaceHeader
        organization={data}
        onNewProject={createProject}
        searching={searching}
        search={
          <SidebarSearch
            views={views}
            query={query}
            onQueryChange={setQuery}
          />
        }
      />
      <SidebarMenu hidden={searching} className="shrink-0 px-2 pb-1">
        <SidebarMenuItem>
          <SidebarMenuButton
            data-appearance-recipe="ui.label"
            className="text-ink-muted hover:bg-hover hover:text-ink"
            onClick={() => newThread()}
          >
            <Icon.NewChat aria-hidden />
            <span className="min-w-0 flex-1 truncate">New thread</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
      <SidebarContent
        hidden={searching}
        role="navigation"
        aria-label="Threads"
        className="relative gap-0 px-2 pb-3"
      >
        <div
          ref={pillRef}
          aria-hidden
          style={{ opacity: 0 }}
          className={cn(
            'pointer-events-none absolute rounded-lg bg-selected',
            // The highlight is placed by layout, which a dragged project leaves.
            sorting && 'invisible',
          )}
        />
        <OrganizeTree.Provider value={tree}>
          <DndContext
            sensors={sensors}
            collisionDetection={collide}
            modifiers={[keepProjectsInList]}
            onDragStart={onDragStart}
            onDragEnd={onDragEnd}
            onDragCancel={onDragCancel}
          >
            <div
              ref={listRef}
              onKeyDown={onKeyDown}
              data-appearance-spacing-role="group-controls"
              className="flex flex-1 flex-col pt-2"
            >
              <PinnedGroup projects={data?.projects ?? []} byId={views.byId} />
              <SidebarGroup className={GROUP}>
                <SidebarGroupLabel
                  data-appearance-recipe="ui.section"
                  className={HEADING}
                >
                  Projects
                </SidebarGroupLabel>
                <SidebarGroupAction
                  aria-label="New project"
                  title="New project"
                  className="top-1 right-1"
                  disabled={create.isPending}
                  onClick={createProject}
                >
                  <Icon.Add />
                </SidebarGroupAction>
                <SidebarMenu className="gap-px">
                  {isPending &&
                    Array.from({ length: 4 }, (_, index) => (
                      <SidebarMenuSkeleton key={index} />
                    ))}
                  <SortableContext
                    items={projectItems}
                    strategy={verticalListSortingStrategy}
                  >
                    {views.projects.map(({ project, threads }, index) => (
                      <ProjectNode
                        key={project.projectId}
                        project={project}
                        threads={threads}
                        starting={startingIn === project.projectId}
                        served={tree.served}
                        onNewThread={newThread}
                        onMove={{
                          up:
                            index > 0
                              ? () => placeProject(index, index - 1)
                              : undefined,
                          down:
                            index < projectIds.length - 1
                              ? () => placeProject(index, index + 1)
                              : undefined,
                        }}
                      />
                    ))}
                  </SortableContext>
                </SidebarMenu>
                {(error ?? mover.error ?? create.error) && (
                  <p role="alert" className="px-2 py-1 text-xs text-error-ink">
                    {describeError(error ?? mover.error ?? create.error)}
                  </p>
                )}
              </SidebarGroup>
              <ChatsGroup
                threads={views.unsorted}
                starting={startingUnsorted}
                onNewChat={() => newThread()}
              />
            </div>
            <DragOverlay dropAnimation={null}>
              {dragging && (
                <div className="flex h-8 max-w-56 items-center gap-2 rounded-lg bg-raised px-2 text-sm shadow-md ring-1 ring-separator">
                  <SessionGlyph
                    threadId={dragging.thread.threadId}
                    className="text-ink-muted"
                  />
                  <span className="min-w-0 truncate">
                    {dragging.thread.title || 'New chat'}
                  </span>
                </div>
              )}
            </DragOverlay>
          </DndContext>
        </OrganizeTree.Provider>
      </SidebarContent>
      <ThreadFromFailure />
      <SessionTypeDialog />
      {data?.served && librarianHasNews(data.librarian) && (
        <LibrarianFooter librarian={data.librarian} />
      )}
    </div>
  )
}
