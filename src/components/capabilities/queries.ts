// SOURCING: @tanstack/react-query (server state over the capability contract: cursors as infinite
// queries, as components/work/queries.ts holds the tracker's pages), with every fetch in
// lib/capabilities/api. Nothing here calls a model; a click runs one declared action through the
// same route the agent uses.
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import {
  author,
  describe,
  discover,
  history,
  instantiateTemplate,
  invoke,
  invokeTargets,
  listTemplates,
  queryCollection,
  queryView,
  readReceipt,
  readRecordAnywhere,
  repin,
  saveTemplate,
} from '@/lib/capabilities/api'
import type { InvokeInput, RecordScanResume } from '@/lib/capabilities/api'
import {
  QUERY_LIMIT_DEFAULT,
  QUERY_LIMIT_MAX,
} from '@/lib/capabilities/contract'
import type {
  AuthorResult,
  CapabilityDefinition,
  DefinitionHistory,
  DefinitionPatch,
  InstantiateTemplateRequest,
  InvocationReceipt,
  QueryResult,
  SaveTemplateRequest,
} from '@/lib/capabilities/contract'
import { isSignedOut } from '@/lib/theorem/client'
import { isNotServed } from '@/lib/theorem/passthrough'

/** A signed-out caller or a Theorem that predates the contract is not retried. */
const retry = (failures: number, error: unknown) =>
  !isSignedOut(error) && !isNotServed(error) && failures < 1

export const capabilityKeys = {
  all: ['capabilities'] as const,
  /** Everything this instance's reads touches, so one write refreshes it all. */
  instance: (instanceId: string) =>
    [...capabilityKeys.all, instanceId] as const,
  describe: (instanceId: string) =>
    [...capabilityKeys.instance(instanceId), 'describe'] as const,
  rows: (instanceId: string, viewKey: string) =>
    [...capabilityKeys.instance(instanceId), 'rows', viewKey] as const,
  /** A record, by how it was asked for: a collection hint or a resumed scan is its own answer. */
  record: (
    instanceId: string,
    recordId: string,
    collectionKey = '',
    resume: RecordScanResume | undefined = undefined,
  ) =>
    [
      ...capabilityKeys.instance(instanceId),
      'record',
      recordId,
      collectionKey,
      resume ?? null,
    ] as const,
  discover: () => [...capabilityKeys.all, 'discover'] as const,
  /** Slice 2: under the instance, so an authoring write refreshes the history too. */
  history: (instanceId: string) =>
    [...capabilityKeys.instance(instanceId), 'history'] as const,
  /** Slice 2: the library's templates belong to no one instance. */
  templates: () => [...capabilityKeys.all, 'library', 'templates'] as const,
}

/** What this caller may see, listed once for a picker or a page's settings help. */
export function useCapabilityDiscover() {
  return useQuery({
    queryKey: capabilityKeys.discover(),
    queryFn: discover,
    staleTime: 60_000,
    retry,
  })
}

/**
 * One instance: its pinned definition, this caller's own grant, and the
 * resolved fields. The definition id it answers with is what an authoring patch
 * must name.
 */
export function useCapabilityDescribe(instanceId: string | undefined) {
  return useQuery({
    queryKey: capabilityKeys.describe(instanceId ?? ''),
    queryFn: () => describe(instanceId!),
    enabled: !!instanceId,
    staleTime: 30_000,
    retry,
  })
}

/** A view that answers with the cursor it was asked for would page in a loop. */
export class EchoedCursorError extends Error {
  constructor(readonly cursor: string) {
    super(
      'The view answered with the same page cursor it was asked for, so its next page cannot be read.',
    )
  }
}

/**
 * One view's rows, page by page. A switched view starts from no rows rather
 * than keeping the last view's: what a module selects and puts in context has
 * to be the rows of the view it names.
 */
