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
  invoke,
  queryCollection,
  queryView,
  readReceipt,
  readRecordAnywhere,
} from '@/lib/capabilities/api'
import type { InvokeInput, RecordScanResume } from '@/lib/capabilities/api'
import {
  QUERY_LIMIT_DEFAULT,
  QUERY_LIMIT_MAX,
} from '@/lib/capabilities/contract'
import type {
  AuthorResult,
  CapabilityDefinition,
  DefinitionPatch,
  InvocationReceipt,
  QueryResult,
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
}

/** What this caller may see, listed once for a picker or a page's settings help. */
export function useCapabilityDiscover() {
  return useQuery({
    queryKey: [...capabilityKeys.all, 'discover'],
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
    // An absent cursor is the last page.
    getNextPageParam: (last: QueryResult) => last.nextCursor,
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

/**
 * One page over a collection, for a control that picks a record to reference.
 * A single page each: a picker reads a bounded slice and says so, rather than
 * walking a whole collection to fill a dropdown.
 */
export function useCapabilityPickers(
  instanceId: string | undefined,
  collectionKeys: ReadonlyArray<string>,
) {
  const joined = collectionKeys.join('\u0000')
  return useQuery({
    queryKey: [...capabilityKeys.instance(instanceId ?? ''), 'pickers', joined],
    queryFn: async () => {
      const pages = await Promise.all(
        collectionKeys.map((key) =>
          queryCollection(instanceId!, key, { limit: QUERY_LIMIT_MAX }),
        ),
      )
      return Object.fromEntries(
        collectionKeys.map((key, at) => [key, pages[at]!.records]),
      )
    },
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
