// SOURCING: the records' field controls (components/records/fields) write and read one value, so a
// capability record is edited with the same keys the CRM uses; the page module boundary
// (lib/modules/registry) and the composer reference path. Every read and write is the instance's own
// contract: the resolved fields from describe, one declared action per save.
import { useEffect, useMemo, useState } from 'react'
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
import {
  isReloadConflict,
  readReceipt,
  refusalMessage,
} from '@/lib/capabilities/api'
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
} from '@/lib/capabilities/model'
import { codes } from '@/lib/capabilities/contract'
import type {
  ActionSpec,
  CapabilityDefinition,
  CollectionSchema,
  DescribeResult,
  InvocationReceipt,
  ResolvedField,
} from '@/lib/capabilities/contract'
import { capabilityContextReference } from '@/lib/capabilities/reference'
import type { ModuleViewProps } from '@/lib/modules/registry'
import { usePageId } from '../pages/page-route'
import { ActionForm } from './action-form'
import { DescribeState, Loading, PermissionState, StatusLine } from './states'
import type { Status } from './states'
import {
  useCapabilityDescribe,
  useCapabilityInvoke,
  useCapabilityPickers,
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

/** A relation value, picked from the collection that target is part of. */
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
        onChange={(event) => onCommit(event.target.value || null)}
      >
        <option value="">(none)</option>
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
  const pageId = usePageId()
  const instanceId = text(view.settings.instanceId)
  const definition = described.definition
  const grant = described.callerGrant
  const found = useCapabilityRecord(
    instanceId,
    definition,
    recordId,
    collectionKey,
  )
  const invoking = useCapabilityInvoke()

  const [draft, setDraft] = useState<Record<string, unknown>>({})
  const [editing, setEditing] = useState<string>()
  const [status, setStatus] = useState<Status>()
  const [calling, setCalling] = useState<ActionSpec>()
  const [busy, setBusy] = useState(false)

  const row = found.data?.row
  const key = found.data?.collectionKey ?? collectionKey ?? ''
  const schema = schemaFor(described.collectionSchemas, key)
  // Stable while the schema is, so what hangs on it does not re-run each render.
  const fields = useMemo(() => schema?.fields ?? [], [schema])
  const actions = useMemo(
    () => updateActions(definition, key),
    [definition, key],
  )
  const dirty = Object.keys(draft)
  const shown = useMemo(
    () =>
      row
        ? { ...registerRowOf(row), values: { ...row.fields, ...draft } }
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
            purpose: definition.purpose,
            label: `${definition.name} · ${rowTitle(fields, row)}`,
            selected: [{ id: row.id, revision: row.revision }],
            // The record was named, not paged: no view filter narrowed it and no
            // page cut it short, so the agent reads this one row at this revision.
            filtered: false,
            truncated: false,
          })
        : undefined,
    [row, shown, instanceId, key, pageId, definition, fields],
  )

  // What this module shows is also what the page can wire onward: its Selected
  // item and the context envelope, both at the revision on screen.
  useEffect(() => output('context', context), [output, context])
  useEffect(() => {
    if (context) emit('context', context)
  }, [emit, context])
  useEffect(() => {
    if (!row) return
    output(
      'selected',
      capabilityRecordItem(instanceId, key, row.id, rowTitle(fields, row)),
    )
  }, [output, row, instanceId, key, fields])

  const report = (receipt: InvocationReceipt): boolean => {
    if (receipt.status === 'dispatched') {
      setStatus({
        kind: 'pending',
        message: `${receipt.actionKey} is journaled and has not finished, so whether it took effect is not yet known.`,
        receipt: { instanceId: receipt.instanceId, recordId: receipt.recordId },
      })
      return false
    }
    const { outcome } = receipt
    if (outcome.outcome === 'completed') {
      setDraft({})
      const at = outcome.affected
        .map((affected) => `r${affected.revision}`)
        .join(', ')
      setStatus({
        kind: 'saved',
        message: `${receipt.actionKey} saved${at ? ` · ${at}` : ''}.`,
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

  const run = async (action: ActionSpec, values: Record<string, unknown>) => {
    if (!row) return
    setBusy(true)
    setStatus({ kind: 'pending', message: `${action.label}…` })
    try {
      const receipt = await invoking.mutateAsync({
        instanceId,
        actionKey: action.key,
        recordId: row.id,
        // The revision the person is looking at: a record that moved on is
        // refused rather than overwritten.
        expectedRevision: row.revision,
        inputs: values,
      })
      if (report(receipt)) setCalling(undefined)
    } catch (error) {
      setStatus({
        kind: 'failed',
        message: refusalMessage(error, action.label),
        reload: isReloadConflict(error),
      })
    } finally {
      setBusy(false)
    }
  }

  /**
   * Save what was edited: a declared action whose effects are exactly those
   * fields, else a generic one that takes an input for each, else nothing. What
   * the action does not declare is left unsaid rather than written sideways.
   */
  const save = () => {
    if (!row || !dirty.length) return
    const action = saveAction(definition, key, dirty)
    if (!action) {
      setStatus({
        kind: 'failed',
        message: `No declared action covers ${dirty.join(', ')}${
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
    // The action's inputs are the record's current values with the edits over
    // them, so an input the person never touched is not sent as a blank.
    void run(action, inputsFor(action, { ...row.fields, ...draft }))
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
        onReload={() => void found.refetch()}
        onCheck={async () => {
          const at = status?.receipt
          if (!at) return
          try {
            report(await readReceipt(at.instanceId, at.recordId))
          } catch (error) {
            setStatus({
              kind: 'failed',
              message: refusalMessage(error, 'The receipt'),
              reload: isReloadConflict(error),
            })
          }
        }}
      />
      <div className="min-h-0 flex-1 overflow-auto">
        {fields.map((field) => {
          const spec = fieldSpecOf(field)
          const dirtyField = Object.hasOwn(draft, field.key)
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
                {editing === field.key &&
                  (relation ? (
                    <RelationPick
                      instanceId={instanceId}
                      definition={definition}
                      schemas={described.collectionSchemas}
                      field={field}
                      value={draft[field.key] ?? row.fields[field.key]}
                      onCommit={(value) => {
                        setDraft((held) => ({ ...held, [field.key]: value }))
                        setEditing(undefined)
                      }}
                      onCancel={() => setEditing(undefined)}
                    />
                  ) : (
                    <FieldEditor
                      field={spec}
                      value={draft[field.key] ?? row.fields[field.key]}
                      row={shown}
                      onCommit={(value) => {
                        setDraft((held) => ({ ...held, [field.key]: value }))
                        setEditing(undefined)
                      }}
                      onDiscard={() => setEditing(undefined)}
                    />
                  ))}
                {editing !== field.key && (
                  <span className="flex items-center gap-2">
                    <FieldDisplay row={shown} field={spec} />
                    {(editable || relation) && grant.read && (
                      <button
                        type="button"
                        aria-label={`Edit ${field.label}`}
                        onClick={() => setEditing(field.key)}
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
        {dirty.length > 0 && (
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
                setDraft({})
                setStatus(undefined)
              }}
            >
              Discard
            </Button>
          </div>
        )}
        {calling && (
          <ActionForm
            action={calling}
            defaults={row.fields}
            submitLabel={calling.label}
            busy={busy}
            onSubmit={(values) => void run(calling, inputsFor(calling, values))}
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
                    ? setCalling(action)
                    : void run(action, inputsFor(action, row.fields))
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
 * Record setting does. The instance comes from this module's own setting, so a
 * selection wired from another page cannot reach across instances.
 */
export function CapabilityRecordModule(view: ModuleViewProps) {
  const instanceId = text(view.settings.instanceId)
  const described = useCapabilityDescribe(instanceId || undefined)
  const named = parseCapabilityRecordItem(
    view.inputs.record ?? view.settings.recordId,
  )
  const recordId = named?.recordId ?? ''
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
