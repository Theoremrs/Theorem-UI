// SOURCING: zustand (the runtime records, as artifact-view.ts keeps view
// state); no library models attachment of views to a running artifact. The
// placement of each runtime's element is the host's (artifact-runtime-host).
//
// Unified Agent Experience AR-08 to AR-12. A live artifact's runtime is owned
// here, above the answer, the dock and the expanded view. Views attach to a
// runtime; they never start it again. One view at a time is interactive
// unless the runtime's renderer declares shared interactive views; every
// other view is passive and offers to move the attachment there or to start a
// separate copy, which records where it came from. Closing a view detaches it
// and never stops the runtime.
import { create } from 'zustand'
import type { RuntimeRevisions } from './artifact-runtime-revisions'

/** Where a view of a runtime is drawn. */
export type RuntimeSurface = 'inline' | 'docked' | 'expanded' | 'cabinet'

export type RuntimeAttachment = {
  viewId: string
  surface: RuntimeSurface
  /** Order of attachment, for choosing who holds the runtime when its holder leaves. */
  at: number
}

/** Where an independent copy came from (AR-09, AR-06). */
export type RuntimeLineage = {
  from: string
  /** The running revision of the source when the copy started. */
  revision?: string
}

export type RuntimeRecord = {
  id: string
  artifactId: string
  documentId: string
  /** The renderer that runs it (artifact-registry's mount id). */
  renderer: string
  title: string
  /** The artifact's own runtime, which its views attach to by default; a copy is not primary. */
  primary: boolean
  lineage?: RuntimeLineage
  /** The conversation the runtime belongs to; questions it asks go only there. */
  conversation?: string
  /** The revision the newest answer recorded, for "Changed since this result". */
  pinnedPosition?: number | string
  /** The renderer implements several interactive views over this runtime. */
  shared: boolean
  attachments: ReadonlyArray<RuntimeAttachment>
  /** The view that is interactive; undefined while no view is attached. */
  holder?: string
  /** Views that held it before, most recent last: who regains it when the holder leaves. */
  returnTo: ReadonlyArray<string>
  /** The view that opened the expanded view, while it is open. */
  expandedFrom?: string
  /** How many times the runtime executed its startup. A move never adds one. */
  startups: number
  /** When its last view left; undefined while any view is attached. */
  detachedAt?: number
  /** It was stopped to free resources after its views closed, then started again. */
  restartedAfterRelease: boolean
  revisions: RuntimeRevisions
}

type RuntimeState = {
  runtimes: Readonly<Record<string, RuntimeRecord>>
  /** Each attached view's runtime. */
  views: Readonly<Record<string, string>>
  /** The runtime shown in the expanded view, if one is. */
  expanded?: string
  /** Artifacts whose runtime was released while no view showed it. */
  released: Readonly<Record<string, number>>
  /** Hosts mounted; a view attaches only when one is. */
  hosts: number
}

export type AttachRequest = {
  viewId: string
  surface: RuntimeSurface
  artifactId: string
  documentId: string
  renderer: string
  title: string
  shared?: boolean
  conversation?: string
  pinnedPosition?: number | string
}

type RuntimeActions = {
  /** Attaches a view to the artifact's runtime, starting the runtime only if none runs. */
  attach: (request: AttachRequest) => string
  /** The view went: the runtime keeps running (AR-12). */
  detach: (viewId: string) => void
  /** Moves the interactive attachment to this view. */
  moveHere: (viewId: string) => void
  /** Starts an independent instance in this view, with lineage (AR-09). */
  startCopy: (viewId: string) => string | undefined
  /** Shows another runtime of the same artifact (a copy, or the original) here. */
  showHere: (viewId: string, runtimeId: string) => void
  /** Opens the expanded view of the runtime this view shows, moving the attachment there. */
  expand: (viewId: string) => void
  /** Closes the expanded view, returning the attachment to the view that opened it. */
  restore: (runtimeId?: string) => void
  /** A runtime executed its startup. */
  started: (runtimeId: string) => void
  /** What a runtime reports about its revisions and saves. */
  report: (runtimeId: string, revisions: RuntimeRevisions) => void
  /** Records the conversation a runtime belongs to, once it has an id. */
  adopt: (runtimeId: string, conversation: string) => void
  hostMounted: () => () => void
  reset: () => void
}

/** Runtimes kept running with no view attached; the oldest beyond this is released. */
export const DETACHED_KEPT = 3

