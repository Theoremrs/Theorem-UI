// SOURCING: the records' field controls (components/records/fields) write and read one value, so a
// capability record is edited with the same keys the CRM uses; the page module boundary
// (lib/modules/registry) and the composer reference path. Every read and write is the instance's own
// contract: the resolved fields from describe, one declared action per save.
import { useEffect, useMemo, useRef, useState } from 'react'
import { askAbout } from '@/components/chat/composer-references'
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from '@/components/coss/empty'
import { Icon } from '@/components/icons'
import {
  FieldDisplay,
  FieldEditor,
  isEditable,
} from '@/components/records/fields'
import { Button } from '@/components/ui/button'
import { fieldControl } from '@/components/pages/resource-field'
import { isReloadConflict, refusalMessage } from '@/lib/capabilities/api'
import type { RecordScanResume } from '@/lib/capabilities/api'
import {
  canInvoke,
  capabilityRecordItem,
  fieldSpecOf,
  inputsFor,
  parseCapabilityRecordItem,
  registerRowOf,
  rowTitle,
  saveAction,
  schemaFor,
  updateActions,
  valueText,
} from '@/lib/capabilities/model'
import type { SaveOverride } from '@/lib/capabilities/model'
import { codes } from '@/lib/capabilities/contract'
import type {
  ActionSpec,
  CapabilityDefinition,
  CapabilityRecordRow,
  CollectionSchema,
  DescribeResult,
  InvocationReceipt,
  ResolvedField,
} from '@/lib/capabilities/contract'
import { capabilityContextReference } from '@/lib/capabilities/reference'
import type { ModuleViewProps } from '@/lib/modules/registry'
import { usePagePath } from '../pages/page-route'
import { ActionCall } from './action-form'
import {
  DescribeState,
  Loading,
  PermissionState,
  StatusLine,
  refusedStatus,
} from './states'
import type { Status } from './states'
import {
  useCapabilityDescribe,
  useCapabilityInvoke,
  useCapabilityPickers,
  useCapabilityReceipt,
  useCapabilityRecord,
} from './queries'

const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '')

/**
 * Whether a field edits inline with the register's own control. A relation is
 * chosen from the collection it names instead, below; a field whose kind has no
 * editor here (a vector, a geometry) is shown as it is.
 */
const inlineEditable = (field: ResolvedField) =>
  isEditable(fieldSpecOf(field)) && field.fieldType.kind !== 'relation'

/**
 * A relation value, picked from the collection that target is part of. It is
 * never cleared: an absent input leaves a field as it is and the executor
 * refuses a null one, so no call can empty a field. A set value offers only
 * other targets; an empty one shows that state as a placeholder that cannot be
 * chosen, and nothing commits until a target is.
 */
function RelationPick({
  instanceId,
  definition,
  schemas,
  field,
  value,
  onCommit,
  onCancel,
}: {
  instanceId: string
  definition: CapabilityDefinition
  schemas: CollectionSchema[]
  field: ResolvedField
  value: unknown
  onCommit: (value: unknown) => void
  onCancel: () => void
}) {
  const target =
    field.fieldType.kind === 'relation'
      ? field.fieldType.targetObjectTypeId
      : ''
  const collection = definition.collections.find(
    (one) => one.objectTypeId === target,
  )
  const pickers = useCapabilityPickers(
    instanceId,
    collection ? [collection.key] : [],
  )
  const rows = collection ? (pickers.data?.[collection.key] ?? []) : []
  const targetFields = collection
    ? (schemaFor(schemas, collection.key)?.fields ?? [])
    : []
  const current = typeof value === 'string' ? value : ''
  if (!collection)
    return (
      <p className="text-xs text-ink-muted">
        {field.label}: its target collection is not part of this capability, so
        it is shown as it is.
      </p>
    )
  return (
    <div className="flex items-center gap-2">
      <select
        aria-label={`Choose ${field.label}`}
        className={fieldControl}
        value={current}
        onChange={(event) => {
          if (event.target.value) onCommit(event.target.value)
        }}
      >
        {!current && (
          <option value="" disabled>
            Not set · choose one
          </option>
        )}
        {rows.map((row) => (
          <option key={row.id} value={row.id}>
            {rowTitle(targetFields, row)}
          </option>
        ))}
        {current && !rows.some((row) => row.id === current) && (
          <option value={current}>{current}</option>
        )}
      </select>
      <Button size="xs" variant="ghost" onClick={onCancel}>
        Cancel
      </Button>
    </div>
  )
}

