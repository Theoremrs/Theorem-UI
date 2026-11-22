// SOURCING: @tanstack/react-query and lib/theorem/passthrough (the response-styles routes of SPEC-THEOREM-RESPONSE-STYLES-1.0 section 7, which the vendored SDK has no client for yet), zustand (the pick made for a conversation that does not exist yet)
import {
  useMutation,
  useQuery,
  useQueryClient,
  queryOptions,
} from '@tanstack/react-query'
import type { QueryClient } from '@tanstack/react-query'
import { TheoremError } from '@theoremharness/sdk'
import { z } from 'zod'
import { create } from 'zustand'
import { mutate } from './client'
import { isNotServed, theoremJson } from './passthrough'

// ---------------------------------------------------------------------------
// Shapes (spec section 7)
// ---------------------------------------------------------------------------

/** Where a style or framework comes from: Theorem's own, or the person's. */
export type ResourceOrigin = 'shipped' | 'user'

/** What made a saved revision. The shipped baseline, revision 0, was never saved and has none. */
export type RevisionCause = 'edit' | 'restore' | 'reset' | 'duplicate'

export type ShippedInfo = {
  /** The shipped file's version, if its header names one. */
  version: string | null
  revisionId: string
  /** The shipped file changed since the person's override was made from it. */
  updateAvailable: boolean
}

type Resource = {
  id: string
  name: string
  description: string
  origin: ResourceOrigin
  /** 0 is the shipped baseline; a person's first save is 1. */
  revision: number
  /** `sha256:` over the stored text: the same content has the same identity everywhere. */
  revisionId: string
  updatedAtMs: number
  /** Null for a resource the person made. */
  shipped: ShippedInfo | null
}

/** A style as the catalog lists it: no body, no source. */
export type ResponseStyle = Resource & {
  kind: 'style'
  /** Framework ids this style offers the model. Candidates, not imports. */
  frameworks: string[]
}

export type ResponseStyleDetail = ResponseStyle & {
  body: string
  /** The Markdown file, header and all. */
  source: string
}

export type StyleLink = { id: string; name: string }

export type FrameworkReferenceSummary = {
  /** Relative to the framework's folder: `references/source-notes.md`. */
  path: string
  /** The reference's first heading. */
  title: string
}

export type FrameworkReference = FrameworkReferenceSummary & { body: string }

export type ResponseFramework = Resource & {
  kind: 'framework'
  references: FrameworkReferenceSummary[]
  /** The styles that list this framework. */
  usedBy: StyleLink[]
}

export type ResponseFrameworkDetail = Omit<ResponseFramework, 'references'> & {
  references: FrameworkReference[]
  body: string
  source: string
}

export type SelectionSource = 'conversation' | 'project' | 'account' | 'builtin'

/** One selection record: a default for the account, one per project, one per conversation. Null is unset. */
export type StyleSelection = {
  account: string | null
  project: string | null
  conversation: string | null
  /** What the next turn uses, and which of the four named it. */
  effective: { style: string; name: string; source: SelectionSource }
}

export type DecisionModel = { ref: string; name: string }

/** How the latest turn's ask to the decision model ended (spec section 6). */
export type SuggestionState =
  | 'skipped_no_model'
  | 'skipped_no_credential'
  | 'skipped_disabled'
  | 'suggested'
  | 'empty'
  | 'unavailable'

export type StyleSuggestions = {
  enabled: boolean
  state: 'ready' | 'no_model' | 'credential_missing' | 'disabled'
  /** The decision model in effect; null when there is none. */
  model: string | null
  modelSource: 'user' | 'operator' | 'shipped'
  /** The person's own pick: a ref, `none`, or null to inherit. */
  choice: string | null
  /** Decision models the person can pick. Empty when the list cannot be fetched. */
  models: DecisionModel[]
  last: { state: SuggestionState; code?: string; atMs: number } | null
}

