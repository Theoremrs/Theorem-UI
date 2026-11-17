// SOURCING: TanStack Query (the project's outputs), Base UI's media query
// hook, and the cabinet's own catalog, preview and contract modules. Moved out
// of cabinet-view.tsx unchanged so the mounted cabinet and the workbench's
// Artifacts panel run one controller: it owns the catalog, the filters, the
// search and the preview preference, and sends the Rust cabinet its view.
import { useMediaQuery } from '@base-ui/react/unstable-use-media-query'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useShell } from '@/components/shell/shell-state'
import { useAppearance } from '@/lib/appearance'
import { describeError } from '@/lib/theorem/client'
import { useCabinetOutputs } from '@/lib/theorem/organization'
import type { OutputCategory, ProjectOutput } from '@/lib/theorem/organization'
import { openReview } from '@/lib/theorem/reviews'
import { metaLine, toEntry, plainText } from './catalog'
import { byRecent, effectivePreviewMode } from './contract'
import type { CatalogEntry, PreviewMode } from './contract'
import { presentationKey, requestPreviews, usePreviews } from './previews'
import type { Geometry } from './cabinet-overlay'

export const FILTERS: ReadonlyArray<{
  id: 'all' | OutputCategory
  label: string
}> = [
  { id: 'all', label: 'All' },
  { id: 'document', label: 'Docs' },
  { id: 'image', label: 'Images' },
  { id: 'app', label: 'Apps' },
]

export type CabinetAction =
  | { type: 'select'; key: string }
  | { type: 'open'; key: string; revision: string }

/**
 * What the controller needs of the Rust cabinet: the mounted cabinet's handle
 * (`CabinetHandle`) has these, and so does the workbench's link to its
 * Artifacts panel.
 */
export interface CabinetSurface {
  set_view: (json: string) => void
  key: (event: KeyboardEvent) => boolean
  select: (key: string) => void
  scroll: (rows: number) => void
}

/** What a restored layout already holds of the controller's own state. */
export interface CabinetInitial {
  filter?: string
  query?: string
}

