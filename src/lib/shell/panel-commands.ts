// SOURCING: dockview-core's public DockviewApi (addPanel, getPanel, groups,
// moveTo, addFloatingGroup, removePanel), lib/commands/registry (the one
// command registry and its key bindings) and zod 4 (argument schemas), over
// the panel contributions. Every panel action here has a non-drag path
// (HOST-01 / EXT-04); panel identity is the panel's id, apart from the
// resource it shows, so one resource can have several deliberate views.
import type { DockviewApi, IDockviewPanel } from 'dockview-react'
import { z } from 'zod'
import { create } from 'zustand'
import { registerCommands } from '@/lib/commands/registry'
import type { CommandDefinition } from '@/lib/commands/registry'
import { hostContributionsOf } from './host-registry'

/**
 * Surfaces with one active driver. A second placement offers to focus or move
 * the existing one rather than start a competing runtime (HOST-01).
 */
export const SINGLE_DRIVER_COMPONENTS: ReadonlyArray<string> = [
  'thread',
  'ide',
  'terminal',
]

/** The Dockview components panel contributions name, and which are single-driver. */
export function panelComponents() {
  const found = new Map<string, { singleDriver: boolean; label: string }>()
  for (const one of hostContributionsOf('panel')) {
    const component = one.meta?.component
    if (typeof component !== 'string') continue
    found.set(component, {
      singleDriver:
        one.meta?.singleDriver === true ||
        SINGLE_DRIVER_COMPONENTS.includes(component),
      label: one.label,
    })
  }
  return found
}

export const isSingleDriver = (component: string) =>
  panelComponents().get(component)?.singleDriver ??
  SINGLE_DRIVER_COMPONENTS.includes(component)

/** An open request that landed on a single-driver surface already placed. */
export interface PanelOffer {
  panelId: string
  component: string
  label: string
  /** The panel that was in front when the open was asked for. */
  from?: string
}

interface OfferStore {
  offer: PanelOffer | undefined
  dismiss: () => void
}
export const usePanelOffer = create<OfferStore>()((set) => ({
  offer: undefined,
  dismiss: () => set({ offer: undefined }),
}))

const POSITIONS = ['left', 'right', 'above', 'below', 'tab', 'float'] as const
export type MovePosition = (typeof POSITIONS)[number]

const open = z.object({
  component: z.string().min(1),
  /** The panel's own id; defaults to the component, or a numbered one for a duplicate. */
  id: z.string().min(1).optional(),
  title: z.string().optional(),
  /** Resource identity and run ids the panel shows; kept outside the layout blob. */
  params: z.record(z.string(), z.unknown()).optional(),
  /** A second deliberate view of the same resource, in a panel of its own. */
  duplicate: z.boolean().optional(),
})
const target = z.object({ id: z.string().min(1).optional() })
const move = z.object({
  id: z.string().min(1).optional(),
  to: z.enum(POSITIONS).optional(),
  /** The panel it moves beside or into; defaults to the next group. */
  reference: z.string().min(1).optional(),
})

export type PanelResult =
  | { status: 'opened'; panelId: string }
  | { status: 'exists'; panelId: string; offered: boolean }
  | { status: 'unknown-component'; component: string }
  | { status: 'moved' | 'focused' | 'closed'; panelId: string }
  | { status: 'none'; message: string }

/** A free panel id for another view of the same thing: `base`, `base~2`, … */
export function nextPanelId(api: Pick<DockviewApi, 'getPanel'>, base: string) {
  if (!api.getPanel(base)) return base
  for (let n = 2; ; n++)
    if (!api.getPanel(`${base}~${n}`)) return `${base}~${n}`
}

/** Panels in reading order: group by group, tab by tab. */
export const panelsInOrder = (api: Pick<DockviewApi, 'groups'>) =>
  api.groups.flatMap((group) => [...group.panels])

export function openPanel(
  api: DockviewApi,
  args: z.infer<typeof open>,
): PanelResult {
  const known = panelComponents()
  if (!known.has(args.component))
    return { status: 'unknown-component', component: args.component }
  // One driver: focus the one that exists and offer to move it here.
  if (known.get(args.component)!.singleDriver) {
    const existing = api.panels.find(
      (panel) => panel.view.contentComponent === args.component,
    )
    if (existing) {
      const from = api.activePanel?.id
      existing.api.setActive()
      usePanelOffer.setState({
        offer: {
          ...(from && { from }),
          panelId: existing.id,
          component: args.component,
          label: known.get(args.component)!.label,
        },
      })
      return { status: 'exists', panelId: existing.id, offered: true }
    }
  }
  const base = args.id ?? args.component
  const held = api.getPanel(base)
  if (held && !args.duplicate) {
    held.api.setActive()
    return { status: 'exists', panelId: base, offered: false }
  }
  const id = args.duplicate ? nextPanelId(api, base) : base
  api.addPanel({
    id,
    component: args.component,
    title: args.title ?? known.get(args.component)!.label,
    ...(args.params && { params: args.params }),
  })
  return { status: 'opened', panelId: id }
}

const panelOf = (api: DockviewApi, id: string | undefined) =>
  id ? api.getPanel(id) : api.activePanel

