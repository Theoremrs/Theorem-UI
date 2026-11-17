// SOURCING: Base UI Menu (account menu), @dnd-kit/core + @dnd-kit/sortable + @dnd-kit/modifiers (reordering the destinations), @dnd-kit/accessibility (saying a keyboard move aloud), Kit's home slot (the stage stands the fox in it), the agent terminal toggle, ui/tooltip over Base UI Tooltip, ThemeToggle (next-themes light/dark), the shell's mode routes and tenant hook, the opened folders (whether the Vault is offered), the sign-in helpers (sign out), glass/liquid-glass (the junction's tab is a pane of the navigation panel's glass)
import { Menu } from '@base-ui/react/menu'
import { LiveRegion, useAnnouncement } from '@dnd-kit/accessibility'
import { DndContext, PointerSensor, useSensor, useSensors } from '@dnd-kit/core'
import type { Announcements, DragEndEvent } from '@dnd-kit/core'
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
import { useLayoutEffect, useRef, useState } from 'react'
import type {
  ComponentProps,
  CSSProperties,
  KeyboardEvent,
  ReactNode,
} from 'react'
import { Icon } from '@/components/icons'
import { useLiquidGlass } from '@/components/glass/liquid-glass/use-liquid-glass'
import type { LiquidEdges } from '@/components/glass/liquid-glass/use-liquid-glass'
import { Button } from '@/components/ui/button'
import { ThemeToggle } from '@/components/settings/theme-toggle'
import { KitPerch } from '@/components/kit/kit-stage'
import { useSurfaceMaterial } from '@/lib/appearance'
import { signOut, useSignInConfigured } from '@/lib/theorem/sign-in'
import { useWorkspaces } from '@/lib/workspace/workspaces'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { RailMark } from './rail-marks'
import {
  MODES,
  modeLabel,
  navigatorMode,
  useOpenMode,
  useShellMode,
} from './modes'
import type { ShellMode } from './modes'
import { useTenant } from './projects'
import { useShell } from './shell-state'
import { menuItem, menuPopup } from './sidebar'

import { Link } from '@tanstack/react-router'
import { useCommandPalette } from './command-palette'

/** The rail's square controls: destinations and the account. */
const railButton =
  'group/rail relative flex size-8 items-center justify-center rounded-[10px] text-ink-faint transition-colors duration-100 outline-none hover:bg-ink/8 hover:text-ink focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus'

/** The signed-in tenant as an initial outlined in the accent, with account actions behind it. */
function AccountMenu() {
  const tenant = useTenant()
  const signIn = useSignInConfigured()

  return (
    <Menu.Root>
      <Menu.Trigger
        aria-label={tenant ? `Account, ${tenant}` : 'Account'}
        className="flex size-8 items-center justify-center rounded-[9px] border-[1.5px] border-redwood pt-px font-heading text-[18px] font-semibold leading-none text-redwood transition-colors duration-100 outline-none hover:bg-redwood/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus data-popup-open:bg-redwood/15"
      >
        {tenant?.charAt(0).toUpperCase()}
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner
          side="right"
          align="end"
          sideOffset={8}
          className="z-50"
        >
          <Menu.Popup
            data-appearance-part="popover"
            data-appearance-recipe="ui.label"
            className={`min-w-52 ${menuPopup}`}
          >
            {tenant && (
              <>
                <div className="truncate px-2 pt-1 pb-1.5 text-sm font-medium">
                  {tenant}
                </div>
                <Menu.Separator className="my-1 h-px bg-separator" />
              </>
            )}
            <Menu.Item className={menuItem} render={<Link to="/settings" />}>
              <Icon.Settings className="size-4 text-ink-muted" />
              <span className="min-w-0 flex-1">Settings</span>
            </Menu.Item>
            <Menu.Item
              className={menuItem}
              onClick={() => useCommandPalette.getState().setOpen(true)}
            >
              <Icon.Search className="size-4 text-ink-muted" />
              <span className="min-w-0 flex-1">Search</span>
              <span className="text-xs text-ink-faint">⌘K</span>
            </Menu.Item>
            {signIn && (
              <>
                <Menu.Separator className="my-1 h-px bg-separator" />
                <Menu.Item className={menuItem} onClick={() => void signOut()}>
                  Sign out
                </Menu.Item>
              </>
            )}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  )
}

