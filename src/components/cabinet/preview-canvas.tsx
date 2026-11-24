// SOURCING: canvas 2D over a gallery preview's state (cabinet/previews), in the
// terminal's illustration roles (terminal/live-terminal-theme). Kept apart from
// cabinet-overlay so a surface that only paints a preview, such as a chat
// attachment's card, does not bring in the gallery's routes and shell.
import { useLayoutEffect, useRef } from 'react'
import { useTerminalTheme } from '@/components/terminal/live-terminal-theme'
import type { PreviewState } from './previews'

/**
 * A preview painted on its rectangle. Pixel art is drawn at the largest whole
 * device-pixel scale that fits, centred on a black matte, never smoothed.
 */
export function PreviewCanvas({
  state,
  width,
  height,
  bare = false,
}: {
  state: PreviewState | undefined
  width: number
  height: number
  /** Leaves the matte (index 0) clear, so the drawing stands on its surface. */
  bare?: boolean
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
    // No 2D context (a canvas-less test page) leaves the box empty.
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    if (!bare) {
      ctx.fillStyle = roles.chrome.deep
      ctx.fillRect(0, 0, W, H)
    }
    if (state.mode === 'pixel') {
      const { width: w, height: h } = state.meta
      // Whole pixels where the drawing fits; a drawing wider than the box
      // (a small card at 1x) shrinks to fit rather than being cut off.
      const fit = Math.min(W / w, H / h)
      const scale = fit >= 1 ? Math.floor(fit) : fit
      const art = new ImageData(w, h)
      const rgb = roles.illustration.map((c) => [
        parseInt(c.slice(1, 3), 16),
        parseInt(c.slice(3, 5), 16),
        parseInt(c.slice(5, 7), 16),
      ])
      state.indices.forEach((ix, i) => {
        const [r, g, b] = rgb[ix] ?? [0, 0, 0]
        art.data.set([r!, g!, b!, bare && !ix ? 0 : 255], i * 4)
      })
      const tile = new OffscreenCanvas(w, h)
      tile.getContext('2d')!.putImageData(art, 0, 0)
      ctx.imageSmoothingEnabled = false
      ctx.drawImage(
        tile,
        Math.floor((W - w * scale) / 2),
        Math.floor((H - h * scale) / 2),
        Math.round(w * scale),
        Math.round(h * scale),
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
  }, [state, width, height, bare, roles])
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
