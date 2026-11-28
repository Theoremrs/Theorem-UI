// SOURCING: assistant-ui ComposerPrimitive.TriggerPopover through the vendored registry element ComposerTriggerPopover in directive mode (the editor writes the pick at the caret and calls onInserted), with its TriggerAdapter and TriggerMatcher seams and the popover's scope context for the typed query; the composer's context references (./composer-references), which the runtime sends as the turn's contextReferences, kept in step with the composer's text (useAuiState) and its composer.send event, in a zustand store of the chips an @ added; the Index's items binding (q, the Index's own search) for documents and a bounded title search of the CRM's readable records of each declared type (useCrmRecordSearch, which leaves out types this sign-in cannot read); TanStack Query, with no earlier query's results kept for a later one
import {
  defaultDirectiveFormatter,
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
import { useQuery } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FC } from 'react'
import { ComposerTriggerPopover } from '@/components/assistant-ui/elements/composer-trigger-popover.aui'
import { BUILT_IN, builtInName } from '@/components/crm/model'
import type { BuiltIn } from '@/components/crm/model'
import { useCrmRecordSearch } from '@/components/crm/record-search'
import { recordReference } from '@/components/crm/reference'
import { BuiltInIcon, TypeIcon } from '@/components/crm/type-icons'
import { Icon } from '@/components/icons'
import * as indexApi from '@/components/index/api'
import type { IndexItem } from '@/components/index/contract'
import type { ObjectType, RecordRow } from '@/components/records/contract'
import { recordItemId, recordTitle } from '@/components/records/model'
import { useDataModel } from '@/components/records/queries'
import { create } from 'zustand'
import {
  decodeIdentity,
  encodeIdentity,
  toContextReference,
} from '@/lib/resources/mention'
import {
  search as searchResources,
  useResourceProviders,
} from '@/lib/resources/registry'
import type { SearchHit } from '@/lib/resources/provider'
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
 * A pick is written as assistant-ui's directive, `:record[Title]{name=item}`
 * or `:document[Title]{name=document:id}`: the composer and the sent message
 * show it as a chip of its title, and it names exactly the record or document
 * meant, however many share the title. The reference beside it is what
 * Theorem reads into the turn.
 */
export const MENTION_FORMATTER: DirectiveFormatter = defaultDirectiveFormatter

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
  cite: 'record' | 'document' | 'resource'
  objectType: string
  objectId: string
  /** For a pick from the provider registry: the identity token, which decodes to the resource. */
  token?: string
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
  if (cite?.cite === 'resource' && cite.token) {
    // A kind picked from the provider registry: the token carries the identity.
    const decoded = decodeIdentity(cite.token)
    return decoded.known
      ? toContextReference(decoded.resource, item.label)
      : undefined
  }
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

/**
 * A pick from a provider the registry holds. The directive's name is the
 * identity token, so the mention keeps exactly what it names whatever its
 * label says or whether the resource is still available.
 */
export const resourceMention = (hit: SearchHit): Mention => ({
  id: encodeIdentity(hit.ref.resource),
  type: 'resource',
  label: hit.title,
  metadata: {
    icon: 'record',
    kind: hit.typeLabel,
    cite: 'resource',
    token: encodeIdentity(hit.ref.resource),
    objectType: hit.ref.resource.kind,
    objectId: encodeIdentity(hit.ref.resource),
  },
})

/** These two have their own sources above; every other searchable provider is asked through the registry. */
const OWN_SOURCES = new Set(['theorem.records', 'theorem.documents'])

/**
 * Mentions for every other kind the provider registry can search (Work
 * items, conversations, files, extension kinds). With none registered it asks
 * nothing, and a group that failed or was bounded is reported, not hidden.
 */