/** Shows and hides the agent terminal drawer. */
function TerminalToggle() {
  const open = useShell((s) => s.terminalOpen)
  const setOpen = useShell((s) => s.setTerminalOpen)
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label="Agent terminal"
      aria-pressed={open}
      onClick={() => setOpen(!open)}
      className={`${railButton} mb-2 aria-pressed:text-ink`}
    >
      <Icon.Terminal className="size-5" strokeWidth={1.75} />
    </Button>
  )
}

/**
 * The sheet reaching into the rail behind the active destination: a tab whose
 * right end flows into the sheet's edge through two concave corners. It paints
 * what it joins, so the join has no seam: the mode's panel while that is open,
 * otherwise the sheet's field at the tab's own height (appearance.css). It
 * slides when the mode changes.
 */
function Junction({ y, lead, h, t, flush, joins }: Junction) {
  const tab = useRef<HTMLSpanElement>(null)
  const material = useSurfaceMaterial('navigation')
  // Under glass the panel is a liquid pane (floating-card.tsx), so the tab
  // that opens onto it is drawn by the same renderer in the same glass.
  const liquid =
    joins === 'navigation' && (material === 'liquid' || material === 'glass')
  // It runs on into the panel through concave corners drawn in the same
  // glass, so the panel alone shows the selection; level with the top it runs
  // straight on into the panel's top edge, with no corner above.
  useLiquidGlass(tab, liquid, TAB_EDGES, {
    pane: '[data-appearance-part="navigation"]',
    top: !flush,
    bottom: true,
  })
  return (
    <div
      aria-hidden="true"
      className="rail-junction"
      data-joins={joins}
      data-flush={flush || undefined}
      style={
        {
          '--rail-y': `${y}px`,
          '--junction-lead': `${y - lead}px`,
          '--junction-item': `${h}px`,
          '--rail-t': t,
        } as CSSProperties
      }
    >
      <span ref={tab} className="rail-junction-tab" />
      <span className="rail-junction-corner" data-edge="top" />
      <span className="rail-junction-corner" data-edge="bottom" />
    </div>
  )
}

/** The tab runs on into the panel on its right, so that side does not curve. */
const TAB_EDGES: LiquidEdges = {
  top: true,
  right: false,
  bottom: true,
  left: true,
}

type Junction = {
  y: number
  /** Where the tab's top edge starts: y, or the sheet's top when it is flush. */
  lead: number
  h: number
  t: number
  /** The tab is the first, level with the sheet's top edge, and runs straight on into it. */
  flush: boolean
  /** The surface the tab opens onto: the mode's panel, or the sheet. */
  joins: 'navigation' | 'sheet'
}

/**
 * Reveals the files in the navigator beside the rail, over the mode's own
 * list, and hides them again. It changes what the panel shows, not where the
 * person is. On the desktop the IDE and the Vault cover the panel, so from them
 * it goes back to Chat; a phone's drawer shows the panel over every mode.
 */
function FilesControl({ collapsible }: { collapsible: boolean }) {
  const mode = useShellMode()
  const openMode = useOpenMode()
  const panelMode = navigatorMode(mode)
  const panelOpen = useShell((s) => !s.panelCollapsed[panelMode])
  const filesShown = useShell((s) => s.filesShown)
  const covered = collapsible && panelMode !== mode
  const showing = filesShown && !covered && (panelOpen || !collapsible)
  const toggle = () => {
    const shell = useShell.getState()
    if (showing) return shell.setFilesShown(false)
    shell.setPanelOpen(panelMode, true)
    shell.setFilesShown(true)
    if (covered) void openMode('chat')
  }
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label="Files"
            aria-pressed={showing}
            onClick={toggle}
            className={`${railButton} h-12 aria-pressed:text-ink`}
          />
        }
      >
        <RailMark.Files className="size-5" />
      </TooltipTrigger>
      <TooltipContent side="right">
        {showing ? 'Hide files' : 'Show files'}
      </TooltipContent>
    </Tooltip>
  )
}

/**
 * The rail's destinations in the order the person dragged them into. Modes the
 * saved order does not name, such as one added since, follow in their default
 * order.
 */
