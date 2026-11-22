// SOURCING: the authoring controls the plan's UI sections name (fields, views, and from slice 2 their
// lifecycle, agent access, history and templates), over the author route in lib/capabilities/api; the
// records' Segmented control, the app's Dialog, and the shared parts in ./authoring-parts. Each control
// sends one patch naming the definition id describe answered with, so two people authoring one
// definition cannot overwrite each other blind.
import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Segmented } from '@/components/records/field-form'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { fieldControl } from '@/components/pages/resource-field'
import { codes } from '@/lib/capabilities/contract'
import type {
  CapabilityFieldType,
  CollectionSchema,
  DescribeResult,
  PatchOp,
} from '@/lib/capabilities/contract'
import {
  addFieldOp,
  isValidFieldKey,
  renameFieldOp,
  schemaFor,
} from '@/lib/capabilities/model'
import { refusalCode, refusalMessage } from '@/lib/capabilities/api'
import { AgentAccess } from './agent-access'
import { Choice, Row, StatusLine } from './authoring-parts'
import type { Status, Submit } from './authoring-parts'
import { DefinitionHistoryPanel } from './definition-history'
import { AddVariant, LifecycleEditor } from './field-editors'
import {
  capabilityKeys,
  useCapabilityAuthor,
  useCapabilityRepin,
} from './queries'
import { NewFromTemplate, SaveTemplate } from './templates'
import { ViewEditor } from './view-editor'

const SECTIONS = [
  { value: 'fields', label: 'Fields' },
  { value: 'views', label: 'Views' },
  { value: 'agent', label: 'Agent access' },
  { value: 'history', label: 'History' },
  { value: 'templates', label: 'Templates' },
] as const

type Section = (typeof SECTIONS)[number]['value']

const TABS = [
  { value: 'add', label: 'Add field' },
  { value: 'rename', label: 'Rename' },
  { value: 'variant', label: 'Add variant' },
  { value: 'lifecycle', label: 'Lifecycle' },
] as const

type Tab = (typeof TABS)[number]['value']

/** The capability field vocabulary, as the contract declares it. */
const TYPES: Array<{ value: CapabilityFieldType['kind']; label: string }> = [
  { value: 'text', label: 'Text' },
  { value: 'number', label: 'Number' },
  { value: 'integer', label: 'Integer' },
  { value: 'boolean', label: 'True/False' },
  { value: 'date', label: 'Date' },
  { value: 'timestamp', label: 'Date and time' },
  { value: 'enum', label: 'Select' },
  { value: 'reference', label: 'Reference' },
]

/** The chosen type, with whatever its kind needs. */
function fieldTypeOf(
  kind: CapabilityFieldType['kind'],
  variants: string,
  referenced: string,
): CapabilityFieldType {
  switch (kind) {
    case 'enum':
      return {
        kind: 'enum',
        variants: variants
          .split(',')
          .map((one) => one.trim())
          .filter(Boolean),
      }
    case 'reference':
      return { kind: 'reference', collectionKey: referenced }
    case 'text':
    case 'number':
    case 'integer':
    case 'boolean':
    case 'date':
    case 'timestamp':
      return { kind }
  }
}

/**
 * The authoring controls for one instance, opened from the table module that
 * shows its rows. A patch names the definition id describe answered with; a
 * stale one is refused and the dialog says so, having read the current
 * definition back.
 */
