// SOURCING: zustand for the per-card preview states the host paints; a
// dedicated Web Worker (preview-worker) for decoding and conversion;
// createImageBitmap for full-fidelity thumbnails on the page. Identity and
// publish rules are contract.ts's (§10).
//
// The preview scheduler: what each visible card shows, fetched and converted
// at most a few at a time, cached by presentation identity, and published
// only while the card still stands for the same revision in the same mode.
import { create } from 'zustand'
import { readSource } from './catalog'
import { boundedBitmap } from './image-bounds'
import type { PreviewSource } from './catalog'
import type { CatalogEntry, PreviewMode } from './contract'
import type { PreviewMeta, PreviewResponse } from './preview-worker'

/** §9.2: a few conversions at once; the rest wait their turn. */
const CONCURRENCY = 3
/** Presentations kept after their card leaves the view. */
const CACHE_LIMIT = 160

export type PreviewState =
  | { status: 'loading' }
  | {
      status: 'ready'
      mode: 'pixel'
      meta: PreviewMeta
      indices: Uint8Array
    }
  | { status: 'ready'; mode: 'full_fidelity'; image: ImageBitmap }
  | { status: 'ready'; mode: 'full_fidelity'; text: string; kind: string }
  | {
      status: 'unsupported' | 'unavailable' | 'failed' | 'too_large'
      detail: string
    }

/**
 * What a ready picture leaves out, in words: a generic type illustration, a
 * partial graph or chart, a sketch of an App's markup. Empty when the picture
 * is a straight reduction of its source.
 */
export function previewNote(
  state: PreviewState | undefined,
): string | undefined {
  if (!state || state.status === 'loading') return
  // A preview that could not be made says so, and that the original stands.
  if (state.status !== 'ready')
    return `No preview: ${state.detail}. The original can still be opened`
  if (state.mode !== 'pixel') return
  const notes: string[] = []
  if (state.meta.method === 'type_illustration')
    notes.push('A type illustration, not drawn from this file')
  else if (state.meta.method === 'structured_recipe')
    notes.push('Drawn from the file’s structure')
  if (state.meta.limitation) notes.push(state.meta.limitation.detail)
  return notes.join('. ') || undefined
}

/** What a card's visible preview depends on: card, revision and mode. */
export const presentationKey = (entry: CatalogEntry, mode: PreviewMode) =>
  `${entry.key}|${entry.source.revision}|${mode}`

type Previews = {
  states: Readonly<Record<string, PreviewState>>
  put: (key: string, state: PreviewState) => void
}

export const usePreviews = create<Previews>()((set) => ({
  states: {},
  put: (key, state) =>
    set((s) => {
      const states = { ...s.states, [key]: state }
      const keys = Object.keys(states)
      // Oldest presentations go first once the cache is full.
      for (const old of keys.slice(0, Math.max(0, keys.length - CACHE_LIMIT))) {
        const gone = states[old]
        // A decoded thumbnail is released with its cache entry.
        if (gone && 'image' in gone) gone.image.close()
        delete states[old]
      }
      return { states }
    }),
}))

/** A conversion that has not answered by then is treated as a worker fault. */
const JOB_TIMEOUT_MS = 20_000

let worker: Worker | undefined
let nextId = 0
const waiting = new Map<
  number,
  { resolve: (r: PreviewResponse) => void; reject: (e: Error) => void }
>()

/**
 * A worker that failed to load, crashed or stopped answering settles every
 * job it holds and is replaced on the next conversion, so later previews are
 * never left queued behind it.
 */
function discardWorker(reason: string) {
  worker?.terminate()
  worker = undefined
  const jobs = [...waiting.values()]
  waiting.clear()
  for (const job of jobs) job.reject(new Error(`failed: ${reason}`))
}

