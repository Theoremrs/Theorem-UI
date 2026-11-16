// SOURCING: @tanstack/react-query (server state for the CRM through ./api: one page of a type's records with their saved revisions, single-record reads, the change log, and writes that put the returned revision in the cache), zustand (the edits that are in flight or were refused, shared by the table, the preview and the record page)
//
// A cell is never drawn as saved before Theorem says so. An edit is held
// here from the moment it is committed until Theorem returns the record at
// its new revision; an edit that was refused stays here, visible, until the
// person applies it again or discards it.
import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import type { QueryClient } from '@tanstack/react-query'
import { useCallback, useMemo } from 'react'
import { create } from 'zustand'
import type { FieldSpec, ObjectType } from '@/components/records/contract'
import { isSignedOut } from '@/lib/theorem/client'
import * as api from './api'
import { RecordAccessError, RevisionConflictError } from './api'
import type { CrmRecord, CrmRecordPage, LifeContext } from './api'
import { accessFor, sameValue } from './model'

const CRM = ['theorem', 'crm'] as const
/** The schema register's model, as components/records/queries keys it. */
const MODEL = ['theorem', 'records', 'model'] as const

export const crmKeys = {
  life: [...CRM, 'life'] as const,
  records: (objectTypeId: string) => [...CRM, 'records', objectTypeId] as const,
  record: (id: string) => [...CRM, 'record', id] as const,
  changes: (id: string) => [...CRM, 'changes', id] as const,
}

/** A refusal is an answer, not a blip: only an unexplained failure is tried again. */
const retry = (failures: number, error: unknown) =>
  !isSignedOut(error) &&
  !(error instanceof RecordAccessError) &&
  !(error instanceof api.RecordMissingError) &&
  failures < 1

// Life context

export const useLifeContext = () =>
  useQuery({
    queryKey: crmKeys.life,
    queryFn: api.readLifeContext,
    staleTime: 30_000,
    retry,
  })

/** Declares the built-in types, then re-reads the model that lists them. */
export function useInstallLifeContextTypes() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: api.installLifeContextTypes,
    onSuccess: (life) => {
      client.setQueryData<LifeContext>(crmKeys.life, life)
      void client.invalidateQueries({ queryKey: MODEL })
    },
  })
}

export function useBindSelfPerson() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (recordId: string) => api.bindSelfPerson(recordId),
    onSuccess: (life) => client.setQueryData<LifeContext>(crmKeys.life, life),
  })
}

// Records

const recordsQuery = (objectType: ObjectType) => ({
  queryKey: crmKeys.records(objectType.object_type_id),
  queryFn: () => api.findRecords(objectType.object_type_id),
  staleTime: 15_000,
  retry,
})

/** A type's records at their saved revisions, and how many there are in all. */
export const useCrmRecords = (
  objectType: ObjectType | undefined,
  { enabled = true }: { enabled?: boolean } = {},
) =>
  useQuery({
    queryKey: crmKeys.records(objectType?.object_type_id ?? ''),
    queryFn: () => api.findRecords(objectType!.object_type_id),
    enabled: enabled && !!objectType,
    staleTime: 15_000,
    retry,
  })

/** Whether a type's records are in hand, on their way, or were refused. */
export type RecordsStatus = 'pending' | 'ready' | 'denied' | 'failed'

/**
 * The loaded records of several types at once: the types a table's relations
 * point at, or every type that can point at a record. A type this sign-in
 * cannot read is not asked for; it is `denied`, which is not the same as a
 * type with no records. `types` must keep its identity between renders.
 */
export function useCrmRecordsOf(types: ObjectType[]) {
  const life = useLifeContext().data
  const results = useQueries({
    queries: types.map((type) => ({
      ...recordsQuery(type),
      enabled: accessFor(life, type).read,
    })),
  })
  const stamp = results
    .map((result) => `${result.dataUpdatedAt}:${result.status}:${result.fetchStatus}`)
    .join()
  return useMemo(() => {
    const byType = new Map<string, CrmRecordPage>()
    const byId = new Map<string, CrmRecord>()
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
      if (!result?.data || !readable) return
      byType.set(type.object_type_id, result.data)
      for (const record of result.data.records) byId.set(record.id, record)
    })
    return {
      recordsOf: (type: ObjectType) =>
        byType.get(type.object_type_id)?.records ?? NO_RECORDS,
      /** Every record of the type, as Theorem counted them; undefined until it answers. */
      countOf: (type: ObjectType) => byType.get(type.object_type_id)?.count,
      statusOf: (type: ObjectType): RecordsStatus =>
        status.get(type.object_type_id) ?? 'pending',
      recordById: (id: string) => byId.get(id),
    }
    // `stamp` changes when any type's records or their state do.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stamp, types, life])
}

const NO_RECORDS: CrmRecord[] = []

const heldRecord = (
  client: QueryClient,
  objectType: ObjectType,
  id: string,
) =>
  client
    .getQueryData<CrmRecordPage>(crmKeys.records(objectType.object_type_id))
    ?.records.find((record) => record.id === id)