export function orderModes(order: readonly ShellMode[]) {
  const rank = (mode: ShellMode) => {
    const saved = order.indexOf(mode)
    return saved < 0
      ? order.length + MODES.findIndex((entry) => entry.mode === mode)
      : saved
  }
  return [...MODES].sort((a, b) => rank(a.mode) - rank(b.mode))
}

/** What a screen reader hears while a destination is dragged. */
const announcements: Announcements = {
  onDragStart: ({ active }) =>
    `Picked up ${modeLabel(active.id as ShellMode)}.`,
  onDragOver: ({ active, over }) =>
    over && active.id !== over.id
      ? `${modeLabel(active.id as ShellMode)} is over ${modeLabel(over.id as ShellMode)}.`
      : undefined,
  onDragEnd: ({ active, over }) =>
    over && active.id !== over.id
      ? `${modeLabel(active.id as ShellMode)} moved to ${modeLabel(over.id as ShellMode)}'s place.`
      : `${modeLabel(active.id as ShellMode)} stayed in place.`,
  onDragCancel: ({ active }) =>
    `${modeLabel(active.id as ShellMode)} stayed in place.`,
}

/**
 * One destination, which drags to a new place on the rail. The press still
 * opens it: a drag starts only after the pointer travels, and the click that
 * ends a drag is dropped by the rail.
 */
function Destination({
  mode,
  register,
  onMove,
  className,
  children,
  ...button
}: Omit<ComponentProps<'button'>, 'onKeyDown'> & {
  mode: ShellMode
  register: (mode: ShellMode, node: HTMLButtonElement | null) => void
  onMove: (mode: ShellMode, by: -1 | 1) => void
  children: ReactNode
}) {
  const {
    setNodeRef,
    attributes,
    listeners,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: mode })
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!event.altKey) return
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
    event.preventDefault()
    onMove(mode, event.key === 'ArrowUp' ? -1 : 1)
  }
  return (
    <button
      {...button}
      {...attributes}
      {...listeners}
      ref={(node) => {
        setNodeRef(node)
        register(mode, node)
      }}
      type="button"
      onKeyDown={onKeyDown}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={`${className} touch-none ${isDragging ? 'z-10 cursor-grabbing' : ''}`}
    >
      {children}
    </button>
  )
}

/**
 * The global rail: one destination per mode, and Kit, the terminal and the
 * account at the foot. Destinations drag into the order the person wants, and
 * keep their colours as they move.
 * It is the base the sheet sits on, and stacks above the sheet's shadow and
 * glow so the junction's tab stays level with the panel it joins. The first
 * destination is level with the sheet's top edge, so no rail shows above it;
 * while it is the active one its tab runs straight on into that edge. On the
 * desktop the active destination also shows and hides its mode's panel.
 */
