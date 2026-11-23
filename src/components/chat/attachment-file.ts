// SOURCING: lib/theorem/attachment-kinds for what a file is; the gallery's preview pipeline (cabinet/previews pixelPreview over the terminal crate's render_preview, with cabinet/catalog's PreviewSource and TEXT_LIMIT), pdfjs-dist through react-pdf's pdfjs (loaded with the first PDF) for a PDF's words, and the platform's HTMLVideoElement and canvas for a video's frame. What the renderer reads from each file.
import { useEffect, useState } from 'react'
import { TEXT_LIMIT } from '@/components/cabinet/catalog'
import type { PreviewSource } from '@/components/cabinet/catalog'
import { pixelPreview } from '@/components/cabinet/previews'
import type { PreviewState } from '@/components/cabinet/previews'
import {
  DOCX,
  extension,
  fileKind,
  formatLabel,
  uploadType,
} from '@/lib/theorem/attachment-kinds'
import { count, lineCount } from './pasted-text'

export function byteSize(n: number): string {
  if (n < 1024) return count(n, 'byte')
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

/**
 * The card's fact line: format, then lines for words or bytes otherwise.
 * `size` is the whole file's, where `file` is only its beginning.
 */
export function factLine(
  name: string,
  type: string,
  file: Blob | undefined,
  text: string | undefined,
  size: number | undefined = file?.size,
): string {
  const parts = [formatLabel(name, type)]
  if (text !== undefined) parts.push(count(lineCount(text), 'line'))
  else if (size !== undefined) parts.push(byteSize(size))
  return parts.join(' · ')
}

/** The words of a PDF's first pages, as far as the renderer reads. */
async function pdfText(file: Blob): Promise<string> {
  // Loaded with the first PDF, so the composer does not carry pdf.js.
  const { pdfjs } = await import('react-pdf')
  // pdf.js ships a relative default the bundler does not serve; this is the
  // same worker the PDF viewer (handlers/pdf) points at.
  pdfjs.GlobalWorkerOptions.workerSrc = new URL(
    'pdfjs-dist/build/pdf.worker.min.mjs',
    import.meta.url,
  ).toString()
  const task = pdfjs.getDocument({
    data: new Uint8Array(await file.arrayBuffer()),
  })
  let text = ''
  try {
    // Inside the try, so a file pdf.js cannot open still has its task torn down.
    const doc = await task.promise
    for (let n = 1; n <= Math.min(doc.numPages, 3); n++) {
      const content = await (await doc.getPage(n)).getTextContent()
      for (const item of content.items)
        if ('str' in item) text += item.str + (item.hasEOL ? '\n' : '')
      text += '\n\n'
      if (text.length >= TEXT_LIMIT) break
    }
  } finally {
    void task.destroy()
  }
  return text.slice(0, TEXT_LIMIT)
}

/** How long a video's still waits for the video to seek. */
const SEEK_WAIT_MS = 5_000

/** A still from a video, a tenth of the way in, as an image the renderer reads. */
async function videoFrame(file: Blob): Promise<Blob> {
  const url = URL.createObjectURL(file)
  const video = document.createElement('video')
  try {
    video.muted = true
    video.playsInline = true
    video.preload = 'auto'
    video.src = url
    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve()
      video.onerror = () => reject(new Error('unsupported: video'))
    })
    await new Promise<void>((resolve, reject) => {
      // A video with nothing seekable may never say it has seeked; give up
      // after a while so the video and its address are let go.
      const timer = setTimeout(
        () => reject(new Error('failed: seek')),
        SEEK_WAIT_MS,
      )
      video.onseeked = () => {
        clearTimeout(timer)
        resolve()
      }
      video.onerror = () => {
        clearTimeout(timer)
        reject(new Error('unsupported: video'))
      }
      video.currentTime = Math.min(1, (video.duration || 0) / 10)
    })
    const canvas = document.createElement('canvas')
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    canvas.getContext('2d')!.drawImage(video, 0, 0)
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('failed: frame'))),
        'image/png',
      ),
    )
  } finally {
    video.removeAttribute('src')
    video.load()
    URL.revokeObjectURL(url)
  }
}