/** The expanded view's id for a runtime. */
export const expandedViewId = (runtimeId: string) => `expanded:${runtimeId}`

let clock = 0
const tick = () => ++clock
let made = 0

const EMPTY: RuntimeState = {
  runtimes: {},
  views: {},
  expanded: undefined,
  released: {},
  hosts: 0,
}

function primaryOf(
  runtimes: Readonly<Record<string, RuntimeRecord>>,
  artifactId: string,
): RuntimeRecord | undefined {
  return Object.values(runtimes).find(
    (one) => one.primary && one.artifactId === artifactId,
  )
}

/** The view that holds a runtime after `leaving` goes: the last holder still here, else the newest view. */
function nextHolder(
  record: RuntimeRecord,
  attachments: ReadonlyArray<RuntimeAttachment>,
  prefer?: string,
): { holder?: string; returnTo: ReadonlyArray<string> } {
  const here = new Set(attachments.map((one) => one.viewId))
  if (prefer && here.has(prefer))
    return {
      holder: prefer,
      returnTo: record.returnTo.filter((id) => id !== prefer && here.has(id)),
    }
  const back = record.returnTo.filter((id) => here.has(id))
  const previous = back.at(-1)
  if (previous) return { holder: previous, returnTo: back.slice(0, -1) }
  const newest = [...attachments].sort((a, b) => b.at - a.at)[0]
  return { holder: newest?.viewId, returnTo: [] }
}

function withAttachment(
  record: RuntimeRecord,
  viewId: string,
  surface: RuntimeSurface,
): RuntimeRecord {
  const attachments = [
    ...record.attachments.filter((one) => one.viewId !== viewId),
    { viewId, surface, at: tick() },
  ]
  return {
    ...record,
    attachments,
    holder: record.holder ?? viewId,
    detachedAt: undefined,
  }
}

function withoutAttachment(
  record: RuntimeRecord,
  viewId: string,
): RuntimeRecord {
  const attachments = record.attachments.filter((one) => one.viewId !== viewId)
  const leaving = record.holder === viewId
  const next = leaving
    ? nextHolder(record, attachments)
    : {
        holder: record.holder,
        returnTo: record.returnTo.filter((id) => id !== viewId),
      }
  return {
    ...record,
    attachments,
    holder: next.holder,
    returnTo: next.returnTo,
    expandedFrom:
      record.expandedFrom === viewId ? undefined : record.expandedFrom,
    detachedAt: attachments.length ? undefined : tick(),
  }
}

function claimed(record: RuntimeRecord, viewId: string): RuntimeRecord {
  if (record.holder === viewId) return record
  return {
    ...record,
    holder: viewId,
    returnTo: [
      ...record.returnTo.filter((id) => id !== viewId && id !== record.holder),
      ...(record.holder ? [record.holder] : []),
    ],
  }
}

/** Releases the oldest runtimes with no view attached beyond DETACHED_KEPT. */
function retained(
  state: RuntimeState,
): Pick<RuntimeState, 'runtimes' | 'released'> {
  const detached = Object.values(state.runtimes)
    .filter((one) => one.attachments.length === 0)
    .sort((a, b) => (b.detachedAt ?? 0) - (a.detachedAt ?? 0))
  const released = detached.slice(DETACHED_KEPT)
  if (!released.length)
    return { runtimes: state.runtimes, released: state.released }
  const runtimes = { ...state.runtimes }
  const record = { ...state.released }
  for (const one of released) {
    delete runtimes[one.id]
    if (one.primary) record[one.artifactId] = tick()
  }
  return { runtimes, released: record }
}

function newRecord(
  request: AttachRequest,
  state: RuntimeState,
  primary: boolean,
  lineage?: RuntimeLineage,
): RuntimeRecord {
  return {
    id: `runtime-${++made}`,
    artifactId: request.artifactId,
    documentId: request.documentId,
    renderer: request.renderer,
    title: request.title,
    primary,
    lineage,
    conversation: request.conversation,
    pinnedPosition: request.pinnedPosition,
    shared: request.shared ?? false,
    attachments: [],
    returnTo: [],
    startups: 0,
    restartedAfterRelease: primary && request.artifactId in state.released,
    revisions: {},
  }
}

