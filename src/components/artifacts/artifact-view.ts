// SOURCING: zustand (view state for artifact panels; artifact content stays in thread messages, panel placement in the dockview layout)
import { createContext } from 'react'
import { create } from 'zustand'

/**
 * Where a conversation's artifacts open: in the dock's panels beside it, or
 * in the message itself when the conversation has no dock beside it.
 */
export const ArtifactPlacement = createContext<'panel' | 'inline'>('panel')

/**
 * The conversation a panel's artifact came from, set while that panel is kept open with another
 * chat on screen. An artifact's actions that write to its conversation (a scene's Ask and Fix)
 * read it so they never reach the chat on screen instead.
 */
export const ArtifactElsewhere = createContext<string | undefined>(undefined)

/** The desktop dock, which hosts each open artifact as its own panel. */
export type ArtifactDock = {
  open: (artifactId: string) => void
  expand: (artifactId: string) => void
  close: (artifactId: string) => void
  /** Records on the panel itself that it stays open across chats, so a saved layout keeps it. */
  kept: (artifactId: string, keep: boolean) => void
}

/**
 * One artifact view's choices (Unified Agent Experience AR-04..07). The three are separate:
 * following the current revision, the revision shown when not following, and whether the panel
 * stays open when the person changes chats. None of them is the artifact itself, which stays in
 * its conversation's messages.
 */
export type ArtifactViewState = {
  /** The conversation the artifact came from; undefined for a chat not saved yet. */
  threadId: string | undefined
  /** Shows the newest revision as it arrives. */
  follow: boolean
  /** The revision shown while not following. */
  revision: string | undefined
  /** Stays open when the person moves to another chat. */
  keep: boolean
}

type ArtifactView = {
  /** Focused artifact: the active artifact tab on desktop, the full-screen view on phones. */
  openId: string | undefined
  /** Each open artifact's view; an absent entry follows the latest revision. */
  views: Readonly<Record<string, ArtifactViewState>>
  /** The conversation on screen, which a new view belongs to. Set by the shell. */
  threadId: string | undefined
  /** Set while the desktop dock is mounted; phones show `openId` alone. */
  dock: ArtifactDock | undefined
  open: (artifactId: string, revision?: string) => void
  expand: (artifactId: string) => void
  /** Shows a revision and stops following; undefined follows the newest again. */
  select: (artifactId: string, revision: string | undefined) => void
  keep: (artifactId: string, keep: boolean) => void
  close: (artifactId: string) => void
  /** Records that the dock focused an artifact panel. */
  focused: (artifactId: string) => void
  /** Records that an artifact panel left the dock. */
  closed: (artifactId: string) => void
  /** A different conversation: every view not kept goes. */
  changedChat: (threadId: string | undefined) => void
  reset: () => void
}

const FOLLOWING = (threadId: string | undefined): ArtifactViewState => ({
  threadId,
  follow: true,
  revision: undefined,
  keep: false,
})

/** One shared value, so a store selector reading an unrecorded view returns the same object. */
const UNRECORDED: ArtifactViewState = Object.freeze(FOLLOWING(undefined))

/** The view an artifact shows with, whether or not one was recorded. */
export function viewOf(
  views: Readonly<Record<string, ArtifactViewState>>,
  artifactId: string,
): ArtifactViewState {
  return views[artifactId] ?? UNRECORDED
}

/** The revision a view shows: undefined while it follows the newest. */
export function shownRevision(view: ArtifactViewState): string | undefined {
  return view.follow ? undefined : view.revision
}

function withView(
  state: Pick<ArtifactView, 'views' | 'threadId'>,
  artifactId: string,
  change: (view: ArtifactViewState) => ArtifactViewState,
) {
  const current = state.views[artifactId] ?? FOLLOWING(state.threadId)
  return { views: { ...state.views, [artifactId]: change(current) } }
}

function showing(revision: string | undefined) {
  return (view: ArtifactViewState): ArtifactViewState =>
    revision === undefined
      ? { ...view, follow: true, revision: undefined }
      : { ...view, follow: false, revision }
}

function without(
  views: Readonly<Record<string, ArtifactViewState>>,
  artifactId: string,
) {
  const { [artifactId]: _, ...rest } = views
  return rest
}

export const useArtifactView = create<ArtifactView>()((set, get) => ({
  openId: undefined,
  views: {},
  threadId: undefined,
  dock: undefined,
  open: (artifactId, revision) => {
    set((s) => ({
      openId: artifactId,
      ...withView(s, artifactId, showing(revision)),
    }))
    get().dock?.open(artifactId)
  },
  expand: (artifactId) => {
    set({ openId: artifactId })
    get().dock?.expand(artifactId)
  },
  select: (artifactId, revision) =>
    set((s) => withView(s, artifactId, showing(revision))),
  keep: (artifactId, keep) => {
    set((s) => withView(s, artifactId, (view) => ({ ...view, keep })))
    get().dock?.kept(artifactId, keep)
  },
  close: (artifactId) => {
    const { dock, closed } = get()
    if (dock) dock.close(artifactId)
    else closed(artifactId)
  },
  focused: (artifactId) => set({ openId: artifactId }),
  closed: (artifactId) =>
    set((s) => ({
      openId: s.openId === artifactId ? undefined : s.openId,
      views: without(s.views, artifactId),
    })),
  changedChat: (threadId) =>
    set((s) => {
      const views = Object.fromEntries(
        Object.entries(s.views).filter(([, view]) => view.keep),
      )
      return {
        threadId,
        views,
        openId: s.openId && views[s.openId] ? s.openId : undefined,
      }
    }),
  reset: () => set({ openId: undefined, views: {}, threadId: undefined }),
}))
