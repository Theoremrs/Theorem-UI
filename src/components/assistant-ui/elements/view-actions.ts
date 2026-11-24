// SOURCING: zustand's create, as composer-references keeps the composer's
// context. No library ties a reply's menu to the views drawn in that reply.
//
// What a reply's menu can do with the views drawn in it. A view has no chrome
// of its own, so saving and expanding live in the message's More menu; each
// view registers here under its message, and the menu acts on the one the
// person worked last.
import { create } from 'zustand'

export interface ViewActions {
  readonly save: () => void
  readonly expand: () => void
}

type Registered = { readonly id: string; readonly actions: ViewActions; touched: number }

type ViewActionsState = {
  byMessage: Readonly<Record<string, ReadonlyArray<Registered>>>
  register: (messageId: string, id: string, actions: ViewActions) => () => void
  touch: (messageId: string, id: string) => void
}

export const useViewActions = create<ViewActionsState>()((set) => ({
  byMessage: {},
  register: (messageId, id, actions) => {
    set((s) => ({
      byMessage: {
        ...s.byMessage,
        [messageId]: [
          ...(s.byMessage[messageId] ?? []).filter((view) => view.id !== id),
          { id, actions, touched: 0 },
        ],
      },
    }))
    return () =>
      set((s) => ({
        byMessage: {
          ...s.byMessage,
          [messageId]: (s.byMessage[messageId] ?? []).filter((view) => view.id !== id),
        },
      }))
  },
  touch: (messageId, id) =>
    set((s) => ({
      byMessage: {
        ...s.byMessage,
        [messageId]: (s.byMessage[messageId] ?? []).map((view) =>
          view.id === id ? { ...view, touched: Date.now() } : view,
        ),
      },
    })),
}))

/** The view a message's menu acts on: the one worked last, else the first. */
export function useMessageView(messageId: string): ViewActions | undefined {
  return useViewActions((s) => {
    const views = s.byMessage[messageId]
    if (!views?.length) return undefined
    return views.reduce((last, view) => (view.touched > last.touched ? view : last)).actions
  })
}
