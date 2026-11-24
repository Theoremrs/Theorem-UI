// SOURCING: zustand's create and subscribe, as view-actions keeps the views a
// reply draws. No library tells an agent what its notebook showed once it ran.
//
// What each inline view has shown, by instance: the view's `id` when the
// agent named one, else its revision. InteractiveView reports as its frame
// builds, its cells settle and the reader selects; the present operation
// waits here so its receipt says what the person sees, and `ui.view` reads
// or saves an instance (operations.ts). Within one reply an `id` is one
// view: presenting it again revises it, or the paint it stands in, in place.
import { create } from 'zustand'
import type { AppSelection, CellStatus } from '@/lib/blocks/sandbox/protocol'

/**
 * Where a view stands. Before every cell settles: `accepted` (the reply drew
 * it), `compiled` (its cells built into a page) or `mounted` (the frame runs
 * them). Then `ready` when every cell shows its value, `partial` when some
 * failed, `failed` when every cell failed or the page did not build.
 */
export type ViewStage = 'accepted' | 'compiled' | 'mounted' | 'ready' | 'partial' | 'failed'

/** The stages a view passes through before its cells settle. */
export type ViewProgress = Extract<ViewStage, 'accepted' | 'compiled' | 'mounted'>

const PROGRESS: ReadonlyArray<ViewProgress> = ['accepted', 'compiled', 'mounted']

export interface ViewInstance {
  readonly revision: string
  /** The cells' ids, in order. */
  readonly cells: ReadonlyArray<string>
  /** The cells' sources, by the same index, when the view reported them. */
  readonly sources?: ReadonlyArray<string>
  readonly progress: ViewProgress
  readonly settled: Readonly<Record<string, CellStatus['stage']>>
  /** Why each failed cell failed. */
  readonly cellErrors: Readonly<Record<string, string>>
  /** What each ready cell shows (CellStatus `shows`). */
  readonly shows: Readonly<Record<string, string>>
  /** What else the frame raised. */
  readonly errors: ReadonlyArray<string>
  /** Why the page did not build, when it did not. */
  readonly unbuilt?: string
  /** What the reader selected and set in this revision. */
  readonly selection?: AppSelection
}

/** Saves the instance as an App, with what the reader set; answers the document. */
export type ViewSaver = () => Promise<{ documentId: string }>

/** The most errors one instance keeps, as a frame reports at most MAX_FRAME_ERRORS. */
const MAX_ERRORS = 20

type ViewInstancesState = {
  byKey: Readonly<Record<string, ViewInstance>>
  /** A view's frame started on a revision; what an earlier revision showed is forgotten. */
  mount: (key: string, revision: string, cells: ReadonlyArray<string>, sources?: ReadonlyArray<string>) => void
  /** The page built (`compiled`) or the frame started (`mounted`). */
  advance: (key: string, revision: string, progress: ViewProgress) => void
  settle: (key: string, revision: string, status: CellStatus) => void
  error: (key: string, revision: string, message: string) => void
  unbuilt: (key: string, revision: string, message: string) => void
  select: (key: string, revision: string, selection: AppSelection) => void
  /** How each mounted instance is saved, by key. */
  savers: Readonly<Record<string, ViewSaver>>
  offerSave: (key: string, save: ViewSaver) => () => void
}

export const useViewInstances = create<ViewInstancesState>()((set) => {
  /** Changes the instance only while it is still on `revision`. */
  const update = (key: string, revision: string, change: (view: ViewInstance) => ViewInstance) =>
    set((s) => {
      const view = s.byKey[key]
      return view?.revision === revision ? { byKey: { ...s.byKey, [key]: change(view) } } : s
    })
  return {
    byKey: {},
    mount: (key, revision, cells, sources) =>
      set((s) =>
        s.byKey[key]?.revision === revision
          ? s
          : {
              byKey: {
                ...s.byKey,
                [key]: {
                  revision,
                  cells,
                  ...(sources && { sources }),
                  progress: 'accepted',
                  settled: {},
                  cellErrors: {},
                  shows: {},
                  errors: [],
                },
              },
            },
      ),
    advance: (key, revision, progress) =>
      update(key, revision, (view) =>
        PROGRESS.indexOf(progress) > PROGRESS.indexOf(view.progress) ? { ...view, progress } : view,
      ),
    settle: (key, revision, { cell, stage, error, shows }) =>
      update(key, revision, (view) =>
        view.settled[cell]
          ? view
          : {
              ...view,
              settled: { ...view.settled, [cell]: stage },
              ...(error !== undefined && { cellErrors: { ...view.cellErrors, [cell]: error } }),
              ...(shows !== undefined && { shows: { ...view.shows, [cell]: shows } }),
            },
      ),
    error: (key, revision, message) =>
      update(key, revision, (view) =>
        view.errors.length >= MAX_ERRORS ? view : { ...view, errors: [...view.errors, message] },
      ),
    unbuilt: (key, revision, message) => update(key, revision, (view) => ({ ...view, unbuilt: message })),
    select: (key, revision, selection) => update(key, revision, (view) => ({ ...view, selection })),
    savers: {},
    offerSave: (key, save) => {
      set((s) => ({ savers: { ...s.savers, [key]: save } }))
      return () =>
        set((s) => {
          if (s.savers[key] !== save) return s
          const { [key]: _gone, ...savers } = s.savers
          return { savers }
        })
    },
  }
})

