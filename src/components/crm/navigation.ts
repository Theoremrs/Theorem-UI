// SOURCING: @tanstack/react-router (the CRM's place is the route: /crm, /crm/$objectType, /crm/$objectType/$recordId), with the table's view (previewed record, filter, sort) in the address's search so Back and reload return to it
import { useNavigate, useParams, useSearch } from '@tanstack/react-router'
import { useCallback } from 'react'
import type { ObjectType } from '@/components/records/contract'
import { typeSlug } from './model'

/** Where the CRM is: a type's table, or one record's page. */
export function useCrmPlace() {
  const params = useParams({ strict: false })
  return { slug: params.objectType, recordId: params.recordId }
}

export function useCrmNavigate() {
  const navigate = useNavigate()
  const openType = useCallback(
    (type: ObjectType, options?: { replace?: boolean }) =>
      navigate({
        to: '/crm/$objectType',
        params: { objectType: typeSlug(type) },
        replace: options?.replace,
      }),
    [navigate],
  )
  const openRecord = useCallback(
    (type: ObjectType, recordId: string) =>
      navigate({
        to: '/crm/$objectType/$recordId',
        params: { objectType: typeSlug(type), recordId },
      }),
    [navigate],
  )
  return { openType, openRecord }
}

/**
 * What a table is showing, kept in its address so a reload, a shared link and
 * Back from a record's page all return to the same view: the record previewed
 * beside it, the text it is filtered by, and the field it is sorted by.
 */
export type CrmTableSearch = {
  record?: string
  q?: string
  sort?: string
  desc?: boolean
}

/** Reads a table's view out of a location's search, ignoring anything else. */
export function crmTableSearch(
  search: Readonly<Record<string, unknown>>,
): CrmTableSearch {
  const out: CrmTableSearch = {}
  for (const key of ['record', 'q', 'sort'] as const) {
    const value = search[key]
    if (typeof value === 'string' && value) out[key] = value
    // The router reads an all-digit value back as a number.
    else if (typeof value === 'number') out[key] = String(value)
  }
  if (search.desc === true || search.desc === 'true') out.desc = true
  return out
}

/**
 * A type's table view and the way to change it. A change replaces the current
 * history entry: the view is one place, however it is filtered.
 */
export function useCrmTableSearch(type: ObjectType) {
  const navigate = useNavigate()
  const raw = useSearch({ strict: false })
  const { record, q, sort, desc } = crmTableSearch(raw)
  const slug = typeSlug(type)
  const change = useCallback(
    (patch: CrmTableSearch) =>
      navigate({
        to: '/crm/$objectType',
        params: { objectType: slug },
        search: (now) => crmTableSearch({ ...now, ...patch }),
        replace: true,
      }),
    [navigate, slug],
  )
  return { record, q, sort, desc, change }
}
