// SOURCING: Base UI Popover (placement, collision, dismissal) as components/program/palette uses it, opened from the composer's + menu and anchored to it; coss ui Switch and Checkbox for the toggles, fuzzysort through connections/search for the filter, the assistant-ui thread item for the conversation's id; the roster is GET /api/connections/v1/tools (lib/theorem/connections) and the per-conversation choice is lib/theorem/tool-selection, starting from the connections the conversation's project names (lib/theorem/project-context; the thread's home project, or for a new conversation the project the shell will create it in, as the runtime does). A real switch per row, not cmdk: a switch inside a cmdk option is a control inside an option, which screen readers cannot reach.
import { useAuiState } from '@assistant-ui/react'
import { Popover } from '@base-ui/react/popover'
import { Link } from '@tanstack/react-router'
import { useEffect, useMemo, useState } from 'react'
import type { RefObject } from 'react'
import { EffectBadge } from '@/components/connections/parts'
import { matching } from '@/components/connections/search'
import { Checkbox } from '@/components/coss/checkbox'
import { Input } from '@/components/coss/input'
import { Switch } from '@/components/coss/switch'
import { useMenuGlass } from '@/components/glass/menu-glass'
import { Icon } from '@/components/icons'
import { useActiveProject } from '@/components/shell/projects'
import { Button } from '@/components/ui/button'
import { describeError } from '@/lib/theorem/client'
import type { ToolGroup, useConnectionTools } from '@/lib/theorem/connections'
import { useOrganization } from '@/lib/theorem/organization'
import { isNotServed } from '@/lib/theorem/passthrough'
import { useProjectContext } from '@/lib/theorem/project-context'
import {
  changeSelection,
  connectionsOn,
  projectBase,
  reconcile,
  toolId,
  toolsOn,
  useToolSelections,
} from '@/lib/theorem/tool-selection'
import type { ToolSelection } from '@/lib/theorem/tool-selection'
import { cn } from '@/lib/utils'
import { COMPOSER_CHIP } from './composer-tools'

type ConnectionTools = ReturnType<typeof useConnectionTools>

/** Whether this Theorem lists connections at all; the + menu offers them only then. */
export const connectionsServed = (tools: ConnectionTools) =>
  !tools.isPending && !(tools.error && isNotServed(tools.error))

/**
 * The connections a conversation starts from: the ones its project names, or
 * every connection switched on in Settings when the project names none
 * (`base` undefined). `baseKnown` is false while that is still loading.
 */
export function useProjectConnections(): {
  base: ToolSelection | undefined
  baseKnown: boolean
} {
  // A new conversation has only its local id until its first send gives it the durable one.
  const remoteId = useAuiState((state) => state.threadListItem.remoteId)
  const project = useConversationProject(remoteId)
  const context = useProjectContext(project.projectId)
  // React Query keeps an unchanged answer's identity, so the base changes only when the project's choice does.
  const chosen = context.data?.connections
  const base = useMemo(() => projectBase(chosen), [chosen])
  // A Theorem from before project context answers 404, which settles it: no project names anything.
  const baseKnown =
    project.known &&
    (project.projectId === undefined ||
      context.isSuccess ||
      (context.isError && isNotServed(context.error)))
  return { base, baseKnown }
}

/**
 * The project whose connections a conversation starts from: the one Theorem
 * reads, the thread's home project, or for a conversation not sent yet the
 * project it will be created in. `known` is false until Theorem has said which
 * project that is: while the lists load, and for a conversation just sent that
 * the organization does not list yet.
 */
function useConversationProject(remoteId: string | undefined): {
  projectId: string | undefined
  known: boolean
} {
  const organization = useOrganization()
  const active = useActiveProject()
  if (remoteId === undefined)
    return { projectId: active.project?.projectId, known: !active.isPending }
  const thread = organization.data?.threads.find(
    (entry) => entry.threadId === remoteId,
  )
  return { projectId: thread?.homeProjectId, known: thread !== undefined }
}

/**
 * Which connections' tools this conversation may use, opened from the
 * composer's + menu and placed against it. It starts on the connections its
 * project names, or every connection switched on in Settings when the project
 * names none, and sends nothing (Theorem applies the project's choice itself);
 * once the person changes it, each turn carries the choice, and a chip beside
 * the + button says so and opens it again.
 */