export function useCapabilityRows(
  instanceId: string | undefined,
  viewKey: string | undefined,
  { enabled = true }: { enabled?: boolean } = {},
) {
  return useInfiniteQuery({
    queryKey: capabilityKeys.rows(instanceId ?? '', viewKey ?? ''),
    queryFn: async ({ pageParam }) => {
      const page = await queryView(instanceId!, viewKey!, {
        cursor: pageParam,
        limit: QUERY_LIMIT_DEFAULT,
      })
      if (pageParam !== undefined && page.nextCursor === pageParam)
        throw new EchoedCursorError(pageParam)
      return page
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last, _pages, _current, cursors) =>
      cursors.includes(last.nextCursor) ? undefined : last.nextCursor,
    enabled: enabled && !!instanceId && !!viewKey,
    staleTime: 10_000,
    retry,
  })
}

/**
 * Every loaded page of a view as one list, with what only the first page
 * carries: the total, and whether a filter or the page cut the rows down.
 */
export function flattenRows(data: { pages: QueryResult[] } | undefined) {
  const pages = data?.pages ?? []
  return {
    rows: pages.flatMap((page) => page.records),
    total: pages[0]?.total ?? 0,
    filtered: pages[0]?.filtered ?? false,
    truncated: pages[0]?.truncated ?? false,
    definitionId: pages[0]?.definitionId ?? '',
  }
}

type PickerCursors = Record<string, string | undefined>

/** Reference choices by collection. Read another page only when requested. */
export function useCapabilityPickers(
  instanceId: string | undefined,
  collectionKeys: ReadonlyArray<string>,
) {
  const initialPageParam: PickerCursors = Object.fromEntries(
    collectionKeys.map((key) => [key, undefined]),
  )
  return useInfiniteQuery({
    queryKey: [
      ...capabilityKeys.instance(instanceId ?? ''),
      'pickers',
      collectionKeys,
    ],
    queryFn: async ({ pageParam }) =>
      Object.fromEntries(
        await Promise.all(
          Object.entries(pageParam).map(
            async ([key, cursor]) =>
              [
                key,
                await queryCollection(instanceId!, key, {
                  limit: QUERY_LIMIT_MAX,
                  cursor,
                }),
              ] as const,
          ),
        ),
      ),
    initialPageParam,
    getNextPageParam: (
      last,
      _pages,
      _current,
      usedPages,
    ): PickerCursors | undefined => {
      const next = Object.entries(last).flatMap(([key, { nextCursor }]) =>
        nextCursor !== undefined &&
        !usedPages.some((used) => used[key] === nextCursor)
          ? [[key, nextCursor] as const]
          : [],
      )
      return next.length ? Object.fromEntries(next) : undefined
    },
    select: ({ pages }) =>
      Object.fromEntries(
        collectionKeys.map((key) => [
          key,
          [
            ...new Map(
              pages.flatMap((page) =>
                (page[key]?.records ?? []).map(
                  (record) => [record.id, record] as const,
                ),
              ),
            ).values(),
          ],
        ]),
      ),
    enabled: !!instanceId && collectionKeys.length > 0,
    staleTime: 30_000,
    retry,
  })
}

/**
 * The record a detail module shows: read by id through the record route, with
 * the collection that holds it. Absent, or withheld by its context policy,
 * answers null — the contract folds both into one code, and "not there" is an
 * answer, not a failure.
 */
export function useCapabilityRecord(
  instanceId: string | undefined,
  definition: CapabilityDefinition | undefined,
  recordId: string | undefined,
  collectionKey?: string | undefined,
  resume?: RecordScanResume,
) {
  return useQuery({
    queryKey: capabilityKeys.record(
      instanceId ?? '',
      recordId ?? '',
      collectionKey,
      resume,
    ),
    // A record that is not there answers null: React Query treats an undefined
    // result as a failed query, and "not there" is an answer, not a failure.
    queryFn: async () =>
      (await readRecordAnywhere(
        instanceId!,
        definition!,
        recordId!,
        collectionKey,
        resume,
      )) ?? null,
    enabled: !!instanceId && !!definition && !!recordId,
    staleTime: 10_000,
    retry,
  })
}