/** What the renderer reads from a file, or nothing when it has no picture. */
export async function previewSource(
  file: Blob,
  name: string,
  type: string,
): Promise<PreviewSource | undefined> {
  const kind = fileKind(name, type)
  const words = () => file.slice(0, TEXT_LIMIT).text()
  switch (kind) {
    case 'text':
    case 'markdown':
    case 'html':
      return {
        source: {
          kind: 'document',
          mediaType: uploadType(name, type),
          text: await words(),
        },
      }
    case 'table':
      return {
        source: { kind: 'table', mediaType: 'text/csv', text: await words() },
      }
    case 'code':
      return {
        source: {
          kind: 'code',
          mediaType: uploadType(name, type),
          language: extension(name),
          text: await words(),
        },
      }
    case 'pdf':
      return {
        source: {
          kind: 'document',
          mediaType: 'application/pdf',
          text: await pdfText(file).catch(() => undefined),
        },
      }
    case 'docx':
      return { source: { kind: 'document', mediaType: DOCX } }
    case 'image':
      return { source: { kind: 'image', mediaType: type }, image: file }
    case 'video':
      return {
        source: { kind: 'image', mediaType: 'image/png' },
        image: await videoFrame(file),
      }
    default:
      return undefined
  }
}

/**
 * The renderer draws on a fixed landscape board; the card is a page standing
 * up, so the empty matte (index 0) around the drawing is cut away.
 */
export function cropToDrawing(state: PreviewState): PreviewState {
  if (state.status !== 'ready' || state.mode !== 'pixel') return state
  const { width: w, height: h } = state.meta
  let [x0, y0, x1, y1] = [w, h, -1, -1]
  state.indices.forEach((ix, i) => {
    if (!ix) return
    const x = i % w
    const y = Math.floor(i / w)
    x0 = Math.min(x0, x)
    y0 = Math.min(y0, y)
    x1 = Math.max(x1, x)
    y1 = Math.max(y1, y)
  })
  if (x1 < 0) return state
  const pad = 2
  x0 = Math.max(0, x0 - pad)
  y0 = Math.max(0, y0 - pad)
  x1 = Math.min(w - 1, x1 + pad)
  y1 = Math.min(h - 1, y1 + pad)
  const cw = x1 - x0 + 1
  const ch = y1 - y0 + 1
  const indices = new Uint8Array(cw * ch)
  for (let y = 0; y < ch; y++)
    indices.set(
      state.indices.subarray((y0 + y) * w + x0, (y0 + y) * w + x0 + cw),
      y * cw,
    )
  return { ...state, meta: { ...state.meta, width: cw, height: ch }, indices }
}

const made = new WeakMap<Blob, Promise<PreviewState | undefined>>()

/** A file's picture as the gallery draws it, once per file. */
function pictureOf(file: Blob, name: string, type: string) {
  let picture = made.get(file)
  if (!picture) {
    picture = previewSource(file, name, type)
      .then((source) => source && pixelPreview(source))
      .then((state) => state && cropToDrawing(state))
      .catch(() => undefined)
    made.set(file, picture)
  }
  return picture
}

/**
 * The picture of a file, once drawn. Undefined while it is drawn and when
 * there is none (audio, an unreadable file); the card shows its mark then.
 */
export function useFilePicture(
  file: Blob | undefined,
  name: string,
  type: string,
): PreviewState | undefined {
  const [drawn, setDrawn] = useState<{ file: Blob; state?: PreviewState }>()
  useEffect(() => {
    if (!file) return
    let live = true
    void pictureOf(file, name, type).then((state) => {
      if (live) setDrawn({ file, state })
    })
    return () => {
      live = false
    }
  }, [file, name, type])
  if (!file || !drawn || drawn.file !== file) return undefined
  return drawn.state?.status === 'ready' ? drawn.state : undefined
}
