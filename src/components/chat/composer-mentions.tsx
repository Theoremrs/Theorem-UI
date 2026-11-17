// SOURCING: assistant-ui ComposerPrimitive.TriggerPopover through the vendored registry element ComposerTriggerPopover in directive mode (the editor writes the pick at the caret and calls onInserted), with its TriggerAdapter and TriggerMatcher seams and the popover's scope context for the typed query; the composer's context references (./composer-references), which the runtime sends as the turn's contextReferences, kept in step with the composer's text (useAuiState) and its composer.send event, in a zustand store of the chips an @ added; the Index's items binding (q, the Index's own search) for documents and the CRM's readable records of each declared type (useCrmRecordsOf, which leaves out types this sign-in cannot read); TanStack Query keepPreviousData
import {
  unstable_useTriggerPopoverScopeContext,
  useAuiEvent,
  useAuiState,
} from '@assistant-ui/react'
import type {
  DirectiveFormatter,
  TriggerAdapter,
  TriggerItem,
  TriggerMatcher,
} from '@assistant-ui/react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import type { FC } from 'react'
import { ComposerTriggerPopover } from '@/components/assistant-ui/elements/composer-trigger-popover.aui'
import { BUILT_IN, builtInName } from '@/components/crm/model'
import type { BuiltIn } from '@/components/crm/model'
import { useCrmRecordsOf } from '@/components/crm/queries'
import { recordReference } from '@/components/crm/reference'
import { BuiltInIcon, TypeIcon } from '@/components/crm/type-icons'
import { Icon } from '@/components/icons'
import * as indexApi from '@/components/index/api'
import type { IndexItem } from '@/components/index/contract'
import type { ObjectType, RecordRow } from '@/components/records/contract'
import { recordItemId, recordTitle } from '@/components/records/model'
import { useDataModel } from '@/components/records/queries'
import { create } from 'zustand'
import { referenceKey, useComposerReferences } from './composer-references'
import type { ComposerReference } from './composer-references'

/** At most this many of each kind are offered, records first. */
export const MENTION_LIMIT = 5

/** An at sign that starts the text or follows a space, up to the caret: not an email address. */
const AT = /(?:^|\s)@([^\s@]*)$/u

/** Opens on an at sign the way the default detection does, but not inside a word such as an email address. */
export const mentionMatcher: TriggerMatcher = (text, _char, cursor) => {
  const query = AT.exec(text.slice(0, cursor))?.[1]
  if (query === undefined) return null
  return { query, offset: cursor - query.length - 1, endOffset: cursor }
}

/**
 * A pick reads `@Title` in the message, so what the person wrote still says
 * who or what they meant; the reference beside it is what Theorem reads.
 */
export const MENTION_FORMATTER: DirectiveFormatter = {
  serialize: (item) => `@${item.label}`,
  parse: (text) => [{ kind: 'text', text }],
}

/** How well `title` answers `query`: lower is better, undefined is no match. */
export function mentionRank(title: string, query: string): number | undefined {
  const q = query.trim().toLowerCase()
  if (!q) return 2
  const t = title.toLowerCase()
  if (t.startsWith(q)) return 0
  if (t.split(/[\s\-_.,]+/u).some((word) => word.startsWith(q))) return 1
  return t.includes(q) ? 2 : undefined
}

/** What a pick cites, kept as plain values: an item's metadata is JSON. */
type Cite = {
  icon: string
  kind: string
  cite: 'record' | 'document'
  objectType: string
  objectId: string
}

type Mention = TriggerItem & { metadata: Cite }

const recordMention = (
  type: ObjectType,
  id: string,
  title: string,
): Mention => ({
  id: recordItemId(type, id),
  type: 'record',
  label: title,
  metadata: {
    icon: builtInName(type) ?? 'record',
    kind: type.label_singular,
    cite: 'record',
    objectType: type.name_singular,
    objectId: id,
  },
})

const documentMention = (item: IndexItem): Mention => ({
  id: `document:${item.documentId}`,
  type: 'document',
  label: item.title || item.documentId,
  metadata: {
    icon: 'document',
    kind: 'Document',
    cite: 'document',
    objectType: item.documentKind,
    objectId: item.documentId,
  },
})