export type ResponseStyleCatalog = {
  styles: ResponseStyle[]
  frameworks: ResponseFramework[]
  selection: StyleSelection
  suggestions: StyleSuggestions
}

export type RevisionSummary = {
  revision: number
  revisionId: string
  /** 0 for the shipped baseline, which was never saved. */
  savedAtMs: number
  /** Null for the shipped baseline; a resource the person made has no revision 0 row at all. */
  cause: RevisionCause | null
  name: string
}

/** Which conversation and project the selection is read for. */
export type StyleScope = { threadId?: string; projectId?: string }

export type StyleDraft = {
  name: string
  description: string
  body: string
  frameworks: string[]
}

export type FrameworkDraft = {
  name: string
  description: string
  body: string
  references: { path: string; body: string }[]
}

// ---------------------------------------------------------------------------
// The `response_style` part (spec section 8)
// ---------------------------------------------------------------------------

export type SuggestionCategory = 'framework' | 'tool' | 'delegation'

export type ResponseStylePart = {
  style: {
    id: string
    name: string
    revision: number
    revisionId: string
    source: SelectionSource
  }
  /** Only the frameworks the turn loaded. */
  frameworks: {
    id: string
    name: string
    revision: number
    revisionId: string
    references: string[]
  }[]
  suggestions?: {
    state: SuggestionState
    model?: string | null
    /** Only for `suggested`. `name` is what to call it; older answers carry only the id. */
    items?: {
      id: string
      category: SuggestionCategory
      name?: string
      relevance: number
    }[]
    /** Only for `unavailable`. */
    code?: string
  }
}

const SOURCES: readonly SelectionSource[] = [
  'conversation',
  'project',
  'account',
  'builtin',
]
const SUGGESTION_STATES: readonly SuggestionState[] = [
  'skipped_no_model',
  'skipped_no_credential',
  'skipped_disabled',
  'suggested',
  'empty',
  'unavailable',
]
const CATEGORIES: readonly SuggestionCategory[] = [
  'framework',
  'tool',
  'delegation',
]

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
const text = (value: unknown) => (typeof value === 'string' ? value : undefined)
const number = (value: unknown) =>
  typeof value === 'number' ? value : undefined

/**
 * The part as a message carries it, or undefined for anything that is not one.
 * Stored parts arrive as their payload and streamed parts as the whole flat
 * part, so the `type` key is neither required nor read.
 */
export function readResponseStyle(
  data: unknown,
): ResponseStylePart | undefined {
  const part = record(data)
  const style = record(part?.style)
  const id = text(style?.id)
  const name = text(style?.name)
  const source = SOURCES.find((candidate) => candidate === style?.source)
  if (!part || !style || id === undefined || name === undefined || !source)
    return undefined
  const frameworks = (
    Array.isArray(part.frameworks) ? part.frameworks : []
  ).flatMap((item): ResponseStylePart['frameworks'] => {
    const framework = record(item)
    const frameworkId = text(framework?.id)
    if (!framework || frameworkId === undefined) return []
    return [
      {
        id: frameworkId,
        name: text(framework.name) ?? frameworkId,
        revision: number(framework.revision) ?? 0,
        revisionId: text(framework.revisionId) ?? '',
        references: (Array.isArray(framework.references)
          ? framework.references
          : []
        ).flatMap((reference) =>
          typeof reference === 'string' ? [reference] : [],
        ),
      },
    ]
  })
  const asked = record(part.suggestions)
  const state = SUGGESTION_STATES.find(
    (candidate) => candidate === asked?.state,
  )
  const items = (Array.isArray(asked?.items) ? asked.items : []).flatMap(
    (
      item,
    ): NonNullable<NonNullable<ResponseStylePart['suggestions']>['items']> => {
      const suggestion = record(item)
      const category = CATEGORIES.find(
        (candidate) => candidate === suggestion?.category,
      )
      const itemId = text(suggestion?.id)
      if (!suggestion || !category || itemId === undefined) return []
      const itemName = text(suggestion.name)
      return [
        {
          id: itemId,
          category,
          ...(itemName ? { name: itemName } : {}),
          relevance: number(suggestion.relevance) ?? 0,
        },
      ]
    },
  )
  return {
    style: {
      id,
      name,
      revision: number(style.revision) ?? 0,
      revisionId: text(style.revisionId) ?? '',
      source,
    },
    frameworks,
    ...(asked && state
      ? {
          suggestions: {
            state,
            ...(asked.model === null || typeof asked.model === 'string'
              ? { model: asked.model }
              : {}),
            ...(state === 'suggested' ? { items } : {}),
            ...(state === 'unavailable' && text(asked.code)
              ? { code: text(asked.code) }
              : {}),
          },
        }
      : {}),
  }
}

