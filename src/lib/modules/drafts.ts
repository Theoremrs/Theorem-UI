// SOURCING: zustand (a store outside any view, as file-sync.ts keeps text
// files' drafts), and the browser's beforeunload prompt for an edited form.
// The desktop quit check reads it through reportUnsaved (desktop/unsaved.ts).
import { create } from 'zustand'
import type { PageDocument } from './contract'

/** An unsaved arrangement, and the revision it was made over. */
export interface PageDraft {
  held: { hash: string | null; page: PageDocument }
  draft: PageDocument
}

/**
 * Pages' unsaved arrangements, by the page they belong to. A page's view
 * can go (another page opened, another mode) while its draft stays here,
 * to be shown again when the page is.
 */
export const usePageDrafts = create<{
  drafts: Record<string, PageDraft>
  keep: (key: string, draft: PageDraft | undefined) => void
}>()((set) => ({
  drafts: {},
  keep: (key, draft) => {
    if (draft) watchUnload()
    set((state) => {
      if (state.drafts[key] === draft) return state
      const drafts = { ...state.drafts }
      if (draft) drafts[key] = draft
      else delete drafts[key]
      return { drafts }
    })
  },
}))

/** Whether any page or form has an arrangement the vault does not. */
export const pagesUnsaved = () =>
  Object.keys(usePageDrafts.getState().drafts).length > 0 ||
  Object.values(useDraftSlots.getState().slots).some(isDirty)

let watching = false

/** Leaving the app with an unsaved page asks first. */
function watchUnload() {
  if (watching || typeof window === 'undefined') return
  watching = true
  window.addEventListener('beforeunload', (event) => {
    if (pagesUnsaved()) event.preventDefault()
  })
}

// ---------------------------------------------------------------------------
// Draft slots (UX-02, A17). A slot is one edit in progress over a saved
// revision. Saving clears only the revision it submitted, so what was typed
// while the write was in flight stays unsaved; another client's newer revision
// is offered, never swapped in over an edit; a failed or conflicting write
// keeps the draft. These are pure functions, so each rule is tested alone.

export interface DraftSlot<T> {
  /** The saved revision this edit was made over, as the writer names it. */
  base: string | null
  /** The saved value at that revision. */
  saved: T
  /** The edit as it is now. */
  value: T
  /** Counts edits; a save names the one it submitted. */
  revision: number
  /** The revision submitted and not yet answered. */
  saving?: number
  /** The last save's failure, kept until the next attempt. */
  failure?: string
  /** A newer saved revision from elsewhere, offered while this edit is open. */
  offered?: { base: string | null; value: T }
  /** The writer refused because the saved revision moved; what it holds now. */
  conflict?: { base: string | null; value: T }
}

export const isDirty = (slot: DraftSlot<unknown>) =>
  slot.revision > 0 && !Object.is(slot.value, slot.saved)

/** A slot over a saved value, with nothing edited yet. */
export const openDraft = <T>(base: string | null, saved: T): DraftSlot<T> => ({
  base,
  saved,
  value: saved,
  revision: 0,
})

/** An edit: a new revision of the draft. */
export const editDraft = <T>(slot: DraftSlot<T>, value: T): DraftSlot<T> => ({
  ...slot,
  value,
  revision: slot.revision + 1,
  failure: undefined,
})

/** The value and revision to send, and the slot marked as saving it. */
export function beginSave<T>(slot: DraftSlot<T>): {
  slot: DraftSlot<T>
  submitted: { revision: number; value: T; base: string | null }
} {
  return {
    slot: { ...slot, saving: slot.revision, failure: undefined },
    submitted: { revision: slot.revision, value: slot.value, base: slot.base },
  }
}

/**
 * The write succeeded and produced `savedBase`. If nothing was edited since the
 * submission the draft is cleared (undefined). Otherwise the later edits stay,
 * now over the revision just saved, still unsaved.
 */
export function saveSucceeded<T>(
  slot: DraftSlot<T>,
  submitted: { revision: number; value: T },
  savedBase: string | null,
): DraftSlot<T> | undefined {
  if (slot.revision === submitted.revision) return undefined
  return {
    ...slot,
    base: savedBase,
    saved: submitted.value,
    saving: undefined,
    conflict: undefined,
  }
}

/** The write failed: the draft is exactly as it was, with the reason. */
export const saveFailed = <T>(
  slot: DraftSlot<T>,
  failure: string,
): DraftSlot<T> => ({ ...slot, saving: undefined, failure })