export function focusPanel(api: DockviewApi, id: string): PanelResult {
  const panel = api.getPanel(id)
  if (!panel) return { status: 'none', message: `no panel ${id}` }
  panel.api.setActive()
  return { status: 'focused', panelId: id }
}

/** Focuses the panel `step` places from the active one, wrapping. */
export function cyclePanel(api: DockviewApi, step: 1 | -1): PanelResult {
  const panels = panelsInOrder(api)
  if (!panels.length) return { status: 'none', message: 'no panels are open' }
  const at = panels.findIndex((panel) => panel.id === api.activePanel?.id)
  const next = panels[(at + step + panels.length) % panels.length]!
  next.api.setActive()
  return { status: 'focused', panelId: next.id }
}

export function closePanel(api: DockviewApi, id?: string): PanelResult {
  const panel = panelOf(api, id)
  if (!panel) return { status: 'none', message: 'no panel to close' }
  // The conversation is always present; closing it is not offered.
  if (panel.view.contentComponent === 'thread')
    return { status: 'none', message: 'the conversation stays open' }
  api.removePanel(panel)
  return { status: 'closed', panelId: panel.id }
}

const DIRECTION = {
  left: 'left',
  right: 'right',
  above: 'top',
  below: 'bottom',
} as const

/** The group after the panel's own, for a move that names no place. */
function nextGroup(api: DockviewApi, panel: IDockviewPanel) {
  const groups = api.groups
  const at = groups.findIndex((group) => group.id === panel.group.id)
  const other = groups[(at + 1) % groups.length]
  return other && other.id !== panel.group.id ? other : undefined
}

export function movePanel(
  api: DockviewApi,
  args: z.infer<typeof move>,
): PanelResult {
  const panel = panelOf(api, args.id)
  if (!panel) return { status: 'none', message: 'no panel to move' }
  const to = args.to ?? 'tab'
  if (to === 'float') {
    api.addFloatingGroup(panel, { width: 480, height: 560 })
    return { status: 'moved', panelId: panel.id }
  }
  const reference = args.reference ? api.getPanel(args.reference) : undefined
  if (args.reference && !reference)
    return { status: 'none', message: `no panel ${args.reference}` }
  const group = reference?.group ?? nextGroup(api, panel)
  if (!group || group.id === panel.group.id) {
    // Alone in the only group: a direction splits, a tab move has nowhere to go.
    if (to === 'tab')
      return { status: 'none', message: 'there is no other group to move into' }
    return { status: 'none', message: 'name a panel to move beside' }
  }
  if (to === 'tab') panel.api.moveTo({ group })
  else panel.api.moveTo({ group, position: DIRECTION[to] })
  panel.api.setActive()
  return { status: 'moved', panelId: panel.id }
}

/**
 * Registers theorem.panel.* while a dock is mounted. `getApi` is read when a
 * command runs, so the commands follow the dock that is on screen.
 */
export function registerPanelCommands(getApi: () => DockviewApi | undefined) {
  const mounted = () => getApi() !== undefined
  const act =
    <T>(run: (api: DockviewApi, args: T) => PanelResult) =>
    (args: T): PanelResult => {
      const api = getApi()
      return api ? run(api, args) : { status: 'none', message: 'no dock' }
    }
  const common = {
    group: 'Panels',
    effect: 'presentation',
    target: 'host',
    when: mounted,
  } as const
  const definitions: CommandDefinition<any>[] = [
    {
      ...common,
      id: 'theorem.panel.open',
      label: 'Open panel',
      description:
        'Opens a panel; a single-driver surface already open is focused instead.',
      args: open,
      palette: false,
      run: act<z.infer<typeof open>>(openPanel),
    },
    {
      ...common,
      id: 'theorem.panel.move',
      label: 'Move panel to the next group',
      description:
        'Moves the active panel into the next group, or beside a named panel.',
      keywords: ['dock', 'split', 'tab', 'float'],
      args: move.optional(),
      keys: ['alt+shift+m'],
      run: act<z.infer<typeof move> | undefined>((api, args) =>
        movePanel(api, args ?? {}),
      ),
    },
    {
      ...common,
      id: 'theorem.panel.close',
      label: 'Close panel',
      args: target.optional(),
      keys: ['alt+shift+w'],
      run: act<z.infer<typeof target> | undefined>((api, args) =>
        closePanel(api, args?.id),
      ),
    },
    {
      ...common,
      id: 'theorem.panel.focus',
      label: 'Focus panel',
      args: z.object({ id: z.string().min(1) }),
      palette: false,
      run: act<{ id: string }>((api, args) => focusPanel(api, args.id)),
    },
    {
      ...common,
      id: 'theorem.panel.next',
      label: 'Next panel',
      keys: ['alt+shift+arrowright'],
      run: act<undefined>((api) => cyclePanel(api, 1)),
    },
    {
      ...common,
      id: 'theorem.panel.previous',
      label: 'Previous panel',
      keys: ['alt+shift+arrowleft'],
      run: act<undefined>((api) => cyclePanel(api, -1)),
    },
  ]
  return registerCommands(definitions)
}
