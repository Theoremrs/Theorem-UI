// SOURCING: React context — one reading of the schema register's types, what this sign-in may do, and the loaded records of every listed type once a record surface asks for them, shared by the CRM's table, preview and record page in the Index so a relation's label and a record's "Related" list come from the same records; navigation alone (the Index panel) reads the types and their counts from the data model and downloads no record
import { createContext, useContext, useMemo } from 'react'
import type { ReactNode } from 'react'
import type {
  DataModel,
  FieldSpec,
  ObjectType,
} from '@/components/records/contract'
import { recordTitle } from '@/components/records/model'
import { useDataModel } from '@/components/records/queries'
import type { CrmRecord, LifeContext } from './api'
import { accessFor, crmTypes, relationTarget } from './model'
import { useCrmRecordsOf, useLifeContext } from './queries'
import type { RecordsStatus } from './queries'

export type CrmScope = {
  model: DataModel | undefined
  /** The listed types, built-in ones first. */
  types: ObjectType[]
  life: LifeContext | undefined
  recordsOf: (type: ObjectType) => CrmRecord[]
  countOf: (type: ObjectType) => number | undefined
  statusOf: (type: ObjectType) => RecordsStatus
  recordById: (id: string) => CrmRecord | undefined
  /** The type a relation field points at. */
  targetOf: (field: FieldSpec) => ObjectType | undefined
  /** A related record's title; one that is not loaded is named by its id. */
  titleOf: (field: FieldSpec, id: string) => string
  /** The record that is the signed-in person, when one is. */
  selfId: string | undefined
  /** Whether the records of every type are being read; a navigation-only scope reads none. */
  recordsLoaded: boolean
  /** The data model's read: whether it failed, and a way to try it again. */
  modelRead: { failed: boolean; retry: () => void }
}

const NO_TYPES: ObjectType[] = []

const Context = createContext<CrmScope | null>(null)

/**
 * The CRM's shared reading, for the panel and the view to each build once.
 * With `records: false` no record is downloaded: counts come from the data
 * model and a type's status is only whether this sign-in may read it.
 */
export function useCrmScopeValue({
  records: withRecords = true,
}: { records?: boolean } = {}): CrmScope {
  const read = useDataModel()
  const model = read.data
  const life = useLifeContext().data
  const types = useMemo(() => crmTypes(model), [model])
  const loaded = useCrmRecordsOf(withRecords ? types : NO_TYPES)
  const refetch = read.refetch
  return useMemo(() => {
    const targetOf = (field: FieldSpec) => relationTarget(model, field)
    const records = withRecords
      ? loaded
      : {
          ...loaded,
          statusOf: (type: ObjectType) =>
            accessFor(life, type).read
              ? ('pending' as const)
              : ('denied' as const),
        }
    return {
      model,
      types,
      life,
      ...records,
      recordsLoaded: withRecords,
      modelRead: {
        failed: !model && read.isError,
        retry: () => void refetch(),
      },
      targetOf,
      titleOf: (field, id) => {
        const target = targetOf(field)
        const record = records.recordById(id)
        return target && record ? recordTitle(target, record) : id
      },
      selfId:
        life?.self.state === 'bound' ? life.self.personRecordId : undefined,
    }
  }, [model, types, life, loaded, withRecords, read.isError, refetch])
}

export function CrmScopeProvider({
  value,
  children,
}: {
  value: CrmScope
  children: ReactNode
}) {
  return <Context.Provider value={value}>{children}</Context.Provider>
}

export function useCrmScope(): CrmScope {
  const scope = useContext(Context)
  if (!scope) throw new Error('useCrmScope needs a CrmScopeProvider')
  return scope
}

function OwnScope({
  records,
  children,
}: {
  records: boolean
  children: ReactNode
}) {
  const value = useCrmScopeValue({ records })
  return <Context.Provider value={value}>{children}</Context.Provider>
}

/**
 * The CRM's reading for a record surface (a table, a page, a preview): the
 * one already provided around it when it has the records, else its own with
 * them. Index mode provides a navigation-only scope, so opening the Index
 * downloads no record until a record surface is drawn.
 */
export function CrmBoundary({ children }: { children: ReactNode }) {
  const scope = useContext(Context)
  return scope?.recordsLoaded ? (
    children
  ) : (
    <OwnScope records>{children}</OwnScope>
  )
}

/** The CRM's reading for navigation alone: types and counts, no records. */
export function CrmNavigationBoundary({ children }: { children: ReactNode }) {
  const scope = useContext(Context)
  return scope ? children : <OwnScope records={false}>{children}</OwnScope>
}

// Kept in a module of its own so a chat part can use it without this one.
export { OpenDocumentProvider, useOpenDocumentHandler } from './open-document'