/** One record at its saved revision: what the table holds first, then Theorem's own answer. */
export function useCrmRecord(objectType: ObjectType | undefined, id: string) {
  const client = useQueryClient()
  return useQuery({
    queryKey: crmKeys.record(id),
    queryFn: () => api.findRecord(objectType!.object_type_id, id),
    enabled: !!objectType && !!id,
    placeholderData: () =>
      objectType ? heldRecord(client, objectType, id) : undefined,
    staleTime: 15_000,
    retry,
  })
}

export const useRecordChanges = (recordId: string | undefined) =>
  useQuery({
    queryKey: crmKeys.changes(recordId ?? ''),
    queryFn: () => api.readRecordChanges(recordId!),
    enabled: !!recordId,
    staleTime: 15_000,
    retry,
  })

/** Put a record Theorem returned into the list and the single-record cache. */
export function storeRecord(
  client: QueryClient,
  objectType: ObjectType,
  record: CrmRecord,
  { append = false } = {},
) {
  client.setQueryData<CrmRecord>(crmKeys.record(record.id), record)
  client.setQueryData<CrmRecordPage>(
    crmKeys.records(objectType.object_type_id),
    (page) => {
      if (!page) return page
      const held = page.records.some((r) => r.id === record.id)
      if (held)
        return {
          ...page,
          records: page.records.map((r) => (r.id === record.id ? record : r)),
        }
      return append
        ? { records: [...page.records, record], count: page.count + 1 }
        : page
    },
  )
}

function dropRecord(client: QueryClient, objectType: ObjectType, id: string) {
  client.removeQueries({ queryKey: crmKeys.record(id) })
  client.removeQueries({ queryKey: crmKeys.changes(id) })
  client.setQueryData<CrmRecordPage>(
    crmKeys.records(objectType.object_type_id),
    (page) =>
      page && page.records.some((r) => r.id === id)
        ? {
            records: page.records.filter((r) => r.id !== id),
            count: Math.max(0, page.count - 1),
          }
        : page,
  )
}

export function useCreateCrmRecord(objectType: ObjectType) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (values: Record<string, unknown>) =>
      api.createCrmRecord(objectType.object_type_id, values),
    onSuccess: (record) => {
      storeRecord(client, objectType, record, { append: true })
      // The model's record counts are now one short.
      void client.invalidateQueries({ queryKey: MODEL })
    },
  })
}

// Revisions this page wrote

/**
 * The revisions this page's own writes produced, by record: `from` the
 * revision a write named, `to` the one Theorem returned. A later edit made
 * against an older reading follows this chain, and only this chain, so it
 * never names a revision someone else wrote that the person has not seen.
 */
const ownWrites = new Map<string, Map<number, number>>()

function followOwnWrites(recordId: string, readRevision: number) {
  const chain = ownWrites.get(recordId)
  let revision = readRevision
  for (let hops = 0; chain?.has(revision) && hops < 10_000; hops++)
    revision = chain.get(revision)!
  return revision
}

function recordOwnWrite(recordId: string, from: number, to: number) {
  if (from === to) return
  let chain = ownWrites.get(recordId)
  if (!chain) ownWrites.set(recordId, (chain = new Map()))
  chain.set(from, to)
}

/** Writes to one record run one after another, so each names the revision the last returned. */
const queues = new Map<string, Promise<unknown>>()

function enqueue<T>(recordId: string, run: () => Promise<T>): Promise<T> {
  const next = (queues.get(recordId) ?? Promise.resolve()).then(run, run)
  queues.set(
    recordId,
    next.catch(() => {}),
  )
  return next
}

/** For tests: forget the revisions and queues of earlier cases. */
export function resetCrmWrites() {
  ownWrites.clear()
  queues.clear()
  useCrmEdits.setState({ edits: {} })
}

// Edits in flight, and edits that were refused

export type FieldEdit = {
  recordId: string
  objectTypeId: string
  fieldKey: string
  /** What the person entered. It is kept until it is saved or they discard it. */
  value: unknown
  /** The revision the record was read at when they made the edit. */
  readRevision: number
  status:
    | 'saving'
    /** The record changed since it was opened; it has not been re-read yet. */
    | 'conflict'
    /** The record was re-read after a conflict; the edit waits to be applied again. */
    | 'held'
    /** Theorem refused or could not be reached. */
    | 'failed'
  error?: unknown
}

export const editKey = (recordId: string, fieldKey: string) =>
  `${recordId}\u0000${fieldKey}`

type EditsState = {
  edits: Readonly<Record<string, FieldEdit>>
  put: (edit: FieldEdit) => void
  clear: (recordId: string, fieldKey: string) => void
  clearRecord: (recordId: string) => void
}

