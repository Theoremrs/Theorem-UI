// SOURCING: @tanstack/react-router search params (in Index mode the open view, item, collection and a record table's filter and sort are the /index URL; an Index view on any other page keeps a place of its own in React state), assistant-ui's composer (Ask Theorem drafts into the conversation, as the IDE frame does), the shell's mode navigation
import { useAui } from '@assistant-ui/react'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { createContext, useContext, useMemo, useState } from 'react'
import { focusComposer } from '@/components/chat/composer-references'
import { useOpenMode } from '@/components/shell/modes'
import type { Scope } from './contract'
import { indexSearch } from './search'
import type { IndexSearch, TableSearch } from './search'

export { indexSearch } from './search'
export type { IndexSearch, TableSearch } from './search'

/** Moves through the Index: a scope, a view in it, an item open beside it. */
export interface IndexNavigator {
  openHome: () => void
  openCollection: (collection: string) => void
  /**
   * A view belongs to a scope; opening it keeps the item that is open,
   * unless `closeItem` is set (a record's page has no preview beside it).
   */
  openView: (
    view: string,
    scope: Scope,
    options?: { closeItem?: boolean; replace?: boolean },
  ) => void
  openItem: (item: string) => void
  closeItem: () => void
  /** Changes the open table's filter or sort, in place of the current entry. */
  setTable: (patch: TableSearch) => void
}

/**
 * Where an Index view is: what it shows and how to move. Index mode's place
 * is the /index URL, which the panel beside the rail moves too; an Index view
 * placed on any other page keeps a place of its own.
 */
export interface IndexPlace {
  search: IndexSearch & { scope: Scope }
  navigate: IndexNavigator
}

const scopeOf = (search: IndexSearch): Scope =>
  search.collection
    ? { kind: 'collection', collectionId: search.collection }
    : { kind: 'home' }

function navigatorFor(
  go: (
    next: (prev: IndexSearch) => IndexSearch,
    options?: { replace?: boolean },
  ) => void,
): IndexNavigator {
  return {
    openHome: () => go(() => ({})),
    openCollection: (collection) => go(() => ({ collection })),
    openView: (view, scope, options) =>
      go((prev) => ({
        view,
        item: options?.closeItem ? undefined : prev.item,
        collection:
          scope.kind === 'collection' ? scope.collectionId : undefined,
      }), { replace: options?.replace }),
    openItem: (item) => go((prev) => ({ ...prev, item })),
    closeItem: () => go((prev) => ({ ...prev, item: undefined })),
    setTable: (patch) =>
      go((prev) => indexSearch({ ...prev, ...patch }), { replace: true }),
  }
}

/** The /index URL. Only inside the /index route. */
export function useIndexSearch(): IndexSearch & { scope: Scope } {
  const search = useSearch({ from: '/_chat/index' })
  return { ...search, scope: scopeOf(search) }
}

/** Moves the /index URL, from wherever it is called. */
export function useIndexNavigate(): IndexNavigator {
  const navigate = useNavigate()
  return useMemo(
    () =>
      navigatorFor(
        (search, options) =>
          void navigate({ to: '/index', search, replace: options?.replace }),
      ),
    [navigate],
  )
}

/** Index mode's place: the /index URL. Only inside the /index route. */
export function useUrlIndexPlace(): IndexPlace {
  return { search: useIndexSearch(), navigate: useIndexNavigate() }
}

/** A place of its own, starting at `start`. */
export function useLocalIndexPlace(start: IndexSearch): IndexPlace {
  const [search, setSearch] = useState<IndexSearch>(start)
  const navigate = useMemo(
    () => navigatorFor((next) => setSearch(next)),
    [],
  )
  return { search: { ...search, scope: scopeOf(search) }, navigate }
}

/**
 * The place the Index's columns read. Index mode provides the URL's; an Index
 * view on a page provides its own.
 */
export const IndexPlaceContext = createContext<IndexPlace | null>(null)

/** The place an Index column is in, when it is in one. */
export const useMaybeIndexPlace = () => useContext(IndexPlaceContext)

export function useIndexPlace(): IndexPlace {
  const place = useContext(IndexPlaceContext)
  if (!place) throw new Error('An Index column renders inside an IndexPlace')
  return place
}

/**
 * Ask Theorem: put a question about the material in the composer and put the
 * cursor there, staying put when the conversation shows (a page with one),
 * else going to Chat.
 */
export function useAskTheorem() {
  const aui = useAui()
  const openMode = useOpenMode()
  return (
    prompt: string,
    documents: { documentId: string; title?: string }[],
  ) => {
    const listed = documents.map(
      ({ documentId, title }) =>
        `- ${title ? `${title} ` : ''}(document ${documentId})`,
    )
    const text = [prompt, ...(listed.length ? ['', ...listed] : [])].join('\n')
    const draft = aui.composer.getState().text.trimEnd()
    aui.composer.setText(draft ? `${draft}\n\n${text}` : text)
    if (!focusComposer()) void openMode('chat')
  }
}