export function stageOf(view: ViewInstance): ViewStage {
  if (view.unbuilt) return 'failed'
  const outcomes = view.cells.map((cell) => view.settled[cell])
  if (outcomes.some((outcome) => outcome === undefined)) return view.progress
  if (outcomes.every((outcome) => outcome === 'ready')) return 'ready'
  return outcomes.every((outcome) => outcome === 'failed') ? 'failed' : 'partial'
}

/** The most selected ids, and the largest state, a receipt repeats. */
const MAX_SELECTED_IDS = 50
const MAX_STATE_BYTES = 4096

/** What the reader selected, as a receipt says it: their words for it, the records, the state they set. */
function selected(selection?: AppSelection) {
  if (!selection) return undefined
  const label =
    selection.entityLabel || selection.text.trim().slice(0, 200) || selection.entityId || selection.rowId
  const ids = selection.ids ?? []
  const state =
    selection.state && JSON.stringify(selection.state).length <= MAX_STATE_BYTES ? selection.state : undefined
  if (!label && !ids.length && !state) return undefined
  return {
    ...(label && { label }),
    ...(ids.length && { ids: ids.slice(0, MAX_SELECTED_IDS) }),
    ...(ids.length > MAX_SELECTED_IDS && { idsTotal: ids.length }),
    ...(state && { state }),
  }
}

/** How long a receipt waits for the page to draw before it says the page is not drawing. */
const DRAW_PROBE_MS = 500
/** Frames in a row that count as drawing: a hidden window can paint one frame on demand (a capture) and stop again. */
const DRAW_PROBE_FRAMES = 3

/**
 * Whether the page draws. Observable runs cells on animation frames, which a
 * browser stops in a background tab or a hidden window: cells wait there,
 * neither failed nor stuck.
 */
export function pageDraws(timeoutMs = DRAW_PROBE_MS): Promise<boolean> {
  return new Promise((resolve) => {
    let frame = 0
    const timer = setTimeout(() => {
      cancelAnimationFrame(frame)
      resolve(false)
    }, timeoutMs)
    const next = (left: number) => {
      frame = requestAnimationFrame(() => {
        if (left > 1) return next(left - 1)
        clearTimeout(timer)
        resolve(true)
      })
    }
    next(DRAW_PROBE_FRAMES)
  })
}

/** What a receipt says of one view: its stage, which cells show and what, why any failed, and what the reader chose. */
export function viewReceipt(
  key: string,
  view: ViewInstance,
  { drawing = true, blocking }: { drawing?: boolean; blocking?: Record<string, Array<string>> } = {},
) {
  const where = (stage?: CellStatus['stage']) => view.cells.filter((cell) => view.settled[cell] === stage)
  const pending = where(undefined)
  const failed = where('failed')
  const selection = selected(view.selection)
  // Each failed cell's error under its id, then what else the frame raised
  // that no cell's error already says.
  const cellErrors = failed.flatMap((cell) => {
    const error = view.cellErrors[cell]
    return error === undefined ? [] : [`Cell ${cell}: ${error}`]
  })
  const others = view.errors.filter((error) => !cellErrors.some((told) => told.includes(error)))
  const errors = [...new Set([...(view.unbuilt ? [view.unbuilt] : []), ...cellErrors, ...others])]
  const displayed = where('ready')
  const shows = Object.fromEntries(displayed.flatMap((cell) => (view.shows[cell] ? [[cell, view.shows[cell]]] : [])))
  return {
    id: key,
    revision: view.revision,
    stage: stageOf(view),
    displayed,
    ...(Object.keys(shows).length && { shows }),
    ...(failed.length && { failed }),
    ...(pending.length && !view.unbuilt && { pending }),
    ...(pending.length &&
      !view.unbuilt &&
      !drawing && {
        waiting: 'The page is not drawing (a background tab or a hidden window), so the pending cells run once the reader looks at it.',
      }),
    ...(blocking && Object.keys(blocking).length && { blocking }),
    ...(errors.length && { errors }),
    ...(selection && { selection }),
  }
}

