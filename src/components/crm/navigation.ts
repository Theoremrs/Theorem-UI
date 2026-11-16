// SOURCING: the Index's place (components/index/navigation): the CRM lives in the Index, so a type's table is the Index view `default:records:<name>`, a record's page is `default:record:<name>/<id>`, and the record previewed beside a table is the Index's open item `record:<name>/<id>`; the table's filter and sort are the place's too, so Back and reload return to the same view. Opening a record is observed as the Index observes any item
import { useSearch } from '@tanstack/react-router'
import { useMemo } from 'react'
import {
  indexSearch,
  useIndexNavigate,
  useMaybeIndexPlace,
} from '@/components/index/navigation'
import type { IndexSearch, TableSearch } from '@/components/index/navigation'
import { observer } from '@/components/index/observe'
import {
  RECORDS_PREFIX,
  dataModelViewId,
  parseRecordPageViewId,
  recordPageViewId,
  recordsViewId,
} from '@/components/index/programs'
import type { Scope } from '@/components/index/contract'
import type { ObjectType } from '@/components/records/contract'
import { parseRecordItemId, recordItemId } from '@/components/records/model'

const HOME: Scope = { kind: 'home' }

/** The Index search the CRM is drawn from: its place's, else the URL's. */
function useSearchHere(): IndexSearch {
  const place = useMaybeIndexPlace()
  const url = useSearch({ strict: false })
  return place?.search ?? indexSearch(url)
}

/** Where the CRM is: a type's table or one record's page, by the type's name. */
export function useCrmPlace(): { nameSingular?: string; recordId?: string } {
  const { view } = useSearchHere()
  const page = parseRecordPageViewId(view)
  if (page) return page
  if (view?.startsWith(RECORDS_PREFIX))
    return { nameSingular: view.slice(RECORDS_PREFIX.length) }
  return {}
}

export function useCrmNavigate() {
  const place = useMaybeIndexPlace()
  const url = useIndexNavigate()
  const navigate = place?.navigate ?? url
  const scope = place?.search.scope ?? HOME
  const viewId = place?.search.view
  return useMemo(() => {
    const opened = (subject: string) =>
      observer().record({
        kind: 'item_opened',
        scope,
        viewId,
        subjects: [subject],
      })
    return {
      openType: (type: ObjectType, options?: { replace?: boolean }) =>
        navigate.openView(recordsViewId(type.name_singular), HOME, {
          closeItem: true,
          replace: options?.replace,
        }),
      /** The type's fields in the data model, where they are added, renamed and retired. */
      openDataModel: (type: ObjectType) =>
        navigate.openView(dataModelViewId(type.name_singular), HOME, {
          closeItem: true,
        }),
      openRecord: (type: ObjectType, recordId: string) => {
        opened(recordItemId(type, recordId))
        navigate.openView(
          recordPageViewId(type.name_singular, recordId),
          HOME,
          {
            closeItem: true,
          },
        )
      },
      /** A record's page by the type's name, as an Index result names it. */
      openRecordNamed: (nameSingular: string, recordId: string) => {
        opened(`record:${nameSingular}/${recordId}`)
        navigate.openView(recordPageViewId(nameSingular, recordId), HOME, {
          closeItem: true,
        })
      },
      /** A document beside the view, as the Index opens any item. */
      openDocument: (documentId: string) => {
        opened(documentId)
        navigate.openItem(documentId)
      },
      /** Opens a record beside the table, or closes the one that is open. */
      preview: (type: ObjectType, recordId: string | undefined) => {
        if (!recordId) return navigate.closeItem()
        const item = recordItemId(type, recordId)
        opened(item)
        navigate.openItem(item)
      },
      setTable: (patch: TableSearch) => navigate.setTable(patch),
    }
  }, [navigate, scope, viewId])
}

/**
 * What a table is showing: the record previewed beside it (the Index's open
 * item, when it is one of this type's records), the text it is searched
 * for, and the fields it is sorted by.
 */
export type CrmTableSearch = TableSearch & { record?: string }

/** A type's table view and the way to change it. */
export function useCrmTableSearch(type: ObjectType) {
  const search = useSearchHere()
  const { preview, setTable } = useCrmNavigate()
  const open = parseRecordItemId(search.item ?? '')
  const record =
    open?.nameSingular === type.name_singular ? open.recordId : undefined
  const change = useMemo(
    () => (patch: CrmTableSearch) => {
      const { record: next, ...table } = patch
      if ('record' in patch && next !== record) preview(type, next)
      if (Object.keys(table).length) setTable(table)
    },
    [preview, setTable, type, record],
  )
  return {
    record,
    q: search.q,
    sort: search.sort,
    desc: search.desc,
    then: search.then,
    change,
  }
}