// ---------------------------------------------------------------------------
// Resolution (spec section 3), mirrored so the picker can name what "Use my default" means
// ---------------------------------------------------------------------------

/** The style every selection falls back to. */
export const BUILTIN_STYLE_ID = 'theorem.style.default'

type Choices = Pick<StyleSelection, 'account' | 'project' | 'conversation'>

/**
 * The first of conversation, project, account that names a style that exists,
 * else the built-in. `without` leaves one out, which is how a conversation
 * that inherits finds what it inherits.
 */
export function resolveStyle(
  choices: Choices,
  styles: readonly { id: string; name: string }[],
  without?: keyof Choices,
): StyleSelection['effective'] {
  const order = ['conversation', 'project', 'account'] as const
  for (const source of order) {
    const id = source === without ? null : choices[source]
    const style = id
      ? styles.find((candidate) => candidate.id === id)
      : undefined
    if (style) return { style: style.id, name: style.name, source }
  }
  const builtin = styles.find((candidate) => candidate.id === BUILTIN_STYLE_ID)
  return {
    style: BUILTIN_STYLE_ID,
    name: builtin?.name ?? 'Default',
    source: 'builtin',
  }
}

/** What "Use my default" resolves to for these choices: the project's, else the account's, else the built-in. */
export const inheritedStyle = (
  choices: Choices,
  styles: readonly { id: string; name: string }[],
) => resolveStyle(choices, styles, 'conversation')

/** The catalog with one scope's choice changed and the effective style worked out again. */
export function withSelection(
  catalog: ResponseStyleCatalog,
  scope: keyof Choices,
  style: string | null,
): ResponseStyleCatalog {
  const choices = { ...catalog.selection, [scope]: style }
  return {
    ...catalog,
    selection: { ...choices, effective: resolveStyle(choices, catalog.styles) },
  }
}

// ---------------------------------------------------------------------------
// Problems
// ---------------------------------------------------------------------------

/** The stable `code` of an `application/problem+json` answer, if the error carries one. */
export function problemCode(error: unknown): string | undefined {
  if (!(error instanceof TheoremError)) return undefined
  const body = record(error.body)
  return text(body?.code)
}

/**
 * This Theorem predates response styles: the route is not served, which is a
 * 404 or 405 with no problem code at all. Any 404 that names a `code` is
 * Theorem answering: an unknown style or framework (`response_*`), or a
 * `threadId` or `projectId` the caller cannot access (`chat_resource_not_found`).
 */
export const isResponseStylesAbsent = (error: unknown) =>
  isNotServed(error) && problemCode(error) === undefined

/** A save lost the race: someone saved a newer revision first. Read it again and merge. */
export const isResponseStyleConflict = (error: unknown) =>
  error instanceof TheoremError &&
  (error.statusCode === 412 || problemCode(error) === 'response_style_changed')

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

const ROOT = '/api/chat/v1/response-styles'
const part = encodeURIComponent

/** Every response-styles query starts here, so one call reads them all again. */
export const responseStylesKey = ['theorem', 'response-styles'] as const
const catalogKey = (scope: StyleScope) =>
  [
    ...responseStylesKey,
    'catalog',
    scope.threadId ?? null,
    scope.projectId ?? null,
  ] as const

