// SOURCING: the terminal crate's mount_cabinet (Ratatui on Ratzilla) draws
// the cabinet and allocates its rectangles inside the right-hand host
// (terminal/side-terminal); canvas 2D paints previews on those rectangles;
// real buttons, an input and a select sit over the drawn controls so the
// gallery is operable and named; ui/dialog (Base UI Dialog) shows an
// original; components/artifacts' ArtifactView renders an artifact revision.
//
// The artifact cabinet's browser host (SPEC-THEOREM-ARTIFACT-CABINET-1.0 §8):
// React owns the catalog and the preference, Ratatui owns layout, selection
// and scroll, and this host lays inert pictures and semantic controls exactly
// over what Ratatui drew. It replaces the outputs drawer: one collection
// browser.
import { useMediaQuery } from '@base-ui/react/unstable-use-media-query'
import { useParams } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { TheoremArtifact } from '@/components/artifacts/artifact-model'
import { OpenLatestContext } from '@/components/artifacts/app-history'
import { ArtifactView } from '@/components/artifacts/artifact-renderers'
import { useShell } from '@/components/shell/shell-state'
import { useTerminalTheme } from '@/components/terminal/live-terminal-theme'
import { loadWasm } from '@/components/terminal/terminal-screen'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog'
import { useAppearance } from '@/lib/appearance'
import { describeError } from '@/lib/theorem/client'
import { useCabinetOutputs, useOrganization } from '@/lib/theorem/organization'
import type { OutputCategory, ProjectOutput } from '@/lib/theorem/organization'
import { readUpload, uploadContentPath } from '@/lib/theorem/uploads'
import type { CabinetHandle } from '@/terminal-wasm/theorem_terminal'
import {
  metaLine,
  readArtifactRevision,
  readLatestArtifact,
  toEntry,
} from './catalog'
import { byRecent, effectivePreviewMode } from './contract'
import type { CatalogEntry, PreviewMode } from './contract'
import { openReview } from '@/lib/theorem/reviews'
import {
  presentationKey,
  previewNote,
  requestPreviews,
  usePreviews,
} from './previews'
import type { PreviewState } from './previews'

const HOST_ID = 'theorem-artifact-cabinet'

const FILTERS: ReadonlyArray<{ id: 'all' | OutputCategory; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'document', label: 'Docs' },
  { id: 'image', label: 'Images' },
  { id: 'app', label: 'Apps' },
]

type Area = { x: number; y: number; w: number; h: number }
type Slot = {
  key: string
  revision: string
  index: number
  preview: Area
  card: Area
  selected: boolean
}
type Geometry = {
  cell: [number, number]
  columns: number
  clip: Area
  slots: Slot[]
  controls: Array<{ id: string; area: Area }>
  selected: string | null
}
type CabinetAction =
  | { type: 'select'; key: string }
  | { type: 'open'; key: string; revision: string }

/** One cabinet mount per host element; frames stop when it leaves the page. */
const mounts = new WeakMap<HTMLElement, Promise<CabinetHandle | undefined>>()

/** An object URL for `blob` that lives exactly as long as its user. */
function useObjectUrl(blob: Blob | undefined) {
  const [url, setUrl] = useState<string>()
  // The URL is an external resource whose life is this effect's: it is made
  // and revoked here, so state follows it rather than render creating it
  // (which StrictMode's re-run would revoke under the image).
  useEffect(() => {
    const u = blob && URL.createObjectURL(blob)
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setUrl(u)
    return () => {
      if (u) URL.revokeObjectURL(u)
    }
  }, [blob])
  return url
}

const px = (a: Area, [cw, ch]: [number, number]): CSSProperties => ({
  left: a.x * cw,
  top: a.y * ch,
  width: a.w * cw,
  height: a.h * ch,
})

/**
 * A control's hit box: its drawn cells, grown evenly around them to the touch
 * target minimum (§9: 24 CSS px, 44 px for coarse pointers), so a one-row
 * control stays easy to hit without moving what the terminal drew.
 */
const hit = (a: Area, cell: [number, number], min: number): CSSProperties => {
  const box = px(a, cell)
  const w = a.w * cell[0]
  const h = a.h * cell[1]
  return {
    left: w < min ? a.x * cell[0] - (min - w) / 2 : box.left,
    top: h < min ? a.y * cell[1] - (min - h) / 2 : box.top,
    width: Math.max(w, min),
    height: Math.max(h, min),
  }
}