/** The catalog, filters, search and preview preference for one project. */
export function useCabinetController({
  projectId,
  projectTitle,
  expanded,
  surface,
  geometry,
  initial,
}: {
  projectId: string
  projectTitle: string
  expanded: boolean
  surface: CabinetSurface | undefined
  geometry: Geometry | undefined
  initial?: CabinetInitial
}) {
  const [filter, setFilter] = useState<'all' | OutputCategory>(
    () => FILTERS.find((f) => f.id === initial?.filter)?.id ?? 'all',
  )
  const [query, setQuery] = useState(initial?.query ?? '')
  const [search, setSearch] = useState((initial?.query ?? '').trim())
  const [opened, setOpened] = useState<CatalogEntry>()
  const focusAfter = useRef<string | undefined>(undefined)
  const buttons = useRef(new Map<string, HTMLButtonElement>())
  const preset = useAppearance((s) => s.preset)
  const preference = useAppearance((s) => s.overrides.preview)
  const mode: PreviewMode = effectivePreviewMode(preset, preference)

  // The authority searches; typing waits for a pause before asking.
  useEffect(() => {
    const t = setTimeout(() => setSearch(query.trim()), 200)
    return () => clearTimeout(t)
  }, [query])

  const outputs = useCabinetOutputs(projectId, {
    q: search || undefined,
    category: filter === 'all' ? undefined : filter,
  })
  const pages = outputs.data?.pages
  const { entries, byKey, items } = useMemo(() => {
    const seen = new Map<string, ProjectOutput>()
    for (const page of pages ?? [])
      for (const item of page.items)
        if (!seen.has(item.outputId)) seen.set(item.outputId, item)
    const cards = [...seen.values()]
      .map((item) => toEntry(projectId, item))
      .sort(byRecent)
    return {
      entries: cards,
      items: seen,
      byKey: new Map(cards.map((e) => [e.key, e])),
    }
  }, [pages, projectId])
  const total = pages?.[0]?.total

  // Every open goes through here: a review opens where reviews are read,
  // anything else in the original view at the card's revision.
  const open = (entry: CatalogEntry) => {
    if (entry.source.type === 'review') {
      // The review pane lives in the workspace an expanded cabinet covers:
      // restore the dock first so the review can be seen and used.
      useShell.getState().setCabinetExpanded(false)
      openReview(entry.source.reviewId)
    } else setOpened(entry)
  }

  const actions = useRef<(a: CabinetAction) => void>(() => {})
  useLayoutEffect(() => {
    actions.current = (action) => {
      if (action.type === 'select') focusAfter.current = action.key
      else {
        const entry = byKey.get(action.key)
        // The revision the card showed, not whatever is newest now.
        if (entry && entry.source.revision === action.revision) open(entry)
      }
    }
  })

  const preferenceLabel =
    preference === undefined
      ? 'Default'
      : preference === 'pixel'
        ? 'Pixel'
        : 'Original'
  // §11: an unreachable catalog is unavailable, never empty; a failed
  // refresh keeps the last loaded collection and says it may be stale.
  const status = outputs.error
    ? entries.length
      ? `Showing the last loaded collection; refreshing failed: ${describeError(outputs.error)}`
      : `The collection is unavailable, not empty: ${describeError(outputs.error)}`
    : outputs.isPending
      ? 'Loading the collection…'
      : outputs.isFetchingNextPage
        ? 'Loading more…'
        : ''

  const coarse = useMediaQuery('(pointer: coarse)', { noSsr: true })
  const target = coarse ? 44 : 24
  useEffect(() => {
    if (!surface) return
    surface.set_view(
      JSON.stringify({
        title: 'Gallery',
        scope: `${projectTitle} · every session · newest first`,
        count:
          outputs.error && !entries.length
            ? 'unavailable'
            : total === undefined
              ? `${entries.length} loaded`
              : `${String(total).padStart(2, '0')} objects`,
        preferenceLabel,
        filters: FILTERS,
        filter,
        query,
        expanded,
        status,
        targetPx: target,
        footerNote:
          mode === 'pixel'
            ? 'Pixel representations. Open one for the original.'
            : 'Reduced thumbnails. Open one for the original.',
        entries: entries.map((entry) => {
          const state =
            usePreviews.getState().states[presentationKey(entry, mode)]
          return {
            key: entry.key,
            revision: entry.source.revision,
            title: entry.title,
            meta: metaLine(items.get(entry.key)!, entry),
            description: plainText(entry.description.text),
            state: state?.status ?? 'loading',
          }
        }),
      }),
    )
  })

  // Preview states change the card's drawn state line.
  usePreviews((s) => s.states)

  // Visible cards ask for their previews; reaching the end asks for more.
  useEffect(() => {
    if (!geometry) return
    const visible = geometry.slots
      .map((s) => byKey.get(s.key))
      .filter((e): e is CatalogEntry => e !== undefined)
    requestPreviews(visible, mode)
    const last = Math.max(-1, ...geometry.slots.map((s) => s.index))
    if (
      outputs.hasNextPage &&
      !outputs.isFetchingNextPage &&
      last >= entries.length - geometry.columns * 2
    )
      void outputs.fetchNextPage()
  }, [geometry, byKey, mode, entries.length, outputs])

  // Arrow keys move the selection; focus follows it to the new card.
  useEffect(() => {
    const key = focusAfter.current
    if (!key) return
    const button = buttons.current.get(key)
    if (button) {
      focusAfter.current = undefined
      button.focus({ preventScroll: true })
    }
  }, [geometry])

  return {
    filter,
    setFilter,
    query,
    setQuery,
    opened,
    setOpened,
    open,
    actions,
    buttons,
    preset,
    preference,
    mode,
    target,
    byKey,
    items,
    total,
    status,
  }
}

export type CabinetController = ReturnType<typeof useCabinetController>
