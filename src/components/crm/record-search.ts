// SOURCING: @tanstack/react-query useQueries (one bounded read per readable type, through ./api searchRecords), the CRM's life context for what this sign-in may read (./queries useLifeContext, ./model accessFor), and the Records model's identifierField for the field a record is titled by
import { useQueries } from '@tanstack/react-query'
import { useMemo } from 'react'
import type { ObjectType } from '@/components/records/contract'
import { identifierField } from '@/components/records/model'
import { isSignedOut } from '@/lib/theorem/client'
import { RecordAccessError, searchRecords } from './api'
import type { CrmRecord } from './api'
import { accessFor } from './model'
import { useLifeContext } from './queries'
import type { RecordsStatus } from './queries'

const NO_RECORDS: CrmRecord[] = []

/** A refusal is an answer; only an unexplained failure is tried once more. */
const retry = (failures: number, error: unknown) =>
  !isSignedOut(error) && !(error instanceof RecordAccessError) && failures < 1

/**
 * Records of `types` whose titles may match `query`, at most a bounded page
 * per type. A type this sign-in cannot read is not asked for. Results are
 * keyed by the query, so records found for an earlier query are never shown
 * for this one. `types` must keep its identity between renders; `enabled`
 * false reads nothing.
 */
export function useCrmRecordSearch(
  types: ObjectType[],
  query: string,
  enabled = true,
) {
  const life = useLifeContext().data
  const results = useQueries({
    queries: types.map((type) => ({
      queryKey: [
        'theorem',
        'crm',
        'search',
        type.object_type_id,
        query,
      ] as const,
      queryFn: () =>
        searchRecords(type.object_type_id, identifierField(type)?.key, query),
      enabled: enabled && accessFor(life, type).read,
      staleTime: 10_000,
      retry,
    })),
  })
  const stamp = results
    .map(
      (result) =>
        `${result.dataUpdatedAt}:${result.status}:${result.fetchStatus}`,
    )
    .join()
  return useMemo(() => {
    const byType = new Map<string, CrmRecord[]>()
    const status = new Map<string, RecordsStatus>()
    types.forEach((type, index) => {
      const result = results[index]
      const readable = accessFor(life, type).read
      status.set(
        type.object_type_id,
        !readable || result?.error instanceof RecordAccessError
          ? 'denied'
          : result?.data
            ? 'ready'
            : result?.isError
              ? 'failed'
              : 'pending',
      )
      if (result?.data && readable) byType.set(type.object_type_id, result.data)
    })
    return {
      recordsOf: (type: ObjectType) =>
        byType.get(type.object_type_id) ?? NO_RECORDS,
      statusOf: (type: ObjectType): RecordsStatus =>
        status.get(type.object_type_id) ?? 'pending',
      /** Asks again for every type whose search failed. */
      retryFailed: () => {
        types.forEach((type, index) => {
          if (status.get(type.object_type_id) === 'failed')
            void results[index]?.refetch()
        })
      },
    }
    // Cached queries can share a timestamp and status; their text still
    // identifies different results and must invalidate this projection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stamp, types, life, query])
}