export function ComposerConnections({
  tools,
  threadKey,
  base,
  baseKnown,
  open,
  onOpenChange,
  anchor,
}: {
  /** The roster query, held by the + menu so a failed load is not fetched again on opening. */
  tools: ConnectionTools
  threadKey: string
  /** The project's choice, which a conversation with none of its own follows. */
  base: ToolSelection | undefined
  /** False while the project's choice is still loading, when `base` says nothing yet. */
  baseKnown: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
  anchor: RefObject<HTMLElement | null>
}) {
  const roster = tools.data
  const stored = useToolSelections((state) => state.byThread[threadKey])
  const save = useToolSelections((state) => state.set)
  const selection = useMemo(
    () => (roster ? reconcile(roster, stored, base, baseKnown) : stored),
    [roster, stored, base, baseKnown],
  )

  // A connection removed since the choice was made drops out of it, so a send never names one that is gone.
  useEffect(() => {
    if (roster && JSON.stringify(selection) !== JSON.stringify(stored))
      save(threadKey, selection)
  }, [roster, selection, stored, save, threadKey])

  const custom = selection !== undefined
  const effective = selection ?? base
  const { attach: glassRef, className: glassClass } = useMenuGlass('composer')
  const count = connectionsOn(roster ?? [], effective).size

  return (
    <Popover.Root open={open} onOpenChange={onOpenChange}>
      {custom && (
        <button
          type="button"
          aria-label={`Connections, ${count} on`}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => onOpenChange(true)}
          className={COMPOSER_CHIP}
        >
          <Icon.Plugin className="size-3.5" />
          <span className="tabular-nums">
            {count} {count === 1 ? 'connection' : 'connections'}
          </span>
        </button>
      )}
      <Popover.Portal>
        <Popover.Positioner
          className="z-50"
          anchor={anchor}
          side="top"
          align="start"
          sideOffset={6}
          collisionPadding={8}
        >
          <Popover.Popup
            aria-label="MCP connections"
            finalFocus={anchor}
            ref={glassRef}
            className={cn(
              'w-80 max-w-[calc(100vw-1rem)] overflow-hidden rounded-lg border border-separator bg-raised text-ink shadow-lg outline-none',
              glassClass,
            )}
          >
            <Roster
              roster={roster}
              error={tools.error}
              retry={() => void tools.refetch()}
              selection={effective}
              followsProject={base !== undefined && !custom}
              onChange={(change) =>
                save(
                  threadKey,
                  changeSelection(roster ?? [], selection, change, base),
                )
              }
              onReset={custom ? () => save(threadKey, undefined) : undefined}
              resetLabel={
                base ? "Use the project's connections" : 'Use every connection'
              }
              onLeave={() => onOpenChange(false)}
            />
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  )
}

type Visible = { group: ToolGroup; tools: ToolGroup['tools']; forceOpen: boolean }

/** The connections and tools that match what was typed; a connection's own name keeps all its tools. */
function visible(roster: readonly ToolGroup[], query: string): Visible[] {
  if (!query.trim())
    return roster.map((group) => ({ group, tools: group.tools, forceOpen: false }))
  return roster.flatMap((group) => {
    const named = matching([group], query, (entry) => entry.label).length > 0
    const hits = matching(
      group.tools,
      query,
      (tool) => tool.title ?? tool.name,
      (tool) => tool.name,
    )
    if (!named && hits.length === 0) return []
    return [{ group, tools: named ? group.tools : hits, forceOpen: !named }]
  })
}