export function AuthoringDialog({
  instanceId,
  described,
  viewKey,
  onClose,
  onAsk,
  onOpenInstance,
}: {
  instanceId: string
  described: DescribeResult
  /** The view the module is showing, which the view editor starts from. */
  viewKey: string
  onClose: () => void
  /** Put what the module shows in the current conversation, as its Ask does. */
  onAsk?: () => void
  /** Switch the module to another instance, such as one just made from a template. */
  onOpenInstance?: (instanceId: string) => void
}) {
  const [section, setSection] = useState<Section>('fields')
  const [tab, setTab] = useState<Tab>('add')
  const [status, setStatus] = useState<Status | undefined>()
  const authoring = useCapabilityAuthor(instanceId)
  const repinning = useCapabilityRepin(instanceId)
  const client = useQueryClient()
  const { definition, collectionSchemas: schemas } = described
  const expectedDefinitionId = described.definitionId

  const collections = definition.collections.map((collection) => ({
    value: collection.key,
    label: collection.label,
  }))

  const submit: Submit = async (ops, what) => {
    if (!expectedDefinitionId) {
      setStatus({
        kind: 'failed',
        message:
          'Nothing is loaded to author against. Reload the view, then try again.',
      })
      return false
    }
    setStatus({ kind: 'pending', message: `${what}…` })
    try {
      const result = await authoring.mutateAsync({
        expectedDefinitionId,
        ops,
      })
      setStatus({
        kind: 'saved',
        message: `${what} · the definition is now ${result.definitionId}.`,
      })
      return true
    } catch (error) {
      if (refusalCode(error) === codes.DEFINITION_CONFLICT) {
        // Read the current definition back before asking again, so the retry is
        // authored against what is really there.
        void client.invalidateQueries({
          queryKey: capabilityKeys.instance(instanceId),
        })
        setStatus({
          kind: 'failed',
          message: `${refusalMessage(error, 'Authoring')} The current definition has been read again: check your change against the fields now shown and submit it once more.`,
        })
        return false
      }
      setStatus({ kind: 'failed', message: refusalMessage(error, 'Authoring') })
      return false
    }
  }
  const one = (what: string) => (op: PatchOp) => void submit([op], what)

  /** Pin an earlier definition again. It names the version, not a base: no conflict to read back. */
  const repin = async (definitionId: string) => {
    setStatus({ kind: 'pending', message: `Re-pinning to ${definitionId}…` })
    try {
      const result = await repinning.mutateAsync(definitionId)
      setStatus({
        kind: 'saved',
        message: `Re-pinned · the instance now uses ${result.definitionId}. Records are not changed.`,
      })
    } catch (error) {
      setStatus({
        kind: 'failed',
        message: refusalMessage(error, 'Re-pinning'),
      })
    }
  }
  const busy = authoring.isPending || repinning.isPending

  return (
    <Dialog open onOpenChange={(shown) => !shown && onClose()}>
      <DialogContent showCloseButton={false} className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Author {definition.name}</DialogTitle>
          <DialogDescription>
            A change mints a new definition version and re-pins this instance.
            Records never move.
          </DialogDescription>
        </DialogHeader>

        <Segmented
          value={section}
          options={[...SECTIONS]}
          onChange={(next) => {
            setSection(next)
            setStatus(undefined)
          }}
          label="What to author"
        />
        <StatusLine status={status} />

        <div className="flex max-h-[60vh] flex-col gap-2 overflow-y-auto">
          {section === 'fields' && (
            <>
              <Segmented
                value={tab}
                options={[...TABS]}
                onChange={setTab}
                label="What to change"
              />
              {tab === 'add' && (
                <AddField
                  collections={collections}
                  schemas={schemas}
                  busy={busy}
                  onSubmit={one('Field added')}
                />
              )}
              {tab === 'rename' && (
                <RenameField
                  collections={collections}
                  schemas={schemas}
                  busy={busy}
                  onSubmit={one('Field renamed')}
                />
              )}
              {tab === 'variant' && (
                <AddVariant
                  definition={definition}
                  schemas={schemas}
                  busy={busy}
                  onSubmit={submit}
                />
              )}
              {tab === 'lifecycle' && (
                <LifecycleEditor
                  definition={definition}
                  schemas={schemas}
                  busy={busy}
                  onSubmit={submit}
                />
              )}
            </>
          )}
          {section === 'views' && (
            <ViewEditor
              definition={definition}
              schemas={schemas}
              startViewKey={viewKey}
              busy={busy}
              onSubmit={submit}
            />
          )}
          {section === 'agent' && (
            <AgentAccess
              definition={definition}
              grants={described.grants}
              busy={busy}
              onSubmit={submit}
              onAsk={onAsk}
            />
          )}
          {section === 'history' && (
            <DefinitionHistoryPanel
              instanceId={instanceId}
              busy={busy}
              onRepin={(definitionId) => void repin(definitionId)}
            />
          )}
          {section === 'templates' && (
            <div className="flex flex-col gap-4">
              <SaveTemplate instanceId={instanceId} definition={definition} />
              <NewFromTemplate onOpen={onOpenInstance} />
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function AddField({
  collections,
  schemas,
  busy,
  onSubmit,
}: {
  collections: Array<{ value: string; label: string }>
  schemas: CollectionSchema[]
  busy: boolean
  onSubmit: (op: PatchOp) => void
}) {
  const [collectionKey, setCollectionKey] = useState(
    collections[0]?.value ?? '',
  )
  const [key, setKey] = useState('')
  const [label, setLabel] = useState('')
  const [kind, setKind] = useState<CapabilityFieldType['kind']>('text')
  const [variants, setVariants] = useState('')
  const [referenced, setReferenced] = useState(collections[0]?.value ?? '')

  const fieldType = fieldTypeOf(kind, variants, referenced)
  const problems: string[] = []
  if (!collectionKey) problems.push('choose a collection')
  if (!isValidFieldKey(key)) problems.push('a lower_snake_case key')
  if (!label.trim()) problems.push('a label')
  if (fieldType.kind === 'enum' && !fieldType.variants.length)
    problems.push('at least one variant')
  if (kind === 'reference' && !referenced) problems.push('what it refers to')

  return (
    <div className="flex flex-col gap-2">
      <Row label="Collection">
        <Choice
          label="Collection"
          value={collectionKey}
          options={collections}
          onChange={setCollectionKey}
        />
      </Row>
      <Row
        label="Field key"
        hint="Stable: a view and an action name a field by it."
      >
        <input
          aria-label="Field key"
          className={fieldControl}
          value={key}
          onChange={(event) => setKey(event.target.value.trim())}
          placeholder="effort_minutes"
        />
      </Row>
      <Row label="Label">
        <input
          aria-label="Field label"
          className={fieldControl}
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          placeholder="Effort (minutes)"
        />
      </Row>
      <Row label="Type">
        <Choice
          label="Field type"
          value={kind}
          options={TYPES.map((type) => ({
            value: type.value,
            label: type.label,
          }))}
          onChange={(value) => setKind(value as CapabilityFieldType['kind'])}
        />
      </Row>
      {kind === 'enum' && (
        <Row label="Variants" hint="Comma-separated.">
          <input
            aria-label="Enum variants"
            className={fieldControl}
            value={variants}
            onChange={(event) => setVariants(event.target.value)}
            placeholder="next, done"
          />
        </Row>
      )}
      {kind === 'reference' && (
        <Row label="Refers to">
          <Choice
            label="Referenced collection"
            value={referenced}
            options={collections}
            onChange={setReferenced}
          />
        </Row>
      )}
      <p className="text-xs text-ink-faint">
        {schemaFor(schemas, collectionKey)?.fields.length ?? 0} fields are
        already declared here. Slice 1 adds optional fields only: a required
        field, a removal or a type change is refused as unsupported.
      </p>
      {problems.length > 0 && (
        <p className="text-xs text-ink-faint">
          Still to do: {problems.join(', ')}.
        </p>
      )}
      <Button
        size="sm"
        disabled={problems.length > 0 || busy}
        aria-busy={busy}
        aria-label="Add optional field"
        onClick={() =>
          onSubmit(
            addFieldOp(collectionKey, { key, label: label.trim(), fieldType }),
          )
        }
      >
        Add field
      </Button>
    </div>
  )
}

function RenameField({
  collections,
  schemas,
  busy,
  onSubmit,
}: {
  collections: Array<{ value: string; label: string }>
  schemas: CollectionSchema[]
  busy: boolean
  onSubmit: (op: PatchOp) => void
}) {
  const [collectionKey, setCollectionKey] = useState(
    collections[0]?.value ?? '',
  )
  const fields = schemaFor(schemas, collectionKey)?.fields ?? []
  const [fieldKey, setFieldKey] = useState('')
  const chosen = fields.find((field) => field.key === fieldKey) ?? fields[0]
  const [label, setLabel] = useState('')

  return (
    <div className="flex flex-col gap-2">
      <Row label="Collection">
        <Choice
          label="Collection"
          value={collectionKey}
          options={collections}
          onChange={(next) => {
            setCollectionKey(next)
            setFieldKey('')
          }}
        />
      </Row>
      <Row label="Field">
        <Choice
          label="Field"
          value={chosen?.key ?? ''}
          options={fields.map((field) => ({
            value: field.key,
            label: field.label,
          }))}
          onChange={setFieldKey}
        />
      </Row>
      <Row
        label="New label"
        hint="The field keeps its key, so views and actions still name it."
      >
        <input
          aria-label="New label"
          className={fieldControl}
          value={label}
          placeholder={chosen?.label ?? 'Current label'}
          onChange={(event) => setLabel(event.target.value)}
        />
      </Row>
      <Button
        size="sm"
        disabled={!chosen || !label.trim() || busy}
        aria-busy={busy}
        onClick={() =>
          chosen &&
          onSubmit(renameFieldOp(collectionKey, chosen.key, label.trim()))
        }
      >
        Rename field
      </Button>
    </div>
  )
}