/** Run one declared action, then read the instance's rows again at their new revisions. */
export function useCapabilityInvoke() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (input: InvokeInput) => invoke(input),
    onSuccess: (receipt: InvocationReceipt) => {
      // A finished call has already moved the records it named: read them back
      // at the revisions the journal reports.
      if (receipt.status === 'finished' && receipt.instanceId)
        void client.invalidateQueries({
          queryKey: capabilityKeys.instance(receipt.instanceId),
        })
    },
  })
}

/**
 * Read a journaled call's receipt back. One that has finished has moved the
 * records it named, so the instance is read again exactly as after `invoke`.
 */
export function useCapabilityReceipt() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (at: { instanceId: string; recordId: string }) =>
      readReceipt(at.instanceId, at.recordId),
    onSuccess: (receipt: InvocationReceipt) => {
      if (receipt.status === 'finished' && receipt.instanceId)
        return client.invalidateQueries({
          queryKey: capabilityKeys.instance(receipt.instanceId),
        })
    },
  })
}

/**
 * Patch the pinned definition. A patch names the definition id it was authored
 * against, so a stale base is refused rather than applied over what changed.
 */
export function useCapabilityAuthor(instanceId: string | undefined) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (patch: DefinitionPatch) => author(instanceId!, patch),
    onSuccess: (result: AuthorResult) =>
      client.invalidateQueries({
        queryKey: capabilityKeys.instance(result.instance.instanceId),
      }),
  })
}

// ── Slice 2: history, re-pin, templates, multi-target invocation ────────────

/** The instance's definition history, newest first, page by page. */
export function useCapabilityHistory(
  instanceId: string | undefined,
  { enabled = true }: { enabled?: boolean } = {},
) {
  return useInfiniteQuery({
    queryKey: capabilityKeys.history(instanceId ?? ''),
    queryFn: ({ pageParam }) => history(instanceId!, { cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: DefinitionHistory) => last.nextCursor,
    enabled: enabled && !!instanceId,
    staleTime: 10_000,
    retry,
  })
}

/**
 * Re-pin the instance to an earlier definition. Views and actions change with
 * the pin; records never do, so the rows are read again only because a view
 * may now filter them differently.
 */
export function useCapabilityRepin(instanceId: string | undefined) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (definitionId: string) => repin(instanceId!, { definitionId }),
    onSuccess: (result: AuthorResult) =>
      client.invalidateQueries({
        queryKey: capabilityKeys.instance(result.instance.instanceId),
      }),
  })
}

/** The templates this caller may read. */
export function useCapabilityTemplates({
  enabled = true,
}: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: capabilityKeys.templates(),
    queryFn: listTemplates,
    enabled,
    staleTime: 30_000,
    retry,
  })
}

/** Save an instance's pinned definition as a template. */
export function useSaveCapabilityTemplate() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (request: SaveTemplateRequest) => saveTemplate(request),
    onSuccess: () =>
      client.invalidateQueries({ queryKey: capabilityKeys.templates() }),
  })
}

/** Bind a fresh instance from a template; the picker lists it afterwards. */
export function useInstantiateCapabilityTemplate() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({
      templateId,
      ...request
    }: InstantiateTemplateRequest & { templateId: string }) =>
      instantiateTemplate(templateId, request),
    onSuccess: () =>
      client.invalidateQueries({ queryKey: capabilityKeys.discover() }),
  })
}

/** One update action over several records, all or nothing; then the rows are read again. */
export function useCapabilityInvokeTargets() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (input: Parameters<typeof invokeTargets>[0]) =>
      invokeTargets(input),
    onSuccess: (receipt: InvocationReceipt) => {
      if (receipt.status === 'finished' && receipt.instanceId)
        void client.invalidateQueries({
          queryKey: capabilityKeys.instance(receipt.instanceId),
        })
    },
  })
}