function useRegistryMentions(q: string | undefined, open: boolean) {
  const providers = useResourceProviders((state) => state.providers)
  const ids = useMemo(
    () =>
      [...providers.values()]
        .filter((p) => p.support.search && !OWN_SOURCES.has(p.id))
        .map((p) => p.id),
    [providers],
  )
  const enabled = open && q !== undefined && ids.length > 0
  const result = useQuery({
    queryKey: ['resources', 'mention', q, ids.join(',')],
    queryFn: ({ signal }) =>
      searchResources({
        query: q ?? '',
        providerIds: ids,
        limit: MENTION_LIMIT,
        signal,
      }),
    enabled,
    staleTime: 10_000,
    retry: false,
  })
  const items = useMemo(
    () =>
      (result.data?.groups ?? []).flatMap((group) =>
        (group.page?.hits ?? []).slice(0, MENTION_LIMIT).map(resourceMention),
      ),
    [result.data],
  )
  const incomplete =
    enabled &&
    (result.isError ||
      (result.data?.groups.some((g) => g.status !== 'ok') ?? false))
  return {
    items,
    enabled,
    pending: enabled && result.isPending,
    incomplete,
    retry: result.refetch,
  }
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
 * The note under the list, which also reports the typed query: the popover's
 * scope holds it with the caret taken into account, and the Index searches
 * documents on Theorem rather than in what this page has loaded.
 */
function MentionNote({
  onQuery,
  failed,
  onRetry,
}: {
  onQuery: (query: string | undefined) => void
  /** Whether a record search failed, so an empty list is not an answer. */
  failed: boolean
  onRetry: () => void
}) {
  const { query } = unstable_useTriggerPopoverScopeContext()
  useEffect(() => onQuery(query), [onQuery, query])
  // Closing the list clears the query, so nothing is loaded while it is shut.
  useEffect(() => () => onQuery(undefined), [onQuery])
  return failed ? (
    <span role="alert">
      Some records could not be searched.{' '}
      <button
        type="button"
        className="underline"
        // Keep the caret in the message so the list stays open.
        onMouseDown={(event) => event.preventDefault()}
        onClick={onRetry}
      >
        Try again
      </button>
    </span>
  ) : null
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
  /** The words in the message: the pick's directive. */
  words: string
  /** Whether the message has held them yet: a chip goes only once they are gone. */
  seen: boolean
}

export const useMentionCites = create<{
  byKey: Readonly<Record<string, MentionCite>>
}>()(() => ({ byKey: {} }))

/**
 * The cites of conversations that are not showing, by conversation. `byKey`
 * is always the showing conversation's: switching puts its cites away and
 * brings the other's back, so one draft is never pruned by another's text.
 */
const setAside = new Map<string, Readonly<Record<string, MentionCite>>>()

/** Puts `from`'s cites away and brings back the ones `to` had. */
export function switchMentionConversation(from: string, to: string) {
  if (from === to) return
  const shown = useMentionCites.getState().byKey
  if (Object.keys(shown).length) setAside.set(from, shown)
  else setAside.delete(from)
  const back = setAside.get(to) ?? {}
  setAside.delete(to)
  useMentionCites.setState({ byKey: back })
}

/** The editor keeps Markdown, which escapes punctuation such as `_` in a title. */
const unescaped = (text: string) => text.replace(/\\([!-/:-@[-`{-~])/gu, '$1')

const WORD = /[\p{L}\p{N}_]/u

/**
 * Which cites still have their words in `plain`. Each cite takes its own
 * occurrence: the longest words claim theirs first and the characters are
 * used up, so one directive is never found inside another's, and two cites
 * with the same words need two.
 */
function presentMentions(
  plain: string,
  cites: Readonly<Record<string, MentionCite>>,
) {
  const present = new Set<string>()
  let rest = plain
  const keys = Object.keys(cites).sort(
    (a, b) => cites[b]!.words.length - cites[a]!.words.length,
  )
  for (const key of keys) {
    const { words } = cites[key]!
    for (
      let at = rest.indexOf(words);
      at >= 0;
      at = rest.indexOf(words, at + 1)
    ) {
      const before = rest.charAt(at - 1)
      const after = rest.charAt(at + words.length)
      if ((before && WORD.test(before)) || (after && WORD.test(after))) continue
      present.add(key)
      rest = `${rest.slice(0, at)}${'\u0000'.repeat(words.length)}${rest.slice(at + words.length)}`
      break
    }
  }
  return present
}

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
  const present = presentMentions(unescaped(text), cites)
  const kept: Record<string, MentionCite> = {}
  let changed = false
  for (const key of keys) {
    const cite = cites[key]!
    if (!held.has(key)) {
      changed = true
      continue
    }
    if (present.has(key)) {
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
  const conversation = useAuiState((state) => state.threads.mainThreadId)
  const shown = useRef(conversation)
  // A send takes its references with the turn and clears the text. Its event
  // arrives a microtask after the text is cleared, so an empty composer waits
  // a tick: a send forgets the chips first and they go with the turn, while
  // clearing everything by hand still removes them.
  useAuiEvent('composer.send', () => useMentionCites.setState({ byKey: {} }))
  useEffect(() => {
    // The text now is another conversation's draft: keep this one's cites
    // aside and judge the next text change against the right ones.
    if (shown.current !== conversation) {
      switchMentionConversation(shown.current, conversation)
      shown.current = conversation
      return
    }
    if (text.trim()) {
      pruneMentionCites(text)
      return
    }
    const timer = setTimeout(() => pruneMentionCites(text))
    return () => clearTimeout(timer)
  }, [text, conversation])
}

const DIRECTIVE = { formatter: MENTION_FORMATTER, onInserted: citeMention }

/**
 * The "@" list in the main composer: the person's saved records and Index
 * documents. A pick writes its directive into the message, shown as a chip
 * of the title, and adds the record or document to the turn's context, the
 * same reference "Ask about" adds, so Theorem reads it for the model when the
 * turn is sent. Deleting the directive removes the reference it added;
 * removing the reference leaves the directive in the message.
 */
export function ComposerMentionTrigger() {
  useMentionCitesFollowText()
  const [query, setQuery] = useState<string | undefined>(undefined)
  // The note is shown only while the list is open, so a query means open.
  const open = query !== undefined
  const model = useDataModel()
  const allTypes = model.data?.objectTypes
  const types = useMemo(
    () =>
      open && allTypes ? allTypes.filter((type) => !type.retired) : NO_TYPES,
    [open, allTypes],
  )
  // Undefined while shut, so opening waits for what was typed, not the last search.
  const q = useDebounced(query?.trim(), DEBOUNCE_MS)
  // A bounded search of titles, never every record of every type.
  const records = useCrmRecordSearch(types, q ?? '', open && q !== undefined)
  const documents = useQuery({
    queryKey: ['index', 'mention-documents', q],
    queryFn: () =>
      indexApi.runBinding({
        kind: 'items',
        query: { ...(q ? { q } : { sort: 'updated' }), limit: MENTION_LIMIT },
      }),
    enabled: open && q !== undefined,
    staleTime: 10_000,
    retry: false,
  })
  const documentItems = useMemo(
    () =>
      documents.data?.kind === 'items'
        ? documents.data.items.slice(0, MENTION_LIMIT).map(documentMention)
        : [],
    [documents.data],
  )
  const registry = useRegistryMentions(q, open)
  const failedRecords =
    open &&
    (types.some((t) => records.statusOf(t) === 'failed') || registry.incomplete)
  const adapter = useMemo<TriggerAdapter>(
    () => ({
      categories: () => [],
      categoryItems: () => [],
      // Documents and records were found for `q`; while the person has typed
      // on, they answer an earlier query and are not offered.
      search: (typed) =>
        typed.trim() === q
          ? [
              ...matchRecords(types, records.recordsOf, typed),
              ...documentItems,
              ...registry.items,
            ]
          : [],
    }),
    [types, records, documentItems, registry.items, q],
  )
  const loading =
    open &&
    (model.isPending ||
      query.trim() !== q ||
      documents.isPending ||
      registry.pending ||
      types.some((type) => records.statusOf(type) === 'pending'))
  const retryRecords = records.retryFailed
  const retryRegistry = registry.retry
  const registryIncomplete = registry.incomplete
  const retryFailed = useCallback(() => {
    retryRecords()
    if (registryIncomplete) void retryRegistry()
  }, [retryRecords, retryRegistry, registryIncomplete])
  const note = useMemo(
    () => (
      <MentionNote
        onQuery={setQuery}
        failed={failedRecords}
        onRetry={retryFailed}
      />
    ),
    [failedRecords, retryFailed],
  )
  return (
    <ComposerTriggerPopover
      char="@"
      adapter={adapter}
      matcher={mentionMatcher}
      isLoading={loading}
      directive={DIRECTIVE}
      note={note}
      iconMap={ICONS}
      itemTag={tagOf}
      emptyItemsLabel={
        failedRecords
          ? 'Some records could not be searched.'
          : documents.isError
            ? 'Documents could not be searched.'
            : 'No matching records or documents'
      }
      loadingLabel="Loading…"
    />
  )
}