export function Rail({ collapsible = false }: { collapsible?: boolean }) {
  const mode = useShellMode()
  const openMode = useOpenMode()
  const panelOpen = useShell((s) => !s.panelCollapsed[mode])
  const togglePanel = useShell((s) => s.togglePanel)
  const railOrder = useShell((s) => s.railOrder)
  const setRailOrder = useShell((s) => s.setRailOrder)
  // The Vault works on opened folders, so it is offered where they can be.
  const folders = useWorkspaces().available
  const ordered = orderModes(railOrder)
  const modes = ordered.filter(
    (entry) => folders || !('folders' in entry) || entry.mode === mode,
  )
  const order = modes.map((entry) => entry.mode).join()

  const railRef = useRef<HTMLDivElement>(null)
  const destinations = useRef(new Map<ShellMode, HTMLButtonElement>())
  const register = (value: ShellMode, node: HTMLButtonElement | null) => {
    if (node) destinations.current.set(value, node)
    else destinations.current.delete(value)
  }
  const [junction, setJunction] = useState<Omit<Junction, 'joins'>>()
  // On the desktop the Vault lays the sheet over the panel, so the tab joins the sheet there.
  const covered = collapsible && navigatorMode(mode) !== mode
  const joins = !collapsible || (panelOpen && !covered) ? 'navigation' : 'sheet'
  useLayoutEffect(() => {
    const rail = railRef.current
    const active = destinations.current.get(mode)
    if (!rail || !active) return
    const box = rail.getBoundingClientRect()
    const { top, height } = active.getBoundingClientRect()
    const y = top - box.top
    const flush = modes[0]?.mode === mode
    // Level with the top, the tab starts where the sheet does, which can sit
    // a little above the first destination, so the sheet's corner never shows
    // above the tab.
    const sheet = rail.closest('.appearance-shell')?.querySelector('.sheet')
    const lead =
      flush && sheet ? sheet.getBoundingClientRect().top - box.top : y
    // How far down the rail the tab sits, for the glow colour it takes.
    setJunction({
      y,
      lead: Math.min(lead, y),
      h: height,
      t: box.height ? y / box.height : 0,
      flush,
    })
    // `order` stands for `modes`, whose identity changes every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, order])

  /** Puts `moved` where `target` is, among every mode, hidden ones included. */
  const place = (moved: ShellMode, target: ShellMode) => {
    const all = ordered.map((entry) => entry.mode)
    const from = all.indexOf(moved)
    const to = all.indexOf(target)
    if (from !== to) setRailOrder(arrayMove(all, from, to))
  }
  // A drag is announced by dnd-kit; a keyboard move is said here.
  const { announce, announcement } = useAnnouncement()
  const move = (moved: ShellMode, by: -1 | 1) => {
    const shown = modes.map((entry) => entry.mode)
    const at = shown.indexOf(moved) + by
    const target = shown[at]
    if (!target) {
      announce(`${modeLabel(moved)} is already ${by < 0 ? 'first' : 'last'}.`)
      return
    }
    place(moved, target)
    announce(
      `${modeLabel(moved)} moved to position ${at + 1} of ${shown.length}.`,
    )
  }

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  )
  // The release that ends a drag also clicks the destination under it.
  const dragged = useRef(false)
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    setTimeout(() => (dragged.current = false))
    if (over) place(active.id as ShellMode, over.id as ShellMode)
  }

  return (
    <div
      ref={railRef}
      data-appearance-part="rail"
      className="relative z-10 flex h-full w-rail shrink-0 flex-col items-center pt-(--sheet-inset) pb-3"
    >
      {junction && <Junction {...junction} joins={joins} />}
      <LiveRegion id="rail-modes-moved" announcement={announcement} />
      <TooltipProvider>
        <DndContext
          id="rail-modes"
          sensors={sensors}
          modifiers={[restrictToVerticalAxis, restrictToParentElement]}
          accessibility={{
            announcements,
            screenReaderInstructions: {
              draggable:
                'Drag to reorder, or press Alt with the up or down arrow to move this destination.',
            },
          }}
          onDragStart={() => (dragged.current = true)}
          onDragEnd={onDragEnd}
          onDragCancel={() => setTimeout(() => (dragged.current = false))}
        >
          <SortableContext
            items={modes.map((entry) => entry.mode)}
            strategy={verticalListSortingStrategy}
          >
            <nav aria-label="Modes" className="flex flex-col gap-1">
              {modes.map(({ mode: value, label, Mark }) => {
                const active = value === mode
                const toggles = active && collapsible
                const tooltip = toggles
                  ? `${panelOpen ? 'Hide' : 'Show'} ${label} panel`
                  : label
                return (
                  <Tooltip key={value}>
                    <TooltipTrigger
                      render={
                        <Destination
                          data-appearance-radius-role="control"
                          mode={value}
                          register={register}
                          onMove={move}
                          aria-label={label}
                          aria-current={active ? 'page' : undefined}
                          aria-expanded={toggles ? panelOpen : undefined}
                          onClick={() => {
                            if (dragged.current) return
                            if (!active) void openMode(value)
                            else if (collapsible) togglePanel(value)
                          }}
                          className={`${railButton} h-12 aria-[current=page]:text-ink aria-[current=page]:hover:bg-transparent`}
                        >
                          <Mark className="size-5" />
                        </Destination>
                      }
                    />
                    <TooltipContent side="right">{tooltip}</TooltipContent>
                  </Tooltip>
                )
              })}
            </nav>
          </SortableContext>
        </DndContext>
        <div aria-hidden="true" className="my-2 h-px w-5 bg-separator" />
        <FilesControl collapsible={collapsible} />
      </TooltipProvider>
      <div className="flex-1" />
      <KitPerch name="rail" className="mb-1" />
      <TerminalToggle />
      <ThemeToggle />
      <AccountMenu />
    </div>
  )
}