/** The saved revision had moved: keep the draft and hold what is saved now beside it. */
export const saveConflicted = <T>(
  slot: DraftSlot<T>,
  current: { base: string | null; value: T },
): DraftSlot<T> => ({ ...slot, saving: undefined, conflict: current })

/**
 * Another client saved a newer revision. With no unsaved edit it is taken. With
 * one, it is offered and the edit stays as it is.
 */
export function incomingRevision<T>(
  slot: DraftSlot<T>,
  incoming: { base: string | null; value: T },
): DraftSlot<T> {
  if (incoming.base === slot.base) return slot
  return isDirty(slot) || slot.saving !== undefined
    ? { ...slot, offered: incoming }
    : { ...openDraft(incoming.base, incoming.value) }
}

/** Takes the offered revision as the base; the person's edit is replaced only because they asked. */
export const acceptOffered = <T>(slot: DraftSlot<T>): DraftSlot<T> =>
  slot.offered ? openDraft(slot.offered.base, slot.offered.value) : slot

/** Keeps the edit and moves it over the newer revision, so the next save is deliberate. */
export const keepMine = <T>(slot: DraftSlot<T>): DraftSlot<T> => {
  const newer = slot.offered ?? slot.conflict
  return newer
    ? {
        ...slot,
        base: newer.base,
        saved: newer.value,
        offered: undefined,
        conflict: undefined,
      }
    : slot
}

/**
 * Settings after an edit. Keys the editor does not know are carried over
 * untouched; a known key the edit leaves out is removed.
 */
export function applySettingsEdit(
  stored: Record<string, unknown>,
  edit: Record<string, unknown>,
  knownKeys: ReadonlyArray<string>,
): Record<string, unknown> {
  const next: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(stored))
    if (!knownKeys.includes(key)) next[key] = value
  for (const key of knownKeys)
    if (Object.hasOwn(edit, key)) next[key] = edit[key]
  return next
}

/** Slots in progress, by what they edit. */
export const useDraftSlots = create<{
  slots: Record<string, DraftSlot<unknown>>
  put: (key: string, slot: DraftSlot<unknown> | undefined) => void
}>()((set) => ({
  slots: {},
  put: (key, slot) => {
    if (slot && isDirty(slot)) watchUnload()
    set((state) => {
      if (state.slots[key] === slot) return state
      const slots = { ...state.slots }
      if (slot) slots[key] = slot
      else delete slots[key]
      return { slots }
    })
  },
}))

export interface SaveAnswer {
  /** The revision the writer gave the saved value. */
  base: string | null
}

/** A writer that refuses because the revision moved throws this; `current` is what it holds. */
export class RevisionMoved<T> extends Error {
  constructor(readonly current: { base: string | null; value: T }) {
    super('The saved version changed while you were editing.')
    this.name = 'RevisionMoved'
  }
}

/**
 * Saves the slot at `key` through `write`, then settles it by the rules above:
 * only the submitted revision is cleared, a failure or a moved revision keeps
 * the draft. Returns what happened, for the caller to show.
 */
export async function saveDraft<T>(
  key: string,
  write: (value: T, base: string | null) => Promise<SaveAnswer>,
): Promise<
  'saved' | 'saved-with-newer-edits' | 'conflict' | 'failed' | 'nothing'
> {
  const { slots, put } = useDraftSlots.getState()
  const slot = slots[key] as DraftSlot<T> | undefined
  if (!slot || !isDirty(slot) || slot.saving !== undefined) return 'nothing'
  const begun = beginSave(slot)
  put(key, begun.slot)
  try {
    const answer = await write(begun.submitted.value, begun.submitted.base)
    // Read the slot again: edits may have landed while the write was in flight.
    const live = useDraftSlots.getState().slots[key] as DraftSlot<T> | undefined
    if (!live) return 'saved'
    const settled = saveSucceeded(live, begun.submitted, answer.base)
    put(key, settled)
    return settled ? 'saved-with-newer-edits' : 'saved'
  } catch (error) {
    const live = useDraftSlots.getState().slots[key] as DraftSlot<T> | undefined
    if (!live) return 'failed'
    if (error instanceof RevisionMoved) {
      put(key, saveConflicted(live, error.current))
      return 'conflict'
    }
    put(
      key,
      saveFailed(live, error instanceof Error ? error.message : String(error)),
    )
    return 'failed'
  }
}