export const useArtifactRuntimes = create<RuntimeState & RuntimeActions>()(
  (set, get) => ({
    ...EMPTY,
    attach: (request) => {
      const state = get()
      const bound = state.views[request.viewId]
      const current = bound ? state.runtimes[bound] : undefined
      // A view already attached keeps its runtime: the answer re-rendering, a
      // newer revision of the same document, or a copy it chose.
      if (current && current.documentId === request.documentId) {
        set({
          runtimes: {
            ...state.runtimes,
            [current.id]: {
              ...current,
              title: request.title,
              ...(current.primary && {
                pinnedPosition: request.pinnedPosition,
              }),
            },
          },
        })
        return current.id
      }
      const runtimes = { ...state.runtimes }
      const views = { ...state.views }
      if (current) {
        runtimes[current.id] = withoutAttachment(current, request.viewId)
        delete views[request.viewId]
      }
      let record = primaryOf(runtimes, request.artifactId)
      // The artifact's newest revision names another document: its old
      // runtime is not this App, so it is released if nothing shows it and
      // otherwise stops being the one new views attach to.
      if (record && record.documentId !== request.documentId) {
        if (record.attachments.length === 0) delete runtimes[record.id]
        else runtimes[record.id] = { ...record, primary: false }
        record = undefined
      }
      record ??= newRecord(request, state, true)
      record = withAttachment(
        {
          ...record,
          title: request.title,
          pinnedPosition: request.pinnedPosition,
          conversation: record.conversation ?? request.conversation,
        },
        request.viewId,
        request.surface,
      )
      runtimes[record.id] = record
      views[request.viewId] = record.id
      const released = { ...state.released }
      delete released[request.artifactId]
      set({ runtimes, views, released })
      return record.id
    },
    detach: (viewId) => {
      const state = get()
      const id = state.views[viewId]
      const record = id ? state.runtimes[id] : undefined
      if (!id || !record) return
      const views = { ...state.views }
      delete views[viewId]
      // The view that opened the expanded view going leaves the expanded view
      // open; restoring it then returns to whoever held the runtime before.
      const next = withoutAttachment(record, viewId)
      const expanded =
        viewId === expandedViewId(id) ? undefined : state.expanded
      const after = {
        ...state,
        views,
        expanded,
        runtimes: { ...state.runtimes, [id]: next },
      }
      set({ views, expanded, ...retained(after) })
    },
    moveHere: (viewId) => {
      const state = get()
      const id = state.views[viewId]
      const record = id ? state.runtimes[id] : undefined
      if (!id || !record) return
      // Moving to any view other than the expanded one closes the expanded view.
      if (state.expanded === id && viewId !== expandedViewId(id)) {
        get().detach(expandedViewId(id))
        const after = get().runtimes[id]
        if (after)
          set({ runtimes: { ...get().runtimes, [id]: claimed(after, viewId) } })
        return
      }
      set({ runtimes: { ...state.runtimes, [id]: claimed(record, viewId) } })
    },
    startCopy: (viewId) => {
      const state = get()
      const id = state.views[viewId]
      const source = id ? state.runtimes[id] : undefined
      if (!id || !source) return undefined
      const surface =
        source.attachments.find((one) => one.viewId === viewId)?.surface ??
        'docked'
      const copy = withAttachment(
        newRecord(
          {
            viewId,
            surface,
            artifactId: source.artifactId,
            documentId: source.documentId,
            renderer: source.renderer,
            title: source.title,
            shared: source.shared,
            conversation: source.conversation,
            pinnedPosition: source.pinnedPosition,
          },
          state,
          false,
          { from: source.id, revision: source.revisions.running },
        ),
        viewId,
        surface,
      )
      const runtimes = {
        ...state.runtimes,
        [id]: withoutAttachment(source, viewId),
        [copy.id]: copy,
      }
      set({ runtimes, views: { ...state.views, [viewId]: copy.id } })
      return copy.id
    },
    showHere: (viewId, runtimeId) => {
      const state = get()
      const from = state.views[viewId]
      const target = state.runtimes[runtimeId]
      if (!target || from === runtimeId) {
        if (target) get().moveHere(viewId)
        return
      }
      const current = from ? state.runtimes[from] : undefined
      const surface =
        current?.attachments.find((one) => one.viewId === viewId)?.surface ??
        'docked'
      const runtimes = { ...state.runtimes }
      if (current) runtimes[current.id] = withoutAttachment(current, viewId)
      runtimes[runtimeId] = claimed(
        withAttachment(target, viewId, surface),
        viewId,
      )
      const after = {
        ...state,
        runtimes,
        views: { ...state.views, [viewId]: runtimeId },
      }
      set({ views: after.views, ...retained(after) })
    },
    expand: (viewId) => {
      const state = get()
      const id = state.views[viewId]
      const record = id ? state.runtimes[id] : undefined
      if (!id || !record) return
      if (state.expanded && state.expanded !== id) get().restore(state.expanded)
      const view = expandedViewId(id)
      const fresh = get()
      const base = fresh.runtimes[id]
      if (!base) return
      const next = claimed(
        { ...withAttachment(base, view, 'expanded'), expandedFrom: viewId },
        view,
      )
      set({
        expanded: id,
        runtimes: { ...fresh.runtimes, [id]: next },
        views: { ...fresh.views, [view]: id },
      })
    },
    restore: (runtimeId) => {
      const state = get()
      const id = runtimeId ?? state.expanded
      const record = id ? state.runtimes[id] : undefined
      if (!id || !record || state.expanded !== id) return
      const opener = record.expandedFrom
      const view = expandedViewId(id)
      const attachments = record.attachments.filter(
        (one) => one.viewId !== view,
      )
      const next = nextHolder(
        { ...record, returnTo: record.returnTo.filter((one) => one !== view) },
        attachments,
        opener,
      )
      const views = { ...state.views }
      delete views[view]
      const after: RuntimeRecord = {
        ...record,
        attachments,
        holder: next.holder,
        returnTo: next.returnTo,
        expandedFrom: undefined,
        detachedAt: attachments.length ? undefined : tick(),
      }
      const all = {
        ...state,
        views,
        expanded: undefined,
        runtimes: { ...state.runtimes, [id]: after },
      }
      set({ views, expanded: undefined, ...retained(all) })
    },
    started: (runtimeId) => {
      const record = get().runtimes[runtimeId]
      if (!record) return
      set({
        runtimes: {
          ...get().runtimes,
          [runtimeId]: { ...record, startups: record.startups + 1 },
        },
      })
    },
    report: (runtimeId, revisions) => {
      const record = get().runtimes[runtimeId]
      if (!record) return
      const before = record.revisions
      const restartedFrom =
        before.running !== undefined &&
        revisions.running !== undefined &&
        before.running !== revisions.running
          ? before.running
          : revisions.running === before.running
            ? before.restartedFrom
            : undefined
      const next = { ...revisions, restartedFrom }
      if (JSON.stringify(next) === JSON.stringify(before)) return
      set({
        runtimes: {
          ...get().runtimes,
          [runtimeId]: { ...record, revisions: next },
        },
      })
    },
    adopt: (runtimeId, conversation) => {
      const record = get().runtimes[runtimeId]
      if (!record || record.conversation !== undefined) return
      set({
        runtimes: {
          ...get().runtimes,
          [runtimeId]: { ...record, conversation },
        },
      })
    },
    hostMounted: () => {
      set((s) => ({ hosts: s.hosts + 1 }))
      return () => set((s) => ({ hosts: Math.max(0, s.hosts - 1) }))
    },
    reset: () => set({ ...EMPTY, hosts: get().hosts }),
  }),
)

/** The runtime a view is attached to. */
export function runtimeOfView(viewId: string): RuntimeRecord | undefined {
  const state = useArtifactRuntimes.getState()
  const id = state.views[viewId]
  return id ? state.runtimes[id] : undefined
}

/** Whether a view of this runtime is interactive: it holds it, or the renderer shares it. */
export function isInteractive(
  record: RuntimeRecord | undefined,
  viewId: string,
): boolean {
  if (!record) return false
  return record.shared
    ? record.attachments.some((one) => one.viewId === viewId)
    : record.holder === viewId
}

/** Every runtime of an artifact, the original first, then its copies in the order they started. */
export function runtimesOfArtifact(
  runtimes: Readonly<Record<string, RuntimeRecord>>,
  artifactId: string,
): Array<RuntimeRecord> {
  return Object.values(runtimes)
    .filter((one) => one.artifactId === artifactId)
    .sort((a, b) => Number(b.primary) - Number(a.primary))
}

/** The surface a view is on, as its runtime records it. */
export function surfaceOf(
  record: RuntimeRecord | undefined,
  viewId: string | undefined,
): RuntimeSurface | undefined {
  return record?.attachments.find((one) => one.viewId === viewId)?.surface
}