export const useCrmEdits = create<EditsState>()((set) => ({
  edits: {},
  put: (edit) =>
    set((s) => ({
      edits: { ...s.edits, [editKey(edit.recordId, edit.fieldKey)]: edit },
    })),
  clear: (recordId, fieldKey) =>
    set((s) => {
      const key = editKey(recordId, fieldKey)
      if (!(key in s.edits)) return s
      const { [key]: _, ...rest } = s.edits
      return { edits: rest }
    }),
  clearRecord: (recordId) =>
    set((s) => ({
      edits: Object.fromEntries(
        Object.entries(s.edits).filter(([, edit]) => edit.recordId !== recordId),
      ),
    })),
}))

/** The edit a field is waiting on, if any. */
export const useFieldEdit = (recordId: string, fieldKey: string) =>
  useCrmEdits((s) => s.edits[editKey(recordId, fieldKey)])

/** A record's edits that are not saved: refused, or waiting to be applied again. */
export function useUnsavedEdits(recordId?: string) {
  const edits = useCrmEdits((s) => s.edits)
  return useMemo(
    () =>
      Object.values(edits).filter(
        (edit) =>
          edit.status !== 'saving' &&
          (recordId === undefined || edit.recordId === recordId),
      ),
    [edits, recordId],
  )
}

/**
 * Saving, re-reading and deleting a type's records. Every update and delete
 * names the revision the person was looking at; a refusal leaves their value
 * in `useCrmEdits`, never in the saved record.
 */
export function useCrmWrites(objectType: ObjectType) {
  const client = useQueryClient()
  const objectTypeId = objectType.object_type_id

  const send = useCallback(
    (edit: Omit<FieldEdit, 'status' | 'error'>) => {
      const { put, clear } = useCrmEdits.getState()
      put({ ...edit, status: 'saving' })
      return enqueue(edit.recordId, async () => {
        const expected = followOwnWrites(edit.recordId, edit.readRevision)
        try {
          const record = await api.updateCrmRecord(
            objectTypeId,
            edit.recordId,
            { [edit.fieldKey]: edit.value },
            expected,
          )
          recordOwnWrite(edit.recordId, expected, record.version)
          storeRecord(client, objectType, record)
          clear(edit.recordId, edit.fieldKey)
          void client.invalidateQueries({
            queryKey: crmKeys.changes(edit.recordId),
          })
          return record
        } catch (error) {
          put({
            ...edit,
            status: error instanceof RevisionConflictError ? 'conflict' : 'failed',
            error,
          })
          return undefined
        }
      })
    },
    [client, objectType, objectTypeId],
  )

  /** Save one field of a record as it was read. A value that did not change is not sent. */
  const save = useCallback(
    (record: CrmRecord, field: FieldSpec, value: unknown, readRevision = record.version) => {
      if (sameValue(record.values[field.key], value)) {
        useCrmEdits.getState().clear(record.id, field.key)
        return Promise.resolve(record)
      }
      return send({
        recordId: record.id,
        objectTypeId,
        fieldKey: field.key,
        value,
        readRevision,
      })
    },
    [objectTypeId, send],
  )

  /**
   * Re-read a record after a conflict. Its refused edits stay, now against
   * the revision just read, for the person to apply again or discard.
   */
  const reload = useCallback(
    async (recordId: string) => {
      const record = await api.findRecord(objectTypeId, recordId)
      storeRecord(client, objectType, record)
      void client.invalidateQueries({ queryKey: crmKeys.changes(recordId) })
      const { edits, put, clear } = useCrmEdits.getState()
      for (const edit of Object.values(edits)) {
        if (edit.recordId !== recordId || edit.status === 'saving') continue
        // What they entered is already what is saved: nothing is left to apply.
        if (sameValue(record.values[edit.fieldKey], edit.value))
          clear(recordId, edit.fieldKey)
        else
          put({
            ...edit,
            status: 'held',
            readRevision: record.version,
            error: undefined,
          })
      }
      return record
    },
    [client, objectType, objectTypeId],
  )

  /** Send a refused edit again, against the revision it now names. */
  const apply = useCallback(
    (edit: FieldEdit) => {
      const { status: _status, error: _error, ...rest } = edit
      return send(rest)
    },
    [send],
  )

  const discard = useCallback(
    (edit: Pick<FieldEdit, 'recordId' | 'fieldKey'>) =>
      useCrmEdits.getState().clear(edit.recordId, edit.fieldKey),
    [],
  )

  /** Delete a record as it was read; one that moved on is refused. */
  const remove = useCallback(
    (record: CrmRecord) =>
      enqueue(record.id, async () => {
        await api.deleteCrmRecord(
          objectTypeId,
          record.id,
          followOwnWrites(record.id, record.version),
        )
        dropRecord(client, objectType, record.id)
        useCrmEdits.getState().clearRecord(record.id)
        ownWrites.delete(record.id)
        void client.invalidateQueries({ queryKey: MODEL })
      }),
    [client, objectType, objectTypeId],
  )

  return { save, reload, apply, discard, remove }
}

export type CrmWrites = ReturnType<typeof useCrmWrites>