const retry = (count: number, error: unknown) =>
  !(error instanceof z.ZodError) && !isResponseStylesAbsent(error) && count < 2

/**
 * Styles, frameworks, the selection for this conversation and project, and the
 * suggestions setting. An older Theorem answers 404 or 405: see
 * `isResponseStylesAbsent`.
 */
// Validate the fields shared with the older output-style controls. Keep the
// full catalog intact for the editors, which use the rest of the contract.
const catalogSelection = z.object({
  styles: z.array(
    z.object({ id: z.string(), name: z.string(), description: z.string() }),
  ),
  selection: z.object({
    account: z.string().nullable(),
    conversation: z.string().nullable(),
    effective: z.object({
      style: z.string(),
      name: z.string(),
      source: z.string(),
    }),
  }),
})

export const responseStylesQuery = (scope: StyleScope = {}) =>
  queryOptions({
    queryKey: catalogKey(scope),
    queryFn: async () => {
      const search = new URLSearchParams()
      if (scope.threadId) search.set('threadId', scope.threadId)
      if (scope.projectId) search.set('projectId', scope.projectId)
      const query = search.size ? `?${search}` : ''
      const catalog = await theoremJson<ResponseStyleCatalog>(`${ROOT}${query}`)
      catalogSelection.parse(catalog)
      return catalog
    },
    staleTime: 30_000,
    retry,
  })

export const useResponseStyles = (scope?: StyleScope) =>
  useQuery(responseStylesQuery(scope))

// Some servers support choosing an output style but not the editing contract.
// Keep those catalogs usable by the picker, not by the settings editors.
const editorCatalog = z.object({
  selection: z.object({ project: z.string().nullable() }),
  styles: z.array(z.object({
    origin: z.enum(['shipped', 'user']),
    frameworks: z.array(z.string()),
  })),
  frameworks: z.array(z.object({
    id: z.string(),
    name: z.string(),
    description: z.string(),
    references: z.array(z.object({ path: z.string(), title: z.string() })),
    usedBy: z.array(z.object({ id: z.string(), name: z.string() })),
  })),
  suggestions: z.object({
    enabled: z.boolean(),
    models: z.array(z.object({ ref: z.string(), name: z.string() })),
    state: z.enum(['ready', 'no_model', 'credential_missing', 'disabled']),
    model: z.string().nullable(),
    choice: z.string().nullable(),
  }),
})

export const supportsResponseStyleEditing = (catalog: ResponseStyleCatalog) =>
  editorCatalog.safeParse(catalog).success

type Collection = 'styles' | 'frameworks'

const detailQuery = <T>(collection: Collection, id: string) =>
  queryOptions({
    queryKey: [...responseStylesKey, collection, id] as const,
    queryFn: () => theoremJson<T>(`${ROOT}/${collection}/${part(id)}`),
    retry,
  })

const revisionsQuery = (collection: Collection, id: string) =>
  queryOptions({
    queryKey: [...responseStylesKey, collection, id, 'revisions'] as const,
    queryFn: async () =>
      (
        await theoremJson<{ revisions: RevisionSummary[] }>(
          `${ROOT}/${collection}/${part(id)}/revisions`,
        )
      ).revisions,
    retry,
  })

const revisionQuery = <T>(
  collection: Collection,
  id: string,
  revision: number | 'shipped',
) =>
  queryOptions({
    queryKey: [
      ...responseStylesKey,
      collection,
      id,
      'revisions',
      revision,
    ] as const,
    queryFn: () =>
      theoremJson<T>(`${ROOT}/${collection}/${part(id)}/revisions/${revision}`),
    // A saved revision never changes. `shipped` names whatever Theorem ships
    // now, which a newer build replaces, so it is never answered from an
    // earlier read: a comparison shows the text a restore would write.
    ...(revision === 'shipped'
      ? { staleTime: 0, gcTime: 0 }
      : { staleTime: Infinity }),
    retry,
  })

