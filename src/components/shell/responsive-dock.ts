// SOURCING: Dockview's serialized grid, minimum-width constraints, public
// group and panel moves, and always-rendered panels. The 35rem reading-space
// policy is theorem-appearance-v1.
import type { DockviewApi, DockviewGroupPanel, Position } from 'dockview-react'
import { THREAD } from './arrangements'

type Layout = ReturnType<DockviewApi['toJSON']>
type GridNode = Layout['grid']['root']
type GroupState = Exclude<GridNode['data'], GridNode[]>
type Anchor = { groupId: string; position: Exclude<Position, 'center'> }
/** A column whose panels wait as tabs in the conversation's group for room to come back. */
type Stacked = {
  id: string
  panelIds: Array<string>
  activeView: string | undefined
  width: number
  heightFraction: number
  minimumWidth: number
  anchors: Array<Anchor>
}

const DIRECTION = {
  top: 'above',
  bottom: 'below',
  left: 'left',
  right: 'right',
} as const

function groupIds(node: GridNode): string[] {
  return Array.isArray(node.data) ? node.data.flatMap(groupIds) : [node.data.id]
}

/** The closest sibling records the split a group belonged to when it left. */
function anchorsOf(grid: Layout['grid'], groupId: string): Anchor[] {
  const visit = (node: GridNode, horizontal: boolean): Anchor[] => {
    if (!Array.isArray(node.data)) return []
    const children = node.data
    const index = children.findIndex((child) =>
      groupIds(child).includes(groupId),
    )
    if (index < 0) return []
    const previous = children.slice(0, index).reverse().flatMap(groupIds)
    const next = children.slice(index + 1).flatMap(groupIds)
    return [
      ...visit(children[index]!, !horizontal),
      ...previous.map((id): Anchor => ({
        groupId: id,
        position: horizontal ? 'right' : 'bottom',
      })),
      ...next.map((id): Anchor => ({
        groupId: id,
        position: horizontal ? 'left' : 'top',
      })),
    ]
  }
  return visit(grid.root, grid.orientation === 'HORIZONTAL')
}

function groupsOf(node: GridNode): GroupState[] {
  return Array.isArray(node.data) ? node.data.flatMap(groupsOf) : [node.data]
}

/**
 * The layout as it would be with every stacked column back in place: the
 * grid saved before the first column stacked, each group's live state, the
 * stacked panels in their own columns again, and the groups added since.
 */
function preferredLayout(
  current: Layout,
  preferred: Layout,
  threadGroupId: string,
  stacked: ReadonlyArray<Stacked>,
): Layout {
  const groups = new Map(
    groupsOf(current.grid.root).map((group) => [group.id, group]),
  )
  const thread = groups.get(threadGroupId)
  if (thread) {
    const waiting = new Set(stacked.flatMap(({ panelIds }) => panelIds))
    groups.set(thread.id, {
      ...thread,
      views: thread.views.filter((id) => !waiting.has(id)),
      activeView:
        thread.activeView && waiting.has(thread.activeView)
          ? THREAD
          : thread.activeView,
    })
    for (const { id, panelIds, activeView } of stacked) {
      const views = panelIds.filter((view) => thread.views.includes(view))
      if (views.length)
        groups.set(id, {
          id,
          views,
          activeView:
            activeView && views.includes(activeView) ? activeView : views[0],
        })
    }
  }
  const included = new Set<string>()
  const project = (node: GridNode, root = false): GridNode | undefined => {
    if (!Array.isArray(node.data)) {
      const data = groups.get(node.data.id)
      if (!data) return undefined
      included.add(data.id)
      return { ...node, data }
    }
    const data = node.data.flatMap((child) => project(child) ?? [])
    return root || data.length ? { ...node, data } : undefined
  }
  const root = project(preferred.grid.root, true)!
  if (!Array.isArray(root.data)) return current
  // Keep the splits of new docked groups from the live grid.
  const appendNew = (node: GridNode): GridNode | undefined => {
    if (!Array.isArray(node.data)) {
      if (included.has(node.data.id)) return undefined
      included.add(node.data.id)
      return node
    }
    const data = node.data.flatMap((child) => appendNew(child) ?? [])
    return data.length ? { ...node, data } : undefined
  }
  const additions = appendNew(current.grid.root)
  if (additions && Array.isArray(additions.data))
    root.data.push(...additions.data)
  // A column opened while the dock was narrow stacked before it had a place.
  for (const data of groups.values())
    if (!included.has(data.id))
      root.data.push({ type: 'leaf', data, size: 300 })
  return { ...current, grid: { ...preferred.grid, root } }
}

/**
 * Keeps the conversation at least 35rem wide, and never covers it. While a
 * column stands beside the conversation, the conversation holds that width
 * as its minimum, so the column gives up width first, down to its own
 * minimum. A dock too narrow even for that moves the column's panels into
 * the conversation's group as tabs, and gives them their column back when
 * the dock has room again. Panels move, never remount: they render always,
 * so their state and drafts come along.
 */