/**
 * A preview painted on its rectangle. Pixel art is drawn at the largest whole
 * device-pixel scale that fits, centred on a black matte, never smoothed.
 */
function PreviewCanvas({
  state,
  width,
  height,
}: {
  state: PreviewState | undefined
  width: number
  height: number
}) {
  const ref = useRef<HTMLCanvasElement>(null)
  // Pᵗ = T(P⁰): the indices stay; the colours follow the terminal's roles.
  const roles = useTerminalTheme((s) => s.roles)
  useLayoutEffect(() => {
    const canvas = ref.current
    if (!canvas || state?.status !== 'ready') return
    const dpr = window.devicePixelRatio || 1
    const W = Math.max(1, Math.round(width * dpr))
    const H = Math.max(1, Math.round(height * dpr))
    canvas.width = W
    canvas.height = H
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = roles.chrome.deep
    ctx.fillRect(0, 0, W, H)
    if (state.mode === 'pixel') {
      const { width: w, height: h } = state.meta
      const scale = Math.max(1, Math.floor(Math.min(W / w, H / h)))
      const art = new ImageData(w, h)
      const rgb = roles.illustration.map((c) => [
        parseInt(c.slice(1, 3), 16),
        parseInt(c.slice(3, 5), 16),
        parseInt(c.slice(5, 7), 16),
      ])
      state.indices.forEach((ix, i) => {
        const [r, g, b] = rgb[ix] ?? [0, 0, 0]
        art.data.set([r!, g!, b!, 255], i * 4)
      })
      const tile = new OffscreenCanvas(w, h)
      tile.getContext('2d')!.putImageData(art, 0, 0)
      ctx.imageSmoothingEnabled = false
      ctx.drawImage(
        tile,
        Math.floor((W - w * scale) / 2),
        Math.floor((H - h * scale) / 2),
        w * scale,
        h * scale,
      )
    } else if ('image' in state) {
      const { image } = state
      const s = Math.min(W / image.width, H / image.height)
      const dw = image.width * s
      const dh = image.height * s
      ctx.imageSmoothingQuality = 'high'
      ctx.drawImage(image, (W - dw) / 2, (H - dh) / 2, dw, dh)
    } else {
      // The source's own words, at a size that fits the box.
      ctx.fillStyle = '#fffcf0'
      ctx.fillRect(0, 0, W, H)
      const size = Math.max(7, Math.round(7 * dpr))
      ctx.font = `${size}px ui-monospace, monospace`
      ctx.fillStyle = '#100f0f'
      const lines = state.text.split('\n')
      const pad = Math.round(6 * dpr)
      for (let i = 0; i < lines.length; i++) {
        const y = pad + (i + 1) * size * 1.25
        if (y > H - pad) break
        ctx.fillText(lines[i]!.slice(0, 200), pad, y, W - pad * 2)
      }
    }
  }, [state, width, height, roles])
  if (state?.status !== 'ready') return null
  return (
    <canvas
      data-palette-revision={roles.revision}
      ref={ref}
      aria-hidden="true"
      className="block size-full [image-rendering:pixelated]"
    />
  )
}