/** One style with its body and source. */
export const styleQuery = (id: string) =>
  detailQuery<ResponseStyleDetail>('styles', id)
/** One framework with its body, source and references' bodies. */
export const frameworkQuery = (id: string) =>
  detailQuery<ResponseFrameworkDetail>('frameworks', id)
/** A style's saved revisions, newest first, the shipped baseline last. */
export const styleRevisionsQuery = (id: string) => revisionsQuery('styles', id)
export const frameworkRevisionsQuery = (id: string) =>
  revisionsQuery('frameworks', id)
/** A style as it was at one revision; `shipped` is the current baseline. */
export const styleRevisionQuery = (id: string, revision: number | 'shipped') =>
  revisionQuery<ResponseStyleDetail>('styles', id, revision)
export const frameworkRevisionQuery = (
  id: string,
  revision: number | 'shipped',
) => revisionQuery<ResponseFrameworkDetail>('frameworks', id, revision)

/** The hooks wait for an id: `undefined` reads nothing. */
export const useResponseStyle = (id: string | undefined) =>
  useQuery({ ...styleQuery(id ?? ''), enabled: Boolean(id) })
export const useResponseFramework = (id: string | undefined) =>
  useQuery({ ...frameworkQuery(id ?? ''), enabled: Boolean(id) })
export const useStyleRevisions = (id: string | undefined) =>
  useQuery({ ...styleRevisionsQuery(id ?? ''), enabled: Boolean(id) })
export const useFrameworkRevisions = (id: string | undefined) =>
  useQuery({ ...frameworkRevisionsQuery(id ?? ''), enabled: Boolean(id) })
export const useStyleRevision = (
  id: string | undefined,
  revision: number | 'shipped' | undefined,
) =>
  useQuery({
    ...styleRevisionQuery(id ?? '', revision ?? 'shipped'),
    enabled: Boolean(id) && revision !== undefined,
  })
export const useFrameworkRevision = (
  id: string | undefined,
  revision: number | 'shipped' | undefined,
) =>
  useQuery({
    ...frameworkRevisionQuery(id ?? '', revision ?? 'shipped'),
    enabled: Boolean(id) && revision !== undefined,
  })

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/** Every query reads again after a write, whether it worked or not: a refusal means the page was stale. */
const settle = (queryClient: QueryClient) => () =>
  queryClient.invalidateQueries({ queryKey: responseStylesKey })

/** Which revision a restore goes back to: a saved one, or the shipped baseline. */
export type RestoreTarget = number | 'shipped'

type Versioned = { id: string; revision: number }

/**
 * Save, delete and restore are the same three routes under `/styles` and
 * `/frameworks`. Each carries the revision the person was looking at as
 * `If-Match`; a stale one answers 412 (`isResponseStyleConflict`).
 */
function useResourceMutations<
  TDetail extends { id: string },
  TDraft extends object,
>(collection: Collection) {
  const queryClient = useQueryClient()
  const path = (id: string) => `${ROOT}/${collection}/${part(id)}`
  const keep = (saved: TDetail) =>
    queryClient.setQueryData(
      detailQuery<TDetail>(collection, saved.id).queryKey,
      saved,
    )
  const save = useMutation({
    mutationFn: ({ id, revision, ...draft }: Versioned & TDraft) =>
      mutate((headers) =>
        theoremJson<TDetail>(path(id), {
          method: 'PUT',
          body: draft,
          headers: { ...headers, 'If-Match': String(revision) },
        }),
      ),
    onSuccess: keep,
    onSettled: settle(queryClient),
  })
  const remove = useMutation({
    mutationFn: ({ id, revision }: Versioned) =>
      mutate((headers) =>
        theoremJson<void>(path(id), {
          method: 'DELETE',
          headers: { ...headers, 'If-Match': String(revision) },
        }),
      ),
    onSettled: settle(queryClient),
  })
  const restore = useMutation({
    mutationFn: ({ id, revision, to }: Versioned & { to: RestoreTarget }) =>
      mutate((headers) =>
        theoremJson<TDetail>(`${path(id)}/restore`, {
          method: 'POST',
          body: to === 'shipped' ? { shipped: true } : { revision: to },
          headers: { ...headers, 'If-Match': String(revision) },
        }),
      ),
    onSuccess: keep,
    onSettled: settle(queryClient),
  })
  return { save, remove, restore, queryClient }
}