/**
 * The receipt for a view as it is now. While cells are pending it probes
 * whether the page draws, and on a page that draws names the cells the rest
 * wait on.
 */
export async function currentReceipt(key: string, view: ViewInstance) {
  const pending = view.unbuilt ? [] : view.cells.flatMap((cell, index) => (view.settled[cell] === undefined ? [index] : []))
  if (!pending.length) return viewReceipt(key, view)
  if (!(await pageDraws())) return viewReceipt(key, view, { drawing: false })
  if (!view.sources) return viewReceipt(key, view)
  const { blockingCells } = await import('@/lib/notebooks/cells')
  const id = (index: number) => view.cells[index] ?? `c${index + 1}`
  const blocking = Object.fromEntries(
    [...blockingCells(view.sources, pending)].map(([root, waiters]) => [id(root), waiters.map(id)]),
  )
  return viewReceipt(key, view, { blocking })
}

/**
 * The instance once `revision` has settled (every cell shown or failed, or
 * the page did not build), or as it stands after `timeoutMs`; undefined when
 * no view started on that revision by then.
 */
export function whenSettled(key: string, revision: string, timeoutMs: number): Promise<ViewInstance | undefined> {
  const current = () => {
    const view = useViewInstances.getState().byKey[key]
    return view?.revision === revision ? view : undefined
  }
  const done = (view?: ViewInstance) => view !== undefined && !(PROGRESS as ReadonlyArray<ViewStage>).includes(stageOf(view))
  if (done(current())) return Promise.resolve(current())
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer)
      unsubscribe()
      resolve(current())
    }
    const timer = setTimeout(finish, timeoutMs)
    const unsubscribe = useViewInstances.subscribe(() => done(current()) && finish())
  })
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

/**
 * Each View node in `tree` passed through `revise`, which answers the node to
 * draw in its place or undefined to draw nothing there. Unchanged branches
 * keep their objects, so a part that streams does not rebuild its views.
 */
function mapViews(tree: unknown, revise: (view: Record<string, unknown>) => unknown, depth = 0): unknown {
  if (depth > 64) return tree
  if (Array.isArray(tree)) {
    const mapped = tree.map((entry) => mapViews(entry, revise, depth + 1))
    return mapped.some((entry, index) => entry !== tree[index]) ? mapped.filter((entry) => entry !== undefined) : tree
  }
  const node = record(tree)
  if (!node) return tree
  if (node._type === 'View') return revise(node)
  if (node.children === undefined) return tree
  const children = mapViews(node.children, revise, depth + 1)
  return children === node.children ? tree : { ...node, children }
}

const viewId = (node: Record<string, unknown>) =>
  typeof node.id === 'string' && node.id.trim() ? node.id.trim() : undefined

/**
 * One reply's present calls as they are drawn. A call that presents again a
 * View `id` an earlier call drew is drawn in that earlier call's place and
 * nowhere else: the whole call, replacing the earlier one, when it is more
 * than the View (the agent restated the paint, say to mend its text), or the
 * View alone, where it stands in the earlier paint, when that is all it
 * presents. Views without an id are drawn as written.
 */
export function reviseViews(calls: ReadonlyArray<Record<string, unknown>>): Array<Record<string, unknown>> {
  const latest = new Map<string, Record<string, unknown>>()
  const painted: Array<Record<string, unknown> | undefined> = [...calls]
  // Where each id's paint is drawn.
  const paintOf = new Map<string, number>()
  calls.forEach((call, index) => {
    const ids: Array<string> = []
    mapViews(call, (node) => {
      const id = viewId(node)
      if (id) {
        latest.set(id, node)
        ids.push(id)
      }
      return node
    })
    const earlier = ids.flatMap((id) => paintOf.get(id) ?? [])
    if (earlier.length && call._type !== 'View') {
      const at = Math.min(...earlier)
      painted[at] = call
      painted[index] = undefined
      for (const id of ids) paintOf.set(id, at)
    } else for (const id of ids) if (!paintOf.has(id)) paintOf.set(id, index)
  })
  if (!latest.size) return [...calls]
  const drawn = new Set<string>()
  return painted.map((call) => {
    if (!call) return {}
    const revised = mapViews(call, (node) => {
      const id = viewId(node)
      if (!id) return node
      if (drawn.has(id)) return undefined
      drawn.add(id)
      return latest.get(id)
    })
    return record(revised) ?? {}
  })
}
