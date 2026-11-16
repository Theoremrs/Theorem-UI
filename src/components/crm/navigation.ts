// SOURCING: @tanstack/react-router (the CRM's place is the route: /crm, /crm/$objectType, /crm/$objectType/$recordId), zustand (which record's preview is open beside a table; it is a view of the table, not a place)
import { useNavigate, useParams } from '@tanstack/react-router'
import { useCallback } from 'react'
import { create } from 'zustand'
import type { ObjectType } from '@/components/records/contract'
import { typeSlug } from './model'

/** Where the CRM is: a type's table, or one record's page. */
export function useCrmPlace() {
  const params = useParams({ strict: false }) as {
    objectType?: string
    recordId?: string
  }
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

/** The record previewed beside each type's table, by object type id. */
export const useCrmPreview = create<{
  preview: Readonly<Record<string, string | undefined>>
  open: (objectTypeId: string, recordId: string | undefined) => void
}>()((set) => ({
  preview: {},
  open: (objectTypeId, recordId) =>
    set((s) => ({ preview: { ...s.preview, [objectTypeId]: recordId } })),
}))
