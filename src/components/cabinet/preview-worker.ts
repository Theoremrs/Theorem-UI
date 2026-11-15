// SOURCING: the terminal crate's render_preview (terminal/src/preview, built
// into src/terminal-wasm by terminal/build.sh), createImageBitmap and
// OffscreenCanvas for decoding in a dedicated worker. No network, no
// credentials: the page hands over an already authorized, bounded source.
import init, { render_preview } from '@/terminal-wasm/theorem_terminal'

/** The source image is reduced to at most this edge before conversion. */
const DECODE_EDGE = 512

export type PreviewRequest = {
  id: number
  source: object
  image?: Blob
}

export type PreviewResponse =
  | { id: number; ok: true; meta: PreviewMeta; indices: Uint8Array }
  | { id: number; ok: false; code: string; detail: string }

export type PreviewMeta = {
  rendererVersion: number
  recipe: string
  recipeVersion: number
  method: 'source_raster' | 'structured_recipe' | 'type_illustration'
  width: number
  height: number
  paletteId: string
  paletteVersion: number
  resultDigest: string
  limitation: { code: string; detail: string } | null
}

const ready = init()

async function pixels(blob: Blob) {
  const bitmap = await createImageBitmap(blob)
  const scale = Math.min(1, DECODE_EDGE / Math.max(bitmap.width, bitmap.height))
  const w = Math.max(1, Math.round(bitmap.width * scale))
  const h = Math.max(1, Math.round(bitmap.height * scale))
  const canvas = new OffscreenCanvas(w, h)
  const ctx = canvas.getContext('2d')!
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(bitmap, 0, 0, w, h)
  bitmap.close()
  return {
    rgba: new Uint8Array(ctx.getImageData(0, 0, w, h).data.buffer),
    w,
    h,
  }
}

self.onmessage = async (event: MessageEvent<PreviewRequest>) => {
  const { id, source, image } = event.data
  try {
    await ready
    const decoded = image ? await pixels(image) : undefined
    const out = render_preview(
      JSON.stringify(source),
      decoded?.rgba ?? new Uint8Array(),
      decoded?.w ?? 0,
      decoded?.h ?? 0,
    ) as { meta: string; indices: Uint8Array }
    const response: PreviewResponse = {
      id,
      ok: true,
      meta: JSON.parse(out.meta) as PreviewMeta,
      indices: out.indices,
    }
    ;(self as unknown as Worker).postMessage(response, [out.indices.buffer])
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error)
    const [code = 'failed', ...rest] = text.split(': ')
    ;(self as unknown as Worker).postMessage({
      id,
      ok: false,
      code: rest.length ? code : 'failed',
      detail: rest.length ? rest.join(': ') : text,
    } satisfies PreviewResponse)
  }
}