export type CreateStyleInput = Partial<StyleDraft> & {
  /** Duplicate this style: the fields left out are copied from it. */
  from?: string
}

export type CreateFrameworkInput = Partial<FrameworkDraft> & {
  /** Duplicate this framework: the fields left out are copied from it. */
  from?: string
  /**
   * Make the copy for this style: the style is rewritten in the same step to
   * list the copy instead of `from`, so editing it does not change the other
   * styles that share the original.
   */
  forStyle?: string
}

/** What creating a framework returns; `style` only when `forStyle` rewrote one. */
export type CreatedFramework = {
  framework: ResponseFrameworkDetail
  style?: ResponseStyleDetail
}

/**
 * Create (or duplicate), save, delete and restore for styles.
 *
 * - `create.mutate({ from, name })` duplicates; with no `from` it makes a new
 *   style from the fields given. Resolves to the new style.
 * - `save.mutate({ id, revision, name, description, body, frameworks })`
 *   resolves to the style at its new revision.
 * - `remove.mutate({ id, revision })` deletes a style the person made; a
 *   shipped one answers 409 `response_style_shipped`.
 * - `restore.mutate({ id, revision, to })` writes a new revision holding an
 *   older one's content (`to` a number) or the shipped baseline's (`'shipped'`).
 */
export function useStyleMutations() {
  const { save, remove, restore, queryClient } = useResourceMutations<
    ResponseStyleDetail,
    StyleDraft
  >('styles')
  const creation = useMutation({
    mutationFn: (input: CreateStyleInput) =>
      mutate((headers) =>
        theoremJson<ResponseStyleDetail>(`${ROOT}/styles`, {
          method: 'POST',
          body: input,
          headers,
        }),
      ),
    onSuccess: (created) =>
      queryClient.setQueryData(styleQuery(created.id).queryKey, created),
    onSettled: settle(queryClient),
  })
  return { create: creation, save, remove, restore }
}

/** The same four for frameworks. `create` resolves to `{ framework, style? }`. */
export function useFrameworkMutations() {
  const { save, remove, restore, queryClient } = useResourceMutations<
    ResponseFrameworkDetail,
    FrameworkDraft
  >('frameworks')
  const creation = useMutation({
    mutationFn: (input: CreateFrameworkInput) =>
      mutate((headers) =>
        theoremJson<CreatedFramework>(`${ROOT}/frameworks`, {
          method: 'POST',
          body: input,
          headers,
        }),
      ),
    onSuccess: ({ framework, style }) => {
      queryClient.setQueryData(frameworkQuery(framework.id).queryKey, framework)
      if (style) queryClient.setQueryData(styleQuery(style.id).queryKey, style)
    },
    onSettled: settle(queryClient),
  })
  return { create: creation, save, remove, restore }
}

export type SelectionScope = 'conversation' | 'project' | 'account'

export type SelectionChange = {
  scope: SelectionScope
  /** A style id, or null for "Use my default": the scope inherits. */
  style: string | null
  /** Required for `conversation`. */
  threadId?: string
  /** Required for `project`. */
  projectId?: string
}

/**
 * Shows a choice in every catalog it reaches, before they are read again: a
 * conversation's is read by the catalogs for that thread, whatever project
 * they were asked for with, and a project's by those for that project.
 */