/**
 * The context reference a pick adds: a saved record by its type's singular
 * name, or an Index document as a graph object. Theorem reads either when the
 * turn is sent; a document is read as it is then, so no revision is pinned.
 */
export function mentionReference(
  item: TriggerItem,
): ComposerReference | undefined {
  const cite = item.metadata as Partial<Cite> | undefined
  if (!cite?.objectId || !cite.objectType) return undefined
  if (cite.cite === 'record')
    return recordReference(cite.objectType, cite.objectId, item.label)
  if (cite.cite === 'document')
    return {
      location: {
        resource: {
          kind: 'graph-object',
          objectId: cite.objectId,
          objectType: cite.objectType,
        },
      },
      label: item.label,
    }
  return undefined
}

/** The records offered for `query`, best first, from the types this sign-in reads. */
export function matchRecords(
  types: readonly ObjectType[],
  recordsOf: (type: ObjectType) => readonly RecordRow[],
  query: string,
  limit = MENTION_LIMIT,
): Mention[] {
  const ranked: { rank: number; mention: Mention }[] = []
  for (const type of types)
    for (const record of recordsOf(type)) {
      const title = recordTitle(type, record) || record.id
      const rank = mentionRank(title, query)
      if (rank !== undefined)
        ranked.push({ rank, mention: recordMention(type, record.id, title) })
    }
  return ranked
    .sort(
      (a, b) =>
        a.rank - b.rank || a.mention.label.localeCompare(b.mention.label),
    )
    .slice(0, limit)
    .map(({ mention }) => mention)
}

const DEBOUNCE_MS = 150

function useDebounced<T>(value: T, ms: number) {
  const [held, setHeld] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setHeld(value), ms)
    return () => clearTimeout(timer)
  }, [value, ms])
  return held
}

/**
 * The line above the list, which also reports the typed query: the popover's
 * scope holds it with the caret taken into account, and the Index searches
 * documents on Theorem rather than in what this page has loaded.
 */
function MentionHeading({
  onQuery,
}: {
  onQuery: (query: string | undefined) => void
}) {
  const { query } = unstable_useTriggerPopoverScopeContext()
  useEffect(() => onQuery(query), [onQuery, query])
  // Closing the list clears the query, so nothing is loaded while it is shut.
  useEffect(() => () => onQuery(undefined), [onQuery])
  return <>Records and documents</>
}

const markOf =
  (name: BuiltIn): FC<{ className?: string }> =>
  ({ className }) => <BuiltInIcon name={name} className={className} />

const ICONS: Record<string, FC<{ className?: string }>> = {
  ...Object.fromEntries(BUILT_IN.map((name) => [name, markOf(name)])),
  record: ({ className }) => (
    <TypeIcon type={undefined} className={className} />
  ),
  document: ({ className }) => <Icon.File className={className} />,
}

const tagOf = (item: TriggerItem) =>
  typeof item.metadata?.kind === 'string' ? item.metadata.kind : undefined

const NO_TYPES: ObjectType[] = []

/**
 * The references an "@" added, by reference key, with the words that cite
 * them. A reference something else added first ("Ask about", a page) is not
 * one of them, so deleting words never takes away a chip they did not make.
 */
type MentionCite = {
  /** The words in the message, `@Title`. */
  words: string
  /** Whether the message has held them yet: a chip goes only once they are gone. */
  seen: boolean
}

export const useMentionCites = create<{
  byKey: Readonly<Record<string, MentionCite>>
}>()(() => ({ byKey: {} }))