/**
 * What the person has edited and not saved, with the revision of the record
 * they started editing. A save names that revision, so a record another module
 * moved on meanwhile is refused as a conflict rather than overwritten; the base
 * changes only when the person reloads, discards, or their own save moves it.
 */
type Draft = { values: Record<string, unknown>; base?: number }

const NO_DRAFT: Draft = { values: {} }

/** One line naming what an action writes over the values the person entered. */
const overrideText = (overrides: SaveOverride[]) =>
  overrides
    .map((one) =>
      one.writes === 'now'
        ? `${one.fieldKey} as the time it runs`
        : `${one.fieldKey} as ${valueText(one.value) || 'empty'}`,
    )
    .join(', ')

/**
 * `theorem.capability.record`: one record's fields, edited and saved through a
 * declared action, with the definition's other actions beside it.
 */
function CapabilityRecordBody({
  view,
  described,
  recordId,
  collectionKey,
}: {
  view: ModuleViewProps
  described: DescribeResult
  recordId: string
  collectionKey: string | undefined
}) {
  const { output, emit } = view
  const pageId = usePagePath()
  // The page component that shows this: a composite's own id, when inside one.
  const selectedComponentId = view.path.split('/')[0]
  const instanceId = text(view.settings.instanceId)
  // The view a connected table shows, when one is bound in: the envelope then
  // names it, so the agent knows where the record was picked from.
  const viewKey = text(view.inputs.viewKey) || undefined
  const definition = described.definition
  const grant = described.callerGrant
  const [resume, setResume] = useState<RecordScanResume>()
  const found = useCapabilityRecord(
    instanceId,
    definition,
    recordId,
    collectionKey,
    resume,
  )
  const invoking = useCapabilityInvoke()
  const receipts = useCapabilityReceipt()

  const [draft, setDraft] = useState<Draft>(NO_DRAFT)
  // The field being edited, and the revision its value was read at when the
  // editor opened: a refresh while it is open does not move that base.
  const [editing, setEditing] = useState<{
    fieldKey: string
    revision: number
  }>()
  const [status, setStatus] = useState<Status>()
  // Each open action form has its own number and the row it was opened over,
  // so a late answer closes only that form and its call names that revision.
  const forms = useRef(0)
  const [calling, setCalling] = useState<{
    action: ActionSpec
    row: CapabilityRecordRow
    form: number
  }>()
  const [confirming, setConfirming] = useState<{
    action: ActionSpec
    overrides: SaveOverride[]
  }>()
  const [busy, setBusy] = useState(false)
  const running = useRef(false)
  // A journaled save that has not finished, by its journal id: what it saved,
  // so the receipt that finishes it clears those edits and no later ones.
  const pendingSaves = useRef(new Map<string, Record<string, unknown>>())
  const shownStatus = useRef(status)
  useEffect(() => {
    shownStatus.current = status
  }, [status])

  const lookup = found.data
  const row = lookup?.kind === 'found' ? lookup.row : undefined
  const key =
    lookup?.kind === 'found' ? lookup.collectionKey : (collectionKey ?? '')
  const schema = schemaFor(described.collectionSchemas, key)
  // Stable while the schema is, so what hangs on it does not re-run each render.
  const fields = useMemo(() => schema?.fields ?? [], [schema])
  const actions = useMemo(
    () => updateActions(definition, key),
    [definition, key],
  )
  const dirty = Object.keys(draft.values)
  const shown = useMemo(
    () =>
      row
        ? {
            ...registerRowOf(row),
            values: { ...row.fields, ...draft.values },
          }
        : undefined,
    [row, draft],
  )

  const context = useMemo(
    () =>
      row && shown
        ? capabilityContextReference({
            instanceId,
            collectionKey: key,
            pageId,
            viewKey,
            selectedComponentId,
            purpose: definition.purpose,
            label: `${definition.name} · ${rowTitle(fields, row)}`,
            selected: [{ id: row.id, revision: row.revision }],
            // The record was named, not paged: no view filter narrowed it and no
            // page cut it short, so the agent reads this one row at this revision.
            filtered: false,
            truncated: false,
          })
        : undefined,
    [
      row,
      shown,
      instanceId,
      key,
      pageId,
      viewKey,
      selectedComponentId,
      definition,
      fields,
    ],
  )

  // What this module shows is also what the page can wire onward: its Selected
  // item and the context envelope, both at the revision on screen, and nothing
  // once no record is shown.
  useEffect(() => output('context', context), [output, context])
  useEffect(() => {
    if (context) emit('context', context)
  }, [emit, context])
  useEffect(() => {
    output(
      'selected',
      row
        ? capabilityRecordItem(instanceId, key, row.id, rowTitle(fields, row))
        : undefined,
    )
  }, [output, row, instanceId, key, fields])
  // A body that goes (another record, a cleared input) takes its values with it.
  useEffect(
    () => () => {
      output('selected', undefined)
      output('context', undefined)
    },
    [output],
  )

  /**
   * One field's new value, held until a save. The first one fixes the draft's
   * base at the revision its editor opened on, not the one on screen now.
   */
  const write = (fieldKey: string, value: unknown) => {
    if (!row) return
    const opened = editing?.revision ?? row.revision
    setDraft((held) => ({
      values: { ...held.values, [fieldKey]: value },
      base: held.base ?? opened,
    }))
    setEditing(undefined)
    setConfirming(undefined)
  }

  /** Close the form a finished call came from, if it is still the one open. */
  const closeForm = (form: number | undefined) => {
    if (form === undefined) return
    setCalling((open) => (open?.form === form ? undefined : open))
  }

  const report = (
    receipt: InvocationReceipt,
    at: { saved?: Record<string, unknown>; form?: number } = {},
  ): boolean => {
    if (receipt.status === 'dispatched') {
      if (at.saved) pendingSaves.current.set(receipt.recordId, at.saved)
      setStatus({
        kind: 'pending',
        message: `${receipt.actionKey} is journaled and has not finished, so whether it took effect is not yet known.`,
        receipt: {
          instanceId: receipt.instanceId,
          recordId: receipt.recordId,
          form: at.form,
        },
      })
      return false
    }
    pendingSaves.current.delete(receipt.recordId)
    const { outcome } = receipt
    if (outcome.outcome === 'completed') {
      const saved = at.saved
      if (saved) {
        const revision = outcome.affected.find(
          (affected) => affected.id === recordId,
        )?.revision
        // Clear what this save wrote, and only while it still holds what was
        // saved: an edit made while the call ran stays, now over the revision
        // this save left the record at.
        setDraft((held) => {
          const values = { ...held.values }
          for (const [fieldKey, value] of Object.entries(saved))
            if (
              Object.hasOwn(values, fieldKey) &&
              Object.is(values[fieldKey], value)
            )
              delete values[fieldKey]
          return Object.keys(values).length
            ? { values, base: revision ?? held.base }
            : NO_DRAFT
        })
      }
      const moved = outcome.affected
        .map((affected) => `r${affected.revision}`)
        .join(', ')
      setStatus({
        kind: 'saved',
        message: `${receipt.actionKey} saved${moved ? ` · ${moved}` : ''}.`,
      })
      return true
    }
    setStatus({
      kind: 'failed',
      message: `${outcome.code}: ${outcome.message}`,
      reload: outcome.code === codes.REVISION_CONFLICT,
    })
    return false
  }

  const run = async (
    action: ActionSpec,
    values: Record<string, unknown>,
    at: { revision: number; saved?: Record<string, unknown>; form?: number },
  ) => {
    if (!row || running.current) return
    running.current = true
    setBusy(true)
    setStatus({ kind: 'pending', message: `${action.label}…` })
    try {
      const receipt = await invoking.mutateAsync({
        instanceId,
        actionKey: action.key,
        recordId: row.id,
        // The revision the person started from: a record that moved on is
        // refused rather than overwritten.
        expectedRevision: at.revision,
        inputs: values,
      })
      if (report(receipt, at)) closeForm(at.form)
    } catch (error) {
      setStatus(refusedStatus(error, action.label))
    } finally {
      running.current = false
      setBusy(false)
    }
  }

  /** Run the save action over everything edited, at the revision the edits started from. */
  const commit = (action: ActionSpec) => {
    if (!row) return
    const saved = draft.values
    setConfirming(undefined)
    // An absent optional input leaves its field alone. Re-sending an
    // untouched lifecycle status would attempt a transition to itself.
    const values = inputsFor(action, saved)
    const current = inputsFor(action, row.fields)
    for (const input of action.input) {
      if (
        input.required &&
        !Object.hasOwn(values, input.key) &&
        Object.hasOwn(current, input.key)
      )
        values[input.key] = current[input.key]
    }
    void run(action, values, {
      revision: draft.base ?? row.revision,
      saved,
    })
  }

  /**
   * Save what was edited: a declared action this caller may run whose effects
   * are exactly those fields, else a generic one that writes each from an
   * input, else nothing. An action that would write something other than what
   * was entered is shown first and runs only when the person says so. What no
   * action declares is left unsaid rather than written sideways.
   */
  const save = () => {
    if (!row || !dirty.length) return
    const plan = saveAction(definition, key, draft.values, (action) =>
      canInvoke(grant, action.key),
    )
    if (!plan) {
      setStatus({
        kind: 'failed',
        message: `No declared action your grant reaches covers ${dirty.join(', ')}${
          actions.length
            ? `. This definition's actions write: ${actions
                .map(
                  (one) =>
                    `${one.label} (${one.effects.map((e) => e.fieldKey).join(', ') || 'nothing'})`,
                )
                .join('; ')}.`
            : '. This definition declares no action over this collection.'
        }`,
      })
      return
    }
    if (plan.overrides.length) return setConfirming(plan)
    commit(plan.action)
  }

  /**
   * Read a journaled call's receipt back. A finished one takes the same path as
   * a call that finished at once: the record is read again and its form closes.
   * An answer that comes after the status moved on to another call is dropped.
   */
  const check = async () => {
    const at = status?.receipt
    if (!at) return
    const current = () => {
      const held = shownStatus.current?.receipt
      return held?.instanceId === at.instanceId && held.recordId === at.recordId
    }
    try {
      const receipt = await receipts.mutateAsync(at)
      if (!current()) return
      if (
        report(receipt, {
          saved: pendingSaves.current.get(at.recordId),
          form: at.form,
        })
      )
        closeForm(at.form)
    } catch (error) {
      if (!current()) return
      setStatus({
        kind: 'failed',
        message: refusalMessage(error, 'The receipt'),
        reload: isReloadConflict(error),
        receipt: at,
      })
    }
  }

  /**
   * Read the record again. The person has now seen where it is, so unsaved
   * edits start over from that revision; an open action form was filled against
   * the record as it was, so it closes.
   */
  const reload = async () => {
    if (running.current) return
    running.current = true
    setBusy(true)
    setStatus(undefined)
    setCalling(undefined)
    setConfirming(undefined)
    try {
      const fresh = await found.refetch()
      if (!fresh.isSuccess || fresh.data?.kind !== 'found') return
      const { revision } = fresh.data.row
      setDraft((held) =>
        Object.keys(held.values).length ? { ...held, base: revision } : held,
      )
      setEditing((open) => open && { ...open, revision })
    } finally {
      running.current = false
      setBusy(false)
    }
  }

  if (found.isPending) return <Loading rows={4} />
  if (found.isError)
    return (
      <DescribeState
        error={found.error}
        what="This record"
        onRetry={() => void found.refetch()}
      />
    )
  if (lookup?.kind === 'incomplete')
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>Still looking</EmptyTitle>
          <EmptyDescription>
            <code className="font-mono text-xs">{recordId}</code> is in this
            instance, but the pages read so far of{' '}
            {Object.keys(lookup.resume).join(', ')} do not hold it, so which
            collection it belongs to is not known yet.
          </EmptyDescription>
        </EmptyHeader>
        <Button
          size="sm"
          variant="outline"
          onClick={() => setResume(lookup.resume)}
        >
          Keep looking
        </Button>
      </Empty>
    )
  if (!row || !shown)
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>Not in this capability</EmptyTitle>
          <EmptyDescription>
            The instance has no record{' '}
            <code className="font-mono text-xs">{recordId}</code> for you to
            read. Either it is not in {definition.name}'s collections, or its
            collection's context policy withholds it from this caller — the
            contract answers both with one code, so which it is cannot be told
            from here.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    )

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-background">
      <header className="flex shrink-0 items-center gap-2 border-b border-separator px-3 py-1.5">
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">
          {rowTitle(fields, row)}
        </span>
        <span className="shrink-0 text-xs text-ink-faint">
          {schema?.label ?? key} · r{row.revision}
        </span>
        {context && (
          <Button size="xs" variant="outline" onClick={() => askAbout(context)}>
            <Icon.Sparkle className="size-3.5" />
            Ask Theorem
          </Button>
        )}
      </header>
      <StatusLine
        status={status}
        onClear={() => setStatus(undefined)}
        onReload={() => void reload()}
        onCheck={() => void check()}
      />
      <div className="min-h-0 flex-1 overflow-auto">
        {fields.map((field) => {
          const spec = fieldSpecOf(field)
          const dirtyField = Object.hasOwn(draft.values, field.key)
          const editable = inlineEditable(field)
          const relation = field.fieldType.kind === 'relation'
          return (
            <div
              key={field.key}
              className="flex items-start gap-3 border-b border-separator/60 px-3 py-2"
            >
              <span className="w-40 shrink-0 pt-0.5 text-xs text-ink-muted">
                {field.label}
                {field.required && <span className="text-error-ink"> *</span>}
              </span>
              <div className="min-w-0 flex-1">
                {editing?.fieldKey === field.key &&
                  (relation ? (
                    <RelationPick
                      instanceId={instanceId}
                      definition={definition}
                      schemas={described.collectionSchemas}
                      field={field}
                      value={shown.values[field.key]}
                      onCommit={(value) => write(field.key, value)}
                      onCancel={() => setEditing(undefined)}
                    />
                  ) : (
                    <FieldEditor
                      field={spec}
                      // A cleared draft value is null and stays cleared on reopening.
                      value={shown.values[field.key]}
                      row={shown}
                      // The contract cannot clear a field.
                      clearable={false}
                      onCommit={(value) => write(field.key, value)}
                      onDiscard={() => setEditing(undefined)}
                    />
                  ))}
                {editing?.fieldKey !== field.key && (
                  <span className="flex items-center gap-2">
                    <FieldDisplay row={shown} field={spec} />
                    {(editable || relation) && grant.read && (
                      <button
                        type="button"
                        aria-label={`Edit ${field.label}`}
                        onClick={() =>
                          setEditing({
                            fieldKey: field.key,
                            revision: row.revision,
                          })
                        }
                        className="rounded p-0.5 text-ink-faint hover:bg-hover hover:text-ink focus-visible:outline-2 focus-visible:outline-focus"
                      >
                        <Icon.Edit className="size-3.5" />
                      </button>
                    )}
                  </span>
                )}
              </div>
              {dirtyField && (
                <span className="shrink-0 pt-0.5 text-xs text-ink-faint">
                  unsaved
                </span>
              )}
            </div>
          )
        })}
      </div>
      <footer className="flex shrink-0 flex-col gap-2 border-t border-separator px-3 py-2">
        {confirming && (
          <div
            role="alert"
            className="flex flex-wrap items-center gap-2 text-xs"
          >
            <span className="min-w-0 flex-1 text-ink">
              {confirming.action.label} writes{' '}
              {overrideText(confirming.overrides)}, not what you entered.
            </span>
            <Button
              size="xs"
              disabled={busy}
              onClick={() => commit(confirming.action)}
            >
              {confirming.action.label} anyway
            </Button>
            <Button
              size="xs"
              variant="ghost"
              onClick={() => setConfirming(undefined)}
            >
              Keep editing
            </Button>
          </div>
        )}
        {dirty.length > 0 && !confirming && (
          <div className="flex items-center gap-2">
            <Button
              size="xs"
              disabled={busy || !grant.invoke.length}
              aria-busy={busy}
              onClick={save}
            >
              {dirty.length === 1
                ? `Save ${fields.find((one) => one.key === dirty[0])?.label ?? dirty[0]}`
                : `Save ${dirty.length} fields`}
            </Button>
            <Button
              size="xs"
              variant="ghost"
              onClick={() => {
                setDraft(NO_DRAFT)
                setStatus(undefined)
              }}
            >
              Discard
            </Button>
            {draft.base !== undefined && draft.base !== row.revision && (
              <span className="text-xs text-ink-faint">
                edited from r{draft.base}
              </span>
            )}
          </div>
        )}
        {calling && (
          <ActionCall
            instanceId={instanceId}
            action={calling.action}
            row={calling.row}
            schemas={described.collectionSchemas}
            submitLabel={calling.action.label}
            busy={busy}
            onSubmit={(values) =>
              void run(calling.action, values, {
                revision: calling.row.revision,
                form: calling.form,
              })
            }
            onCancel={() => setCalling(undefined)}
          />
        )}
        {!calling && (
          <div className="flex flex-wrap items-center gap-2">
            {actions.map((action) => (
              <Button
                key={action.key}
                size="xs"
                variant="outline"
                disabled={!canInvoke(grant, action.key) || busy}
                title={
                  canInvoke(grant, action.key)
                    ? `At revision ${row.revision}`
                    : 'Your grant does not reach this action'
                }
                onClick={() =>
                  action.input.length
                    ? setCalling({ action, row, form: ++forms.current })
                    : void run(action, {}, { revision: row.revision })
                }
              >
                {action.label}
              </Button>
            ))}
            {!actions.length && (
              <p className="text-xs text-ink-faint">
                This definition declares no action over {schema?.label ?? key}.
              </p>
            )}
          </div>
        )}
      </footer>
    </div>
  )
}