const showSelection = (
  queryClient: QueryClient,
  { scope, style, threadId, projectId }: SelectionChange,
) =>
  queryClient.setQueriesData<ResponseStyleCatalog>(
    {
      queryKey: [...responseStylesKey, 'catalog'],
      predicate: ({ queryKey: [, , , thread, project] }) =>
        scope === 'account' ||
        (scope === 'conversation'
          ? thread === (threadId ?? null)
          : project === (projectId ?? null)),
    },
    (old) => (old ? withSelection(old, scope, style) : old),
  )

/** The tail of each scope's write queue. Different conversations and projects can write independently. */
const choiceWrites = new Map<string, Promise<void>>()

const choiceKey = ({ scope, projectId, threadId }: Omit<SelectionChange, 'style'>) =>
  scope === 'conversation'
    ? `conversation:${threadId}`
    : scope === 'project'
      ? `project:${projectId}`
      : 'account'

/**
 * Resolves once no choice for this conversation is still being written,
 * whether Theorem kept it or refused it. A turn waits on this before it
 * starts, so a style picked a moment before Send is the one the turn uses.
 */
export async function conversationStyleSettled(threadId: string) {
  const key = choiceKey({ scope: 'conversation', threadId })
  for (let write = choiceWrites.get(key); write; write = choiceWrites.get(key))
    await write
}

/**
 * Sets or clears one scope's choice. The catalogs it reaches show it at once;
 * every query reads again after.
 */
export function useSelectionMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (change: SelectionChange) => {
      const key = choiceKey(change)
      const save = async () => {
        const threadId =
          change.scope === 'conversation' ? change.threadId : undefined
        const held = threadId
          ? usePendingStyle.getState().held[threadId]
          : undefined
        const selection = await mutate((headers) =>
          theoremJson<StyleSelection>(`${ROOT}/selection`, {
            method: 'PUT',
            body: change,
            headers,
          }),
        )
        // Keep the first-send pick if the server refuses its replacement.
        const picks = usePendingStyle.getState()
        if (threadId && held && picks.held[threadId] === held)
          picks.chooseHeld(threadId, undefined)
        showSelection(queryClient, change)
        return selection
      }
      // Persist picks to the same scope in the order made. Waiting on just
      // the latest request would let an older request overwrite that pick.
      const previous = choiceWrites.get(key)
      const write = previous ? previous.then(save) : save()
      const done = () => {
        if (choiceWrites.get(key) === settled) choiceWrites.delete(key)
      }
      const settled = write.then(done, done)
      choiceWrites.set(key, settled)
      return write
    },
    onSettled: settle(queryClient),
  })
}

export type SuggestionsChange = {
  enabled?: boolean
  /** A decision model ref, `none`, or null to inherit the operator's or the shipped default. */
  model?: string | null
}

/** Turns suggestions on or off and picks the decision model. A ref that is not `openrouter/...`, or not one of the listed models when any are listed, answers 422 `response_style_invalid`. */
export function useSuggestionsMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (change: SuggestionsChange) =>
      mutate((headers) =>
        theoremJson<StyleSuggestions>(`${ROOT}/suggestions`, {
          method: 'PUT',
          body: change,
          headers,
        }),
      ),
    // The setting is the person's, not a conversation's: every catalog shows it.
    onSuccess: (suggestions) =>
      queryClient.setQueriesData<ResponseStyleCatalog>(
        { queryKey: [...responseStylesKey, 'catalog'] },
        (old) => (old ? { ...old, suggestions } : old),
      ),
    onSettled: settle(queryClient),
  })
}

export type PreviewVariant = { label: string } & (
  { style: { id: string; revision?: number } } | { draft: StyleDraft }
)

export type PreviewRequest = {
  question: string
  /** Supplied to every variant alike. */
  context?: string
  /** One variant, or two to compare. */
  variants: [PreviewVariant] | [PreviewVariant, PreviewVariant]
}

export type PreviewResult = {
  /** Always true: the text is a model's, not a recorded answer. */
  generated: true
  /** The chat model that wrote it. */
  model: string
  variants: { label: string; text: string }[]
}