/** Opening reveals the original: the exact revision the card stands for. */
function OriginalView({
  entry,
  onClose,
}: {
  entry: CatalogEntry | undefined
  onClose: () => void
}) {
  // "Open latest" inside a saved App revision switches this view to the
  // newest revision its session holds; a new card starts at its own revision.
  const [latest, setLatest] = useState<string>()
  const showLatest = latest !== undefined && latest === entry?.key
  const original = useQuery({
    queryKey: [
      'cabinet',
      'original',
      entry?.key,
      showLatest ? 'latest' : entry?.source.revision,
    ] as const,
    enabled: entry !== undefined,
    staleTime: Infinity,
    queryFn: async (): Promise<
      | { type: 'artifact'; artifact: TheoremArtifact }
      | { type: 'image'; blob: Blob }
      | { type: 'text'; text: string; markdown: boolean }
      | { type: 'file'; blob: Blob }
    > => {
      const e = entry!
      if (e.source.type === 'artifact') {
        const artifact = showLatest
          ? await readLatestArtifact(e.threadId, e.source.artifactId)
          : await readArtifactRevision(
              e.threadId,
              e.source.artifactId,
              e.source.revision,
            )
        if (!artifact)
          throw new Error('That revision is no longer in its session.')
        return { type: 'artifact', artifact }
      }
      if (e.source.type === 'review')
        throw new Error('A review opens in its own pane.')
      const blob = await readUpload(uploadContentPath(e.source.uploadId))
      const media = e.mediaType || blob.type
      if (media.startsWith('image/')) return { type: 'image', blob }
      if (media.startsWith('text/') || /json|markdown|xml/.test(media))
        return {
          type: 'text',
          text: await blob.text(),
          markdown: /markdown/.test(media),
        }
      return { type: 'file', blob }
    },
  })
  const data = original.data
  // The dialog owns the blob's URL and releases it when it stops showing it.
  const url = useObjectUrl(
    data?.type === 'image' || data?.type === 'file' ? data.blob : undefined,
  )
  return (
    <Dialog
      open={entry !== undefined}
      onOpenChange={(o) => {
        if (o) return
        // Each opening starts at the revision its card shows.
        setLatest(undefined)
        onClose()
      }}
    >
      <DialogContent
        data-cabinet-original=""
        className="flex max-h-[88vh] w-[min(960px,94vw)] max-w-none flex-col gap-3 overflow-hidden"
      >
        <DialogTitle>{entry?.title}</DialogTitle>
        <DialogDescription>
          {entry &&
            (showLatest && data?.type === 'artifact'
              ? `Latest revision ${String(data.artifact.revision).slice(0, 12)} · the card shows ${entry.source.revision.slice(0, 12)}`
              : `Revision ${entry.source.revision.slice(0, 12)} · opened from the artifact cabinet`)}
        </DialogDescription>
        <div className="min-h-0 flex-1 overflow-auto">
          {original.error ? (
            <p className="text-sm text-error-ink">
              {describeError(original.error)}
            </p>
          ) : !data ? (
            <p className="text-sm text-ink-muted">Opening…</p>
          ) : data.type === 'artifact' ? (
            <OpenLatestContext.Provider
              value={showLatest ? undefined : () => setLatest(entry?.key)}
            >
              <ArtifactView
                artifact={data.artifact}
                distance="interactive"
                latest={showLatest}
              />
            </OpenLatestContext.Provider>
          ) : data.type === 'image' ? (
            <img
              src={url}
              alt={entry?.title ?? ''}
              className="mx-auto max-h-[70vh] object-contain"
            />
          ) : data.type === 'text' ? (
            data.markdown && entry ? (
              <ArtifactView
                artifact={markdownArtifact(entry, data.text)}
                distance="interactive"
                latest={false}
              />
            ) : (
              <pre className="text-xs whitespace-pre-wrap">{data.text}</pre>
            )
          ) : (
            <a href={url} download={entry?.title} className="underline">
              Download {entry?.title}
            </a>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** An uploaded Markdown file, shown through the document renderer. */
function markdownArtifact(entry: CatalogEntry, text: string): TheoremArtifact {
  return {
    partId: entry.key,
    artifactId: entry.key,
    revision: entry.source.revision,
    kind: 'document',
    rendererId: 'theorem.document',
    contractVersion: 'theorem-artifact-v1',
    lifecycle: 'ready',
    patchSequence: 0,
    title: entry.title,
    content: text,
    language: 'markdown',
    fallbackText: entry.title,
    payloadRef: undefined,
    runId: undefined,
    sourceTool: undefined,
    notebook: undefined,
  }
}

/** The cabinet for one project: catalog, Ratatui view, previews, controls. */
export function Cabinet({
  projectId,
  projectTitle,
  expanded = false,
}: {
  projectId: string
  projectTitle: string
  expanded?: boolean
}) {
  const host = useRef<HTMLDivElement>(null)
  const [handle, setHandle] = useState<CabinetHandle>()
  const [geometry, setGeometry] = useState<Geometry>()
  const [filter, setFilter] = useState<'all' | OutputCategory>('all')
  const [query, setQuery] = useState('')
  const [search, setSearch] = useState('')
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

  useEffect(() => {
    const element = host.current
    if (!element) return
    let live = true
    let mount = mounts.get(element)
    if (!mount) {
      mount = loadWasm().then((wasm) => {
        // The project may have changed while the module loaded: a host that
        // left the page must not mount into its successor's element.
        if (
          !element.isConnected ||
          document.getElementById(HOST_ID) !== element
        )
          return undefined
        return wasm.mount_cabinet(
          HOST_ID,
          (json: string) => actions.current(JSON.parse(json) as CabinetAction),
          (json: string) =>
            setGeometry((JSON.parse(json) as { geometry: Geometry }).geometry),
        )
      })
      mounts.set(element, mount)
    }
    void mount.then((h) => live && setHandle(h))
    return () => {
      live = false
    }
  }, [])

  const modeLabel =
    mode === 'pixel' ? 'pixel interpretations' : 'original thumbnails'
  const preferenceLabel =
    preference === undefined
      ? 'Theme default'
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

  useEffect(() => {
    if (!handle) return
    handle.set_view(
      JSON.stringify({
        title: 'Artifact cabinet',
        scope: `${projectTitle} · every session`,
        count:
          outputs.error && !entries.length
            ? 'unavailable'
            : total === undefined
              ? `${entries.length} loaded`
              : `${String(total).padStart(2, '0')} objects`,
        modeLabel,
        preferenceLabel,
        filters: FILTERS,
        filter,
        query,
        expanded,
        status,
        footerNote:
          mode === 'pixel'
            ? 'Pixel previews are representations. Opening reveals the original.'
            : 'Thumbnails are reduced originals. Opening reveals the original.',
        entries: entries.map((entry) => {
          const state =
            usePreviews.getState().states[presentationKey(entry, mode)]
          return {
            key: entry.key,
            revision: entry.source.revision,
            title: entry.title,
            meta: metaLine(items.get(entry.key)!, entry),
            description: entry.description.text,
            state: state?.status ?? 'loading',
          }
        }),
      }),
    )
  })

  // Preview states change the card's drawn state line.
  const states = usePreviews((s) => s.states)

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

  const onCardKey = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (
      [
        'ArrowUp',
        'ArrowDown',
        'ArrowLeft',
        'ArrowRight',
        'Home',
        'End',
        'PageUp',
        'PageDown',
      ].includes(event.key) &&
      handle?.key(event.nativeEvent)
    )
      event.preventDefault()
  }

  const control = (id: string) =>
    geometry?.controls.find((c) => c.id === id)?.area
  const cell = geometry?.cell ?? [8, 16]
  // One card is in the Tab order: the selected one while it is mounted,
  // otherwise the first visible card, so scrolling never empties the order.
  const mounted = geometry?.slots ?? []
  const tabStop =
    mounted.find((s) => s.selected)?.key ??
    [...mounted].sort((a, b) => a.index - b.index)[0]?.key

  // A vertical swipe scrolls the drawn gallery a row at a time.
  const touchY = useRef<number | undefined>(undefined)
  const onTouchStart = (event: React.TouchEvent) => {
    touchY.current = event.touches[0]?.clientY
  }
  const onTouchMove = (event: React.TouchEvent) => {
    const y = event.touches[0]?.clientY
    if (y === undefined || touchY.current === undefined || !handle) return
    const rows = Math.trunc((touchY.current - y) / cell[1])
    if (rows) {
      handle.scroll(rows)
      touchY.current -= rows * cell[1]
    }
  }

  // Ratzilla measures its cell only on a window resize, so a change of text
  // size (browser setting, 200% zoom of text) is passed on as one (§9).
  const probe = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    const element = probe.current
    if (!element) return
    let last = ''
    const observer = new ResizeObserver(() => {
      const size = `${element.offsetWidth}x${element.offsetHeight}`
      if (last && size !== last) window.dispatchEvent(new Event('resize'))
      last = size
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  const coarse = useMediaQuery('(pointer: coarse)', { noSsr: true })
  const target = coarse ? 44 : 24
  const searchArea = control('search')
  const prefArea = control('preference')

  return (
    <div
      data-artifact-cabinet=""
      className="relative min-h-0 flex-1 overflow-hidden bg-term font-mono text-[0.78125rem] text-term-ink"
      onWheel={(event) => handle?.scroll(Math.sign(event.deltaY) * 3)}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={() => (touchY.current = undefined)}
      style={{ touchAction: 'pinch-zoom' }}
    >
      <span
        ref={probe}
        aria-hidden="true"
        className="pointer-events-none invisible absolute h-[1em] w-[1ch]"
      />
      <div
        id={HOST_ID}
        ref={host}
        aria-hidden="true"
        className="absolute inset-0 whitespace-pre"
      />
      {searchArea && (
        <input
          type="search"
          aria-label="Search the artifact cabinet"
          placeholder="Search artifacts"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setQuery('')
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              if (tabStop) buttons.current.get(tabStop)?.focus()
            }
          }}
          data-cabinet-search=""
          style={hit(searchArea, cell, target)}
          className="absolute bg-transparent p-0 text-term-ink outline-none placeholder:text-term-muted"
        />
      )}
      {prefArea && (
        <select
          aria-label="Preview style"
          value={preference ?? 'theme'}
          onChange={(e) => {
            const v = e.target.value
            useAppearance.getState().setOverrides({
              preview:
                v === 'theme' ? undefined : (v as 'pixel' | 'full_fidelity'),
            })
          }}
          style={hit(prefArea, cell, target)}
          className="absolute cursor-pointer opacity-0"
        >
          <option value="theme">
            Theme default (
            {effectivePreviewMode(preset, undefined) === 'pixel'
              ? 'pixel'
              : 'original'}
            )
          </option>
          <option value="pixel">Pixel</option>
          <option value="full_fidelity">Original</option>
        </select>
      )}
      <div role="group" aria-label="Filter artifacts">
        {FILTERS.map((f) => {
          const area = control(`filter:${f.id}`)
          return (
            area && (
              <button
                key={f.id}
                type="button"
                aria-pressed={filter === f.id}
                onClick={() => setFilter(f.id)}
                style={hit(area, cell, target)}
                className="absolute cursor-pointer opacity-0 focus-visible:opacity-100 focus-visible:outline-1 focus-visible:outline-term-sage"
              >
                {f.label}
              </button>
            )
          )
        })}
      </div>
      {geometry && (
        <div
          className="absolute overflow-hidden"
          style={px(geometry.clip, cell)}
        >
          <ul
            aria-label="Artifacts, most recent first"
            className="relative size-full"
            style={{
              left: -geometry.clip.x * cell[0],
              top: -geometry.clip.y * cell[1],
            }}
          >
            {geometry.slots.map((slot) => {
              const entry = byKey.get(slot.key)
              if (!entry || entry.source.revision !== slot.revision) return null
              const state = states[presentationKey(entry, mode)]
              return (
                <li key={slot.key}>
                  <div
                    className="pointer-events-none absolute"
                    style={px(slot.preview, cell)}
                  >
                    <PreviewCanvas
                      state={state}
                      width={slot.preview.w * cell[0]}
                      height={slot.preview.h * cell[1]}
                    />
                  </div>
                  <button
                    type="button"
                    ref={(el) => {
                      if (el) buttons.current.set(slot.key, el)
                      else buttons.current.delete(slot.key)
                    }}
                    data-cabinet-card={slot.key}
                    data-revision={slot.revision}
                    aria-current={slot.selected || undefined}
                    tabIndex={slot.key === tabStop ? 0 : -1}
                    aria-label={`${entry.title}. ${metaLine(items.get(entry.key)!, entry)}. ${entry.description.text}`}
                    aria-description={previewNote(state)}
                    onFocus={() => handle?.select(slot.key)}
                    onKeyDown={onCardKey}
                    onClick={() => {
                      handle?.select(slot.key)
                      open(entry)
                    }}
                    style={px(slot.card, cell)}
                    className="absolute cursor-pointer rounded-none bg-transparent outline-none focus-visible:outline-1 focus-visible:outline-offset-0 focus-visible:outline-term-sage"
                  />
                </li>
              )
            })}
          </ul>
        </div>
      )}
      <p className="sr-only" aria-live="polite">
        {total !== undefined && `${total} artifacts`}
        {status && `. ${status}`}
      </p>
      <OriginalView
        entry={opened}
        onClose={() => {
          const key = opened?.key
          setOpened(undefined)
          if (key)
            requestAnimationFrame(() => buttons.current.get(key)?.focus())
        }}
      />
    </div>
  )
}

/**
 * The cabinet view of the right-hand host: the open project's outputs from
 * every session. In a chat it shows the chat's project; outside any project
 * it says so.
 */
export function CabinetView({ expanded = false }: { expanded?: boolean }) {
  const activeProject = useShell((s) => s.projectId)
  const { projectId: routeProject } = useParams({ strict: false })
  const { data: organization } = useOrganization()
  const projectId = routeProject ?? activeProject
  const project = organization?.projects.find((p) => p.projectId === projectId)
  return projectId ? (
    <Cabinet
      key={projectId}
      projectId={projectId}
      projectTitle={project?.title ?? 'This project'}
      expanded={expanded}
    />
  ) : (
    <p className="p-5 font-mono text-[0.78125rem] text-term-muted">
      Open a project to browse what its sessions made.
    </p>
  )
}