/** The editor keeps Markdown, which escapes punctuation such as `_` in a title. */
const unescaped = (text: string) => text.replace(/\\([!-/:-@[-`{-~])/gu, '$1')

/** Adds the picked record or document to the turn's context. */
export function citeMention(item: TriggerItem) {
  const reference = mentionReference(item)
  if (!reference) return
  const key = referenceKey(reference)
  const references = useComposerReferences.getState()
  const held = references.references.some((r) => referenceKey(r) === key)
  const cites = useMentionCites.getState().byKey
  if (!held || cites[key] !== undefined)
    useMentionCites.setState({
      byKey: {
        ...cites,
        [key]: { words: MENTION_FORMATTER.serialize(item), seen: false },
      },
    })
  references.add(reference)
}

/**
 * Removes each chip an "@" added once its words are gone from the message,
 * and forgets a chip the person removed themselves. The words and the chip
 * are one citation: deleting either deletes it.
 */
export function pruneMentionCites(text: string) {
  const cites = useMentionCites.getState().byKey
  const keys = Object.keys(cites)
  if (!keys.length) return
  const { references, remove } = useComposerReferences.getState()
  const held = new Set(references.map(referenceKey))
  const plain = unescaped(text)
  const kept: Record<string, MentionCite> = {}
  let changed = false
  for (const key of keys) {
    const cite = cites[key]!
    if (!held.has(key)) {
      changed = true
      continue
    }
    if (plain.includes(cite.words)) {
      kept[key] = cite.seen ? cite : { ...cite, seen: true }
      changed ||= !cite.seen
    } else if (cite.seen) {
      remove(key)
      changed = true
    } else kept[key] = cite
  }
  if (changed) useMentionCites.setState({ byKey: kept })
}

/** Keeps the chips an "@" added in step with the composer's text. */
function useMentionCitesFollowText() {
  const text = useAuiState((state) => state.composer.text)
  // A send takes its references with the turn and clears the text. Its event
  // arrives a microtask after the text is cleared, so an empty composer waits
  // a tick: a send forgets the chips first and they go with the turn, while
  // clearing everything by hand still removes them.
  useAuiEvent('composer.send', () => useMentionCites.setState({ byKey: {} }))
  useEffect(() => {
    if (text.trim()) {
      pruneMentionCites(text)
      return
    }
    const timer = setTimeout(() => pruneMentionCites(text))
    return () => clearTimeout(timer)
  }, [text])
}

const DIRECTIVE = { formatter: MENTION_FORMATTER, onInserted: citeMention }

/**
 * The "@" list in the main composer: the person's saved records and Index
 * documents. A pick writes `@Title` into the message and adds the record or
 * document to the turn's context, the same reference "Ask about" adds, so
 * Theorem reads it for the model when the turn is sent. Deleting the words
 * removes the chip they added; removing the chip leaves the words as text.
 */
export function ComposerMentionTrigger() {
  useMentionCitesFollowText()
  const [query, setQuery] = useState<string | undefined>(undefined)
  // The heading is shown only while the list is open, so a query means open.
  const open = query !== undefined
  const model = useDataModel()
  const allTypes = model.data?.objectTypes
  const types = useMemo(
    () =>
      open && allTypes ? allTypes.filter((type) => !type.retired) : NO_TYPES,
    [open, allTypes],
  )
  const records = useCrmRecordsOf(types)
  // Undefined while shut, so opening waits for what was typed, not the last search.
  const q = useDebounced(query?.trim(), DEBOUNCE_MS)
  const documents = useQuery({
    queryKey: ['index', 'mention-documents', q],
    queryFn: () =>
      indexApi.runBinding({
        kind: 'items',
        query: { ...(q ? { q } : { sort: 'updated' }), limit: MENTION_LIMIT },
      }),
    enabled: open && q !== undefined,
    staleTime: 10_000,
    placeholderData: keepPreviousData,
    retry: false,
  })
  const documentItems = useMemo(
    () =>
      documents.data?.kind === 'items'
        ? documents.data.items.slice(0, MENTION_LIMIT).map(documentMention)
        : [],
    [documents.data],
  )
  const adapter = useMemo<TriggerAdapter>(
    () => ({
      categories: () => [],
      categoryItems: () => [],
      search: (typed) => [
        ...matchRecords(types, records.recordsOf, typed),
        ...documentItems,
      ],
    }),
    [types, records, documentItems],
  )
  const loading =
    open &&
    (model.isPending ||
      documents.isPending ||
      types.some((type) => records.statusOf(type) === 'pending'))
  const heading = useMemo(() => <MentionHeading onQuery={setQuery} />, [])
  return (
    <ComposerTriggerPopover
      char="@"
      adapter={adapter}
      matcher={mentionMatcher}
      isLoading={loading}
      directive={DIRECTIVE}
      heading={heading}
      iconMap={ICONS}
      itemTag={tagOf}
      itemLabelClassName="text-sm"
      emptyItemsLabel={
        documents.isError
          ? 'Documents could not be searched.'
          : 'No matching records or documents'
      }
      loadingLabel="Loading…"
      className="w-md"
    />
  )
}