export function adaptDock(api: DockviewApi, host: HTMLElement) {
  const stacked: Array<Stacked> = []
  /** Each column's width while the conversation had room to spare. */
  const widths = new WeakMap<DockviewGroupPanel, number>()
  /** The layout as it was the last time every column fit. */
  let fitted: Layout | undefined
  let preferred: Layout | undefined
  let scheduled = 0
  let settleFrame = 0
  let changing = false
  const update = () => {
    scheduled = 0
    const thread = api.getPanel(THREAD)
    if (
      !thread ||
      thread.api.location.type !== 'grid' ||
      api.hasMaximizedGroup() ||
      changing
    )
      return
    changing = true
    try {
      const minimum =
        35 * parseFloat(getComputedStyle(document.documentElement).fontSize)
      const docked = () =>
        api.groups.filter(
          (group) =>
            group !== thread.group && group.api.location.type === 'grid',
        )
      const hold = () => {
        const wanted = docked().length ? minimum : 0
        if (thread.group.minimumWidth !== wanted)
          thread.group.api.setConstraints({ minimumWidth: wanted })
      }
      // A panel closed, or moved away, while it waited stays where it is.
      for (const record of [...stacked]) {
        record.panelIds = record.panelIds.filter(
          (id) => api.getPanel(id)?.group === thread.group,
        )
        if (!record.panelIds.length) stacked.splice(stacked.indexOf(record), 1)
      }
      // Columns come back while the dock has room for them at their
      // minimum, the last to stack first, so each split rebuilds around a
      // sibling already in the grid.
      for (const record of [...stacked].reverse()) {
        const grid = new Map(docked().map((group) => [group.id, group]))
        grid.set(thread.group.id, thread.group)
        const anchor = record.anchors.find(({ groupId }) => grid.has(groupId))
        const reference = anchor ? grid.get(anchor.groupId)! : thread.group
        const position = anchor?.position ?? 'right'
        const vertical = position === 'top' || position === 'bottom'
        const column =
          reference === thread.group ? minimum : reference.minimumWidth
        const added = vertical
          ? Math.max(0, record.minimumWidth - column)
          : record.minimumWidth
        const reading = Math.max(0, minimum - thread.group.minimumWidth)
        if (api.minimumWidth + reading + added > api.width) continue
        const group = api.addGroup({
          id: record.id,
          referenceGroup: reference,
          direction: DIRECTION[position],
        })
        record.panelIds.forEach((id, index) =>
          api.getPanel(id)!.api.moveTo({ group, index, skipSetActive: true }),
        )
        const active = record.activeView && api.getPanel(record.activeView)
        if (active && active.group === group)
          group.model.openPanel(active, { skipSetGroupActive: true })
        hold()
        group.api.setSize({
          width: record.width,
          height: vertical
            ? Math.round(record.heightFraction * api.height)
            : undefined,
        })
        stacked.splice(stacked.indexOf(record), 1)
      }
      hold()
      if (!stacked.length && api.minimumWidth <= api.width)
        fitted = api.toJSON()
      // A dock too narrow for the conversation's reading width and a
      // column's minimum takes the column into the conversation's group.
      for (const group of docked()) {
        if (api.minimumWidth <= api.width) break
        const snapshot = api.toJSON()
        preferred ??= fitted ?? snapshot
        stacked.push({
          id: group.id,
          panelIds: group.panels.map((panel) => panel.id),
          activeView: group.activePanel?.id,
          width: widths.get(group) ?? group.api.width,
          heightFraction: group.api.height / api.height || 0.5,
          minimumWidth: group.minimumWidth,
          anchors: anchorsOf(snapshot.grid, group.id),
        })
        // The column's tab comes to the front only if it was the one in use.
        const front = thread.group.activePanel
        const inUse = group.panels.some((panel) => panel === api.activePanel)
        group.api.moveTo({
          group: thread.group,
          position: 'center',
          skipSetActive: true,
        })
        if (front && !inUse)
          thread.group.model.openPanel(front, { skipSetGroupActive: true })
        hold()
      }
      if (!stacked.length) preferred = undefined
      if (thread.api.width > minimum)
        for (const group of docked()) widths.set(group, group.api.width)
      for (const group of api.groups) {
        if (group !== thread.group) {
          group.element.dataset.appearanceWidthRole = 'inspector'
          group.element.dataset.appearancePart = 'inspector'
        }
      }
      // Always-rendered Dockview panels use positioned overlays. Refresh their
      // boxes after the split DOM has reached its new dimensions.
      cancelAnimationFrame(settleFrame)
      settleFrame = requestAnimationFrame(() => {
        changing = true
        try {
          api.layout(
            host.clientWidth || api.width,
            host.clientHeight || api.height,
            true,
          )
        } finally {
          changing = false
        }
      })
    } finally {
      changing = false
    }
  }
  const schedule = () => {
    if (!scheduled && !changing) scheduled = requestAnimationFrame(update)
  }
  const listener = api.onDidLayoutChange(schedule)
  // The group's, not the panel's: a panel behind another tab is not laid out.
  const dimensions = api
    .getPanel(THREAD)
    ?.group.api.onDidDimensionsChange(schedule)
  const observer = new ResizeObserver(schedule)
  observer.observe(host)
  observer.observe(document.documentElement)
  schedule()
  return {
    layoutForSave: () => {
      if (changing) return undefined
      const current = api.toJSON()
      const thread = api.getPanel(THREAD)
      return preferred && stacked.length && thread
        ? preferredLayout(current, preferred, thread.group.id, stacked)
        : current
    },
    dispose: () => {
      cancelAnimationFrame(scheduled)
      cancelAnimationFrame(settleFrame)
      listener.dispose()
      dimensions?.dispose()
      observer.disconnect()
    },
  }
}