function Roster({
  roster,
  error,
  retry,
  selection,
  followsProject,
  onChange,
  onReset,
  resetLabel,
  onLeave,
}: {
  roster: ToolGroup[] | undefined
  error: unknown
  retry: () => void
  /** What is on now: the conversation's own choice, or the project's. */
  selection: Parameters<typeof connectionsOn>[1]
  followsProject: boolean
  onChange: (change: Parameters<typeof changeSelection>[2]) => void
  /** Back to the default; absent while the conversation has no choice of its own. */
  onReset: (() => void) | undefined
  resetLabel: string
  onLeave: () => void
}) {
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const groups = useMemo(() => visible(roster ?? [], query), [roster, query])
  const connections = connectionsOn(roster ?? [], selection)
  const tools = toolsOn(roster ?? [], selection)

  const toggleExpanded = (id: string) =>
    setExpanded((current) => {
      const next = new Set(current)
      if (!next.delete(id)) next.add(id)
      return next
    })

  return (
    <div className="flex flex-col">
      {roster && roster.length > 0 && (
        <div className="border-b border-separator p-2">
          <Input
            type="search"
            aria-label="Search connections and tools"
            placeholder="Search connections and tools"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
      )}

      <div className="max-h-80 overflow-y-auto p-1">
        {error && !roster ? (
          <div className="flex flex-col items-start gap-2 px-2 py-3">
            <p role="alert" className="text-sm text-error-ink">
              {describeError(error)}
            </p>
            <Button variant="outline" size="sm" onClick={retry}>
              Try again
            </Button>
          </div>
        ) : roster && roster.length === 0 ? (
          <div className="flex flex-col gap-1 px-2 py-3">
            <p className="text-sm">Nothing is connected yet.</p>
            <p className="text-xs text-ink-muted">
              Connect GitHub or add an MCP server in Settings, and its tools
              show up here.
            </p>
          </div>
        ) : groups.length === 0 ? (
          <p className="px-2 py-3 text-sm text-ink-muted">
            Nothing matches that.
          </p>
        ) : (
          <ul className="flex flex-col">
            {groups.map(({ group, tools: shown, forceOpen }) => {
              const id = group.connectionId
              const isOpen = forceOpen || expanded.has(id)
              const on = connections.has(id)
              const available = group.tools.filter((tool) =>
                tools.has(toolId(id, tool.name)),
              ).length
              return (
                <li key={id} className="flex flex-col">
                  <div className="flex items-center gap-1.5 pe-2">
                    <button
                      type="button"
                      aria-expanded={isOpen}
                      aria-label={`${isOpen ? 'Hide' : 'Show'} the tools of ${group.label}`}
                      onClick={() => toggleExpanded(id)}
                      className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 py-1.5 text-start text-sm outline-none hover:bg-hover focus-visible:outline-2 focus-visible:outline-focus"
                    >
                      <Icon.ChevronRight
                        className={cn(
                          'size-3.5 shrink-0 transition-transform',
                          isOpen && 'rotate-90',
                        )}
                      />
                      <span className="min-w-0 flex-1 truncate">{group.label}</span>
                      <span className="shrink-0 text-xs text-ink-faint">
                        {!group.enabled
                          ? 'Off in Settings'
                          : on && available < group.tools.length
                            ? `${available} of ${group.tools.length} tools`
                            : `${group.tools.length} ${group.tools.length === 1 ? 'tool' : 'tools'}`}
                      </span>
                    </button>
                    <Switch
                      aria-label={`${group.label} available in this conversation`}
                      checked={on}
                      disabled={!group.enabled}
                      onCheckedChange={(next) =>
                        onChange({ connection: id, on: next })
                      }
                    />
                  </div>
                  {isOpen && (
                    <ul className="flex flex-col pb-1 ps-7">
                      {shown.map((tool) => (
                        <li key={tool.name}>
                          <label className="flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-sm hover:bg-hover">
                            <Checkbox
                              checked={tools.has(toolId(id, tool.name))}
                              disabled={!on}
                              onCheckedChange={(next) =>
                                onChange({ tool: toolId(id, tool.name), on: next })
                              }
                            />
                            <span
                              className="min-w-0 flex-1 truncate"
                              title={tool.description}
                            >
                              {tool.title ?? tool.name}
                            </span>
                            <EffectBadge effect={tool.effect} />
                          </label>
                        </li>
                      ))}
                      {shown.length === 0 && (
                        <li className="px-1.5 py-1 text-xs text-ink-muted">
                          This connection lists no tools.
                        </li>
                      )}
                    </ul>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </div>

      {(followsProject || onReset) && roster && roster.length > 0 && (
        <div className="flex min-h-9 items-center gap-2 border-t border-separator px-3 py-1.5">
          <p className="min-w-0 flex-1 text-xs text-ink-muted">
            {onReset
              ? 'This conversation has its own choice.'
              : "This project's connections."}
          </p>
          {onReset && (
            <Button variant="ghost" size="xs" onClick={onReset}>
              {resetLabel}
            </Button>
          )}
        </div>
      )}

      <div className="border-t border-separator p-1">
        <Link
          to="/settings/connections"
          onClick={onLeave}
          className="flex h-8 items-center gap-2 rounded-md px-2 text-sm text-ink-muted outline-none hover:bg-hover hover:text-ink focus-visible:bg-hover"
        >
          <Icon.Plugin className="size-3.5" />
          {roster && roster.length === 0
            ? 'Set up connections'
            : 'Manage connections'}
        </Link>
      </div>
    </div>
  )
}