/** Answers a sample question under one or two variants. Runs no tool, research or delegation; 503 `response_preview_unavailable` when no chat model is usable. */
export const usePreviewMutation = () =>
  useMutation({
    mutationFn: (request: PreviewRequest) =>
      mutate((headers) =>
        theoremJson<PreviewResult>(`${ROOT}/preview`, {
          method: 'POST',
          body: request,
          headers,
        }),
      ),
  })

export type DraftRequest = {
  kind: 'style' | 'framework'
  current: { name: string; description: string; body: string }
  /** The change, in plain language. */
  instruction: string
}

export type DraftResult = {
  draft: { name: string; description: string; body: string }
  model: string
}

/** Proposes a change to a style or framework from an instruction. Saves nothing; the person reviews the difference. 503 `response_draft_unavailable` when no chat model is usable; 502 `response_draft_failed` or `response_draft_unparseable` when the model's answer cannot be used. */
export const useDraftMutation = () =>
  useMutation({
    mutationFn: (request: DraftRequest) =>
      mutate((headers) =>
        theoremJson<DraftResult>(`${ROOT}/draft`, {
          method: 'POST',
          body: request,
          headers,
        }),
      ),
  })

// ---------------------------------------------------------------------------
// A conversation that has not had its first message
// ---------------------------------------------------------------------------

type PendingStyle = {
  /** The style picked for each new conversation, keyed by its local draft id. */
  drafts: Readonly<Record<string, string>>
  /**
   * Picks for newly created conversations that have had no message accepted
   * yet, by thread id. A refused first message leaves its pick here, so the
   * next attempt on that conversation still carries it.
   */
  held: Readonly<Record<string, string>>
  chooseDraft: (localId: string, styleId: string | undefined) => void
  chooseHeld: (threadId: string, styleId: string | undefined) => void
}

const withPick = (
  picks: Readonly<Record<string, string>>,
  key: string,
  styleId: string | undefined,
) => ({
  ...Object.fromEntries(Object.entries(picks).filter(([id]) => id !== key)),
  ...(styleId ? { [key]: styleId } : {}),
})

/**
 * The composer on `/` has no thread to hold a choice, so it is held here until
 * a message goes out with it as `responseStyle` and is accepted.
 */
export const usePendingStyle = create<PendingStyle>()((set) => ({
  drafts: {},
  held: {},
  chooseDraft: (localId, styleId) =>
    set((s) => ({ drafts: withPick(s.drafts, localId, styleId) })),
  chooseHeld: (threadId, styleId) =>
    set((s) => ({ held: withPick(s.held, threadId, styleId) })),
}))

/**
 * Thread creation moves only this draft's pick to its durable conversation.
 * Other drafts can be edited while the request is in flight.
 */
export function holdPendingStyle(localId: string, threadId: string) {
  usePendingStyle.setState((s) => {
    const styleId = s.drafts[localId]
    return styleId
      ? {
          drafts: withPick(s.drafts, localId, undefined),
          held: withPick(s.held, threadId, styleId),
        }
      : s
  })
}

/**
 * The send option for the message in hand: the pick held for its conversation.
 * Read when the message is sent, so a change made while typing is the one that
 * goes, and a message sent again after a refusal carries it again.
 */
export function styleTurnOptions(threadId: string): {
  responseStyle?: string
} {
  const styleId = usePendingStyle.getState().held[threadId]
  return styleId ? { responseStyle: styleId } : {}
}

/**
 * A message was accepted with this pick, so the conversation holds it now: the
 * pick is spent, and the catalogs read for the conversation say what it chose.
 */
export function consumePendingStyle(
  threadId: string,
  sent: string | undefined,
  queryClient?: QueryClient,
) {
  if (!sent) return
  usePendingStyle.setState((s) =>
    s.held[threadId] === sent
      ? { held: withPick(s.held, threadId, undefined) }
      : s,
  )
  if (!queryClient) return
  showSelection(queryClient, { scope: 'conversation', threadId, style: sent })
  void settle(queryClient)()
}
