// SOURCING: React context — one reading of the schema register's types, what this sign-in may do, and the loaded records of every listed type, shared by the CRM's table, preview and record page so a relation's label and a record's "Related" list come from the same records
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
import { crmTypes, relationTarget } from './model'
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
}

const Context = createContext<CrmScope | null>(null)

/** The CRM's shared reading, for the panel and the view to each build once. */
export function useCrmScopeValue(): CrmScope {
  const model = useDataModel().data
  const life = useLifeContext().data
  const types = useMemo(() => crmTypes(model), [model])
  const records = useCrmRecordsOf(types)
  return useMemo(() => {
    const targetOf = (field: FieldSpec) => relationTarget(model, field)
    return {
      model,
      types,
      life,
      ...records,
      targetOf,
      titleOf: (field, id) => {
        const target = targetOf(field)
        const record = records.recordById(id)
        return target && record ? recordTitle(target, record) : id
      },
      selfId:
        life?.self.state === 'bound' ? life.self.personRecordId : undefined,
    }
  }, [model, types, life, records])
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
