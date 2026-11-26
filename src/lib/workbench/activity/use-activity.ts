// SOURCING: @tanstack/react-query through lib/theorem/organization (useOrganization: every thread's running state) and React's useSyncExternalStore over the workspace's lent owners (./sources). The inventory and arrangement rules are ./inventory and ./arrangement.
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { useOrganization } from '@/lib/theorem/organization'
import { useActivityView } from './arrangement'
import { buildInventory } from './inventory'
import type { Completeness, SideChatRow, TerminalRow } from './inventory'
import { activitySource, activitySources } from './sources'
import type { ActivitySource } from './sources'
import type { ActivitySource as EntrySource } from './projection'

/** How often an open view asks the workspace's owners again. Observational: nothing is attached or resized. */
export const LIST_INTERVAL_MS = 4_000

/**
 * The work the activity view shows for a project: the owners' listings, arranged in their stable
 * order. Terminals and side chats are listed only while the view is open, and only from a workspace
 * that is mounted for this project.
 */
export function useActivity(projectId: string) {
  const open = useActivityView((s) => s.open)
  const scope = useActivityView((s) => s.scope)
  const arranged = useActivityView((s) => s.arranged)
  const sync = useActivityView((s) => s.sync)
  const { data: organization, dataUpdatedAt } = useOrganization()
  useSyncExternalStore(
    activitySources.subscribe,
    activitySources.version,
    activitySources.version,
  )
  const source = activitySource(projectId)
  // What the lent owners last listed, kept with the source it came from: a closed view, or another
  // project's source, reads as unlisted without resetting state in the effect.
  const [listing, setListing] = useState<{
    source: ActivitySource
    terminals?: TerminalRow[]
    sideChats?: SideChatRow[]
    at: number
  }>()

  useEffect(() => {
    if (!open || !source) return
    let live = true
    // Reads can overlap when the host is slow; only the newest one started may land, so a late
    // reply never rolls the listing back.
    let started = 0
    let landed = 0
    const read = async () => {
      const mine = ++started
      const sideChats = source.sideChats?.()
      let terminals: TerminalRow[] | undefined
      try {
        terminals = await source.terminals?.()
      } catch {
        // A failed listing leaves terminals unlisted, which the inventory names as a gap.
        terminals = undefined
      }
      if (!live || mine < landed) return
      landed = mine
      setListing({ source, terminals, sideChats, at: Date.now() })
    }
    void read()
    const timer = setInterval(() => void read(), LIST_INTERVAL_MS)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [open, source])

  const current = open && listing?.source === source ? listing : undefined
  const terminals = current?.terminals
  const sideChats = current?.sideChats
  const at = current?.at ?? dataUpdatedAt

  const inventory = useMemo(
    () =>
      buildInventory({
        ...(organization ? { organization } : {}),
        ...(terminals ? { terminals } : {}),
        ...(sideChats ? { sideChats } : {}),
        at,
      }),
    [organization, terminals, sideChats, at],
  )

  // The owners this read heard from: only they can say their work left.
  const read = useMemo(() => {
    const sources = new Set<EntrySource>()
    if (organization) sources.add('thread')
    if (terminals) sources.add('terminal')
    if (sideChats) sources.add('sideChat')
    return sources
  }, [organization, terminals, sideChats])

  useEffect(() => {
    sync(inventory.entries, projectId, read)
  }, [inventory, projectId, scope, sync, read])

  const completeness: Completeness = useMemo(() => {
    const gaps = [...inventory.completeness.gaps]
    if (!source)
      gaps.push(
        'The workspace is not open here, so its terminals and side chats are not listed.',
      )
    gaps.push('Delegated specialist runs are not listed in this view yet.')
    return { complete: false, gaps }
  }, [inventory, source])

  return {
    arranged:
      arranged?.projectId === projectId && arranged.scope === scope
        ? arranged
        : undefined,
    completeness,
    projects: organization?.projects ?? [],
    source,
  }
}