function convert(source: PreviewSource): Promise<PreviewResponse> {
  worker ??= (() => {
    const w = new Worker(new URL('./preview-worker.ts', import.meta.url), {
      type: 'module',
    })
    w.onmessage = (event: MessageEvent<PreviewResponse>) => {
      waiting.get(event.data.id)?.resolve(event.data)
      waiting.delete(event.data.id)
    }
    w.onerror = (event) => {
      event.preventDefault()
      discardWorker(event.message || 'the preview worker stopped')
    }
    w.onmessageerror = () => discardWorker('a preview result could not be read')
    return w
  })()
  const id = ++nextId
  const current = worker
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (waiting.has(id) && worker === current)
        discardWorker('the preview worker did not answer in time')
    }, JOB_TIMEOUT_MS)
    waiting.set(id, {
      resolve: (r) => (clearTimeout(timer), resolve(r)),
      reject: (e) => (clearTimeout(timer), reject(e)),
    })
    current.postMessage({ id, source: source.source, image: source.image })
  })
}

function failure(error: unknown): PreviewState {
  const text = error instanceof Error ? error.message : String(error)
  const [code, ...rest] = text.split(': ')
  const detail = rest.join(': ') || text
  if (code === 'too_large') return { status: 'too_large', detail }
  if (code === 'unsupported') return { status: 'unsupported', detail }
  if (code === 'unavailable' || /\b40[34]\b/.test(text))
    return { status: 'unavailable', detail }
  return { status: 'failed', detail }
}

async function produce(
  entry: CatalogEntry,
  mode: PreviewMode,
): Promise<PreviewState> {
  const source = await readSource(entry)
  if (mode === 'full_fidelity') {
    // The original, reduced only by size: no palette, no recipe.
    if (source.image)
      return {
        status: 'ready',
        mode,
        image: await boundedBitmap(source.image),
      }
    if (source.source.text && entry.kind !== 'app')
      return {
        status: 'ready',
        mode,
        text: source.source.text,
        kind: entry.kind,
      }
    // An app is never run to make a thumbnail (§11): it keeps its sketch.
  }
  return pixelPreview(source)
}

/**
 * One source through the terminal crate's renderer, outside any card: what
 * a composer attachment shows is drawn the way the gallery draws it.
 */
export async function pixelPreview(
  source: PreviewSource,
): Promise<PreviewState> {
  const response = await convert(source)
  if (!response.ok)
    return response.code === 'unsupported'
      ? { status: 'unsupported', detail: response.detail }
      : failure(new Error(`${response.code}: ${response.detail}`))
  return {
    status: 'ready',
    mode: 'pixel',
    meta: response.meta,
    indices: response.indices,
  }
}

const queue: Array<{ entry: CatalogEntry; mode: PreviewMode }> = []
const inFlight = new Set<string>()

function pump() {
  while (inFlight.size < CONCURRENCY && queue.length) {
    const { entry, mode } = queue.shift()!
    const key = presentationKey(entry, mode)
    inFlight.add(key)
    produce(entry, mode)
      .catch(failure)
      .then((state) => {
        // Cached under its own identity: a card that moved on to another
        // revision or mode never shows it, because it asks for another key.
        usePreviews.getState().put(key, state)
      })
      .finally(() => {
        inFlight.delete(key)
        pump()
      })
  }
}

/**
 * Asks for the visible cards' previews, nearest first. Cards that left the
 * view lose their place in the queue but keep anything already made.
 */
export function requestPreviews(
  entries: readonly CatalogEntry[],
  mode: PreviewMode,
) {
  const wanted = new Set(entries.map((e) => presentationKey(e, mode)))
  for (let i = queue.length - 1; i >= 0; i--)
    if (!wanted.has(presentationKey(queue[i]!.entry, queue[i]!.mode)))
      queue.splice(i, 1)
  const { states, put } = usePreviews.getState()
  for (const entry of entries) {
    const key = presentationKey(entry, mode)
    if (inFlight.has(key)) continue
    if (queue.some((q) => presentationKey(q.entry, q.mode) === key)) continue
    // A card dropped from the queue while loading asks again.
    if (states[key] && states[key].status !== 'loading') continue
    if (!states[key]) put(key, { status: 'loading' })
    queue.push({ entry, mode })
  }
  pump()
}