/**
 * The module: it shows the record its Item input names, else the one its
 * Record setting does. The instance comes from this module's own setting or
 * its Instance input, never from the record item, so a selection wired from
 * another page cannot reach across instances.
 */
export function CapabilityRecordModule(view: ModuleViewProps) {
  const { output } = view
  const instanceId = text(view.settings.instanceId)
  const described = useCapabilityDescribe(instanceId || undefined)
  const named = parseCapabilityRecordItem(
    view.inputs.record ?? view.settings.recordId,
  )
  const recordId = named?.recordId ?? ''
  const showing =
    !!instanceId &&
    !!recordId &&
    described.isSuccess &&
    described.data.callerGrant.read
  // With no body on screen there is no record to wire onward: a page that
  // connects this module's outputs reads nothing rather than the last record.
  useEffect(() => {
    if (showing) return
    output('selected', undefined)
    output('context', undefined)
  }, [showing, output])
  if (!instanceId)
    return (
      <p className="p-3 text-sm text-ink-muted">
        Name the capability instance in this module's settings.
      </p>
    )
  if (!recordId)
    return (
      <p className="p-3 text-sm text-ink-muted">
        Nothing to show yet. Connect its Record, or name a record id in its
        settings.
      </p>
    )
  if (described.isPending) return <Loading rows={4} />
  if (described.isError)
    return (
      <DescribeState
        error={described.error}
        onRetry={() => void described.refetch()}
      />
    )
  if (!described.data.callerGrant.read)
    return <PermissionState name={described.data.definition.name} />
  return (
    <CapabilityRecordBody
      // A new record starts the form over: its draft and its notices belong to
      // the record it was reading.
      key={`${instanceId}:${recordId}`}
      view={view}
      described={described.data}
      recordId={recordId}
      collectionKey={named?.collectionKey || undefined}
    />
  )
}
