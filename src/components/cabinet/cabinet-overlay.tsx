// SOURCING: canvas 2D paints previews on the rectangles the terminal crate's
// cabinet allocates; real buttons, an input and a select sit over the drawn
// controls so the gallery is operable and named. Moved out of cabinet-view.tsx
// so the mounted cabinet and the workbench's Artifacts panel lay the same
// canvases and controls over whatever geometry the Rust cabinet reports.
import { useRef, useLayoutEffect } from 'react'
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  TouchEvent as ReactTouchEvent,
  WheelEvent as ReactWheelEvent,
} from 'react'
import { useTerminalTheme } from '@/components/terminal/live-terminal-theme'
import { useAppearance } from '@/lib/appearance'
import { metaLine } from './catalog'
import { effectivePreviewMode } from './contract'
import { presentationKey, previewNote, usePreviews } from './previews'
import type { PreviewState } from './previews'
import { OriginalView } from './original-view'
import { FILTERS } from './use-cabinet-controller'
import type {
  CabinetController,
  CabinetSurface,
} from './use-cabinet-controller'

export type Area = { x: number; y: number; w: number; h: number }
export type Slot = {
  key: string
  revision: string
  index: number
  preview: Area
  card: Area
  selected: boolean
}
export type Geometry = {
  cell: [number, number]
  columns: number
  clip: Area
  slots: Slot[]
  controls: Array<{ id: string; area: Area }>
  selected: string | null
}

/** The cell size before the Rust cabinet has reported one. */
export const cellOf = (geometry: Geometry | undefined): [number, number] =>
  geometry?.cell ?? [8, 16]

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

/**
 * The wheel and a vertical swipe scroll the drawn gallery a row at a time.
 * Spread the result on the element the gestures happen over.
 */
export function useScrollGestures(
  surface: CabinetSurface | undefined,
  rowPx: number,
) {
  const touchY = useRef<number | undefined>(undefined)
  return {
    onWheel: (event: ReactWheelEvent) =>
      surface?.scroll(Math.sign(event.deltaY) * 3),
    onTouchStart: (event: ReactTouchEvent) => {
      touchY.current = event.touches[0]?.clientY
    },
    onTouchMove: (event: ReactTouchEvent) => {
      const y = event.touches[0]?.clientY
      if (y === undefined || touchY.current === undefined || !surface) return
      const rows = Math.trunc((touchY.current - y) / rowPx)
      if (rows) {
        surface.scroll(rows)
        touchY.current -= rows * rowPx
      }
    },
    onTouchEnd: () => (touchY.current = undefined),
  }
}

/**
 * The real controls and pictures over what the Rust cabinet drew: search,
 * the preview style, the filters, one canvas and one button per visible card,
 * the live count and the original view. Positioned in `geometry`'s cells from
 * the top left of the element it is rendered into.
 */
export function CabinetOverlay({
  controller,
  geometry,
  surface,
}: {
  controller: CabinetController
  geometry: Geometry | undefined
  surface: CabinetSurface | undefined
}) {
  const cell = cellOf(geometry)
  const {
    filter,
    setFilter,
    query,
    setQuery,
    opened,
    setOpened,
    open,
    buttons,
    preset,
    preference,
    mode,
    target,
    byKey,
    items,
    total,
    status,
  } = controller
  const states = usePreviews((s) => s.states)

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
      surface?.key(event.nativeEvent)
    )
      event.preventDefault()
  }

  const control = (id: string) =>
    geometry?.controls.find((c) => c.id === id)?.area
  // One card is in the Tab order: the selected one while it is mounted,
  // otherwise the first visible card, so scrolling never empties the order.
  const mounted = geometry?.slots ?? []
  const tabStop =
    mounted.find((s) => s.selected)?.key ??
    [...mounted].sort((a, b) => a.index - b.index)[0]?.key
  const searchArea = control('search')
  const prefArea = control('preference')

  return (
    <>
      {searchArea && (
        <input
          type="search"
          aria-label="Search the gallery"
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
                    onFocus={() => surface?.select(slot.key)}
                    onKeyDown={onCardKey}
                    onClick={() => {
                      surface?.select(slot.key)
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
    </>
  )
}
