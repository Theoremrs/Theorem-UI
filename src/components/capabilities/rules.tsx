// SOURCING: the app's Dialog and Button, coss ui Switch and Checkbox, the authoring parts' Choice, the
// records' Segmented, the native field styling pages/resource-field.tsx uses, and states.tsx's
// StatusLine, as the slice-1 authoring dialog composes them. Every control sends one PatchOp through
// the author route (useCapabilityAuthor) naming the definition id it read; the rule checks are
// lib/capabilities/rules.
import { useState } from 'react'
import type { ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Checkbox } from '@/components/coss/checkbox'
import { Switch } from '@/components/coss/switch'
import { Icon } from '@/components/icons'
import { fieldControl } from '@/components/pages/resource-field'
import { localDateTimeText } from '@/components/records/fields'
import { Segmented } from '@/components/records/field-form'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { refusalCode, ruleRefusalMessage } from '@/lib/capabilities/api'
import { codes } from '@/lib/capabilities/contract'
import type {
  ActionSpec,
  CapabilityDefinition,
  CollectionSchema,
  DescribeResult,
  InputField,
  PatchOp,
  RuleEnablement,
  RuleInputSource,
  RuleSpec,
  RuleTrigger,
} from '@/lib/capabilities/contract'
import { parseValue, schemaFor, valueText } from '@/lib/capabilities/model'
import {
  addRuleOp,
  currentRuleStates,
  describeTrigger,
  mayRunInBackground,
  removeRuleOp,
  replaceRuleOp,
  ruleActions,
  ruleEnabled,
  ruleProblems,
  rulesOf,
  setRuleEnabledOp,
} from '@/lib/capabilities/rules'
import { Choice } from './authoring-parts'
import { capabilityKeys, useCapabilityAuthor } from './queries'
import { RunHistory } from './runs'
import { StatusLine } from './states'
import type { Status } from './states'

const TRIGGERS: Array<{ value: RuleTrigger['kind']; label: string }> = [
  { value: 'record_created', label: 'When a record is created' },
  { value: 'record_updated', label: 'When a record changes' },
  { value: 'transition', label: 'When a record moves to a state' },
  { value: 'schedule', label: 'On a schedule' },
]

type SourceKind = RuleInputSource['source'] | 'unset'

/** One action input as the editor holds it: the source chosen, and its text or field. */
type SourceDraft = { source: SourceKind; text: string; fieldKey: string }

/** A rule as the editor holds it, so switching a trigger kind keeps what was typed. */
type Draft = {
  key: string
  label: string
  kind: RuleTrigger['kind']
  collectionKey: string
  fieldKeys: string[]
  to: string
  from: string[]
  interval: string
  start: string
  actionKey: string
  sources: Record<string, SourceDraft>
}

type TriggerDraft = Pick<
  Draft,
  'kind' | 'collectionKey' | 'fieldKeys' | 'to' | 'from' | 'interval' | 'start'
>

/** A new rule's trigger: a record created in the first collection, the other kinds' fields blank. */
const blankTrigger = (definition: CapabilityDefinition): TriggerDraft => ({
  kind: 'record_created',
  collectionKey: definition.collections[0]?.key ?? '',
  fieldKeys: [],
  to: '',
  from: [],
  interval: '60',
  start: '',
})

/** A trigger as the editor holds it: its own kind's fields filled, the other kinds' left blank. */
function triggerDraftOf(
  trigger: RuleTrigger,
  blank: TriggerDraft,
): TriggerDraft {
  switch (trigger.kind) {
    case 'record_created':
      return {
        ...blank,
        kind: trigger.kind,
        collectionKey: trigger.collectionKey,
      }
    case 'record_updated':
      return {
        ...blank,
        kind: trigger.kind,
        collectionKey: trigger.collectionKey,
        fieldKeys: trigger.fieldKeys ?? [],
      }
    case 'transition':
      return {
        ...blank,
        kind: trigger.kind,
        collectionKey: trigger.collectionKey,
        to: trigger.to,
        from: trigger.from ?? [],
      }
    case 'schedule':
      return {
        ...blank,
        kind: trigger.kind,
        interval: String(trigger.intervalMinutes),
        start:
          trigger.startAtMs === undefined
            ? ''
            : localDateTimeText(trigger.startAtMs),
      }
  }
}

/** One input's source as the editor holds it: a literal's text, a trigger field's key. */
const sourceDraftOf = (source: RuleInputSource): SourceDraft => ({
  source: source.source,
  text: source.source === 'literal' ? valueText(source.value) : '',
  fieldKey: source.source === 'trigger_field' ? source.fieldKey : '',
})

function draftOf(
  rule: RuleSpec | undefined,
  definition: CapabilityDefinition,
): Draft {
  const blank = blankTrigger(definition)
  if (!rule) return { key: '', label: '', ...blank, actionKey: '', sources: {} }
  return {
    key: rule.key,
    label: rule.label,
    ...triggerDraftOf(rule.trigger, blank),
    actionKey: rule.actionKey,
    sources: Object.fromEntries(
      Object.entries(rule.inputs).map(([key, source]) => [
        key,
        sourceDraftOf(source),
      ]),
    ),
  }
}

/** The lifecycle states a transition may name: the lifecycle field's variants. */
function statesOf(
  definition: CapabilityDefinition,
  schemas: ReadonlyArray<CollectionSchema>,
  collectionKey: string,
): string[] {
  const lifecycle = definition.collections.find(
    (one) => one.key === collectionKey,
  )?.lifecycle
  if (!lifecycle) return []
  const field = schemaFor([...schemas], collectionKey)?.fields.find(
    (one) => one.key === lifecycle.fieldKey,
  )
  if (field?.fieldType.kind === 'enum') return field.fieldType.variants
  return [
    ...new Set(lifecycle.transitions.flatMap((one) => [...one.from, one.to])),
  ]
}

/** A schedule as the draft holds it: a blank interval is left for the checks to name. */
function scheduleOf(draft: Draft): RuleTrigger {
  const intervalMinutes = Number(draft.interval.trim() || Number.NaN)
  const startAtMs = draft.start ? new Date(draft.start).getTime() : Number.NaN
  return Number.isFinite(startAtMs)
    ? { kind: 'schedule', intervalMinutes, startAtMs }
    : { kind: 'schedule', intervalMinutes }
}

function triggerOf(draft: Draft): RuleTrigger {
  const collectionKey = draft.collectionKey
  switch (draft.kind) {
    case 'record_created':
      return { kind: 'record_created', collectionKey }
    case 'record_updated':
      return draft.fieldKeys.length
        ? { kind: 'record_updated', collectionKey, fieldKeys: draft.fieldKeys }
        : { kind: 'record_updated', collectionKey }
    case 'transition':
      return draft.from.length
        ? { kind: 'transition', collectionKey, to: draft.to, from: draft.from }
        : { kind: 'transition', collectionKey, to: draft.to }
    case 'schedule':
      return scheduleOf(draft)
  }
}

function sourceOf(
  field: InputField,
  draft: SourceDraft,
): RuleInputSource | undefined {
  switch (draft.source) {
    case 'unset':
      return undefined
    case 'now':
      return { source: 'now' }
    case 'trigger_field':
      return { source: 'trigger_field', fieldKey: draft.fieldKey }
    case 'literal': {
      // Kept as typed when it does not parse, so the problems name it.
      const parsed = parseValue(field.fieldType, draft.text)
      return { source: 'literal', value: parsed.ok ? parsed.value : draft.text }
    }
  }
}

function ruleOf(draft: Draft, action: ActionSpec | undefined): RuleSpec {
  const inputs: Record<string, RuleInputSource> = {}
  for (const field of action?.input ?? []) {
    const held = draft.sources[field.key]
    const source = held && sourceOf(field, held)
    if (source) inputs[field.key] = source
  }
  return {
    key: draft.key,
    label: draft.label.trim(),
    trigger: triggerOf(draft),
    actionKey: draft.actionKey,
    inputs,
  }
}

/**
 * The sources a draft's inputs keep: a schedule has no triggering record to
 * read a field from, and a field the collection lacks becomes its first.
 */
function settledSources(
  sources: Record<string, SourceDraft>,
  kind: RuleTrigger['kind'],
  fieldKeys: string[],
): Record<string, SourceDraft> {
  const kept: Record<string, SourceDraft> = {}
  for (const [key, held] of Object.entries(sources)) {
    if (held.source === 'trigger_field' && kind === 'schedule') continue
    kept[key] =
      held.source === 'trigger_field' && !fieldKeys.includes(held.fieldKey)
        ? { ...held, fieldKey: fieldKeys[0] ?? '' }
        : held
  }
  return kept
}

/**
 * Keep a draft's choices inside what its trigger allows: an action the trigger
 * may invoke, states and fields the collection has, a source an input can take.
 */
function settle(
  draft: Draft,
  definition: CapabilityDefinition,
  schemas: ReadonlyArray<CollectionSchema>,
): Draft {
  const actions = ruleActions(triggerOf(draft), definition)
  const actionKey = actions.some((one) => one.key === draft.actionKey)
    ? draft.actionKey
    : (actions[0]?.key ?? '')
  const states = statesOf(definition, schemas, draft.collectionKey)
  const fields = schemaFor([...schemas], draft.collectionKey)?.fields ?? []
  const fieldKeys = fields.map((one) => one.key)
  return {
    ...draft,
    actionKey,
    to: states.includes(draft.to) ? draft.to : (states[0] ?? draft.to),
    from: draft.from.filter((one) => states.includes(one)),
    fieldKeys: draft.fieldKeys.filter((one) => fieldKeys.includes(one)),
    sources: settledSources(draft.sources, draft.kind, fieldKeys),
  }
}

/**
 * A caption over controls that name themselves. Not the authoring Row's
 * <label>: this one holds a group (ticked boxes, a source and its value), and
 * a label wraps one control; around a box it would also forward the click to
 * Base UI's hidden input and toggle it twice.
 */
function Captioned({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: ReactNode
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium text-ink-muted">{label}</span>
      {children}
      {hint && <span className="text-xs text-ink-faint">{hint}</span>}
    </div>
  )
}

/** A set of keys as ticked boxes, each named for assistive tech. */
function Ticks({
  prefix,
  options,
  value,
  onChange,
}: {
  prefix: string
  options: Array<{ value: string; label: string }>
  value: string[]
  onChange: (value: string[]) => void
}) {
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1.5">
      {options.map((option) => (
        // Not a <label>: a wrapping label forwards the click to Base UI's
        // hidden input and the box toggles twice. The box names itself.
        <span
          key={option.value}
          className="flex items-center gap-1.5 text-xs text-ink"
        >
          <Checkbox
            aria-label={`${prefix} ${option.label}`}
            checked={value.includes(option.value)}
            onCheckedChange={(checked) =>
              onChange(
                checked === true
                  ? [...value, option.value]
                  : value.filter((one) => one !== option.value),
              )
            }
          />
          {option.label}
        </span>
      ))}
    </div>
  )
}

type Options = Array<{ value: string; label: string }>

/**
 * What starts a rule, past its kind: the collection an event watches or a
 * schedule's interval and start, the fields a change watches, and the states
 * a transition moves between.
 */
function TriggerFields({
  draft,
  definition,
  fieldOptions,
  stateOptions,
  onChange: update,
}: {
  draft: Draft
  definition: CapabilityDefinition
  fieldOptions: Options
  stateOptions: Options
  onChange: (change: Partial<Draft>) => void
}) {
  const onEvent = draft.kind !== 'schedule'
  return (
    <>
      {onEvent ? (
        <Captioned label="Collection">
          <Choice
            label="Collection"
            value={draft.collectionKey}
            options={definition.collections.map((one) => ({
              value: one.key,
              label: one.label,
            }))}
            onChange={(collectionKey) => update({ collectionKey })}
          />
        </Captioned>
      ) : (
        <div className="grid grid-cols-2 gap-2">
          <Captioned
            label="Every (minutes)"
            hint="At least 5. A missed slot is not made up later."
          >
            <input
              aria-label="Every (minutes)"
              className={fieldControl}
              inputMode="numeric"
              value={draft.interval}
              onChange={(event) => update({ interval: event.target.value })}
            />
          </Captioned>
          <Captioned
            label="Starting at"
            hint="Optional; else when it is switched on."
          >
            <input
              aria-label="Starting at"
              type="datetime-local"
              className={fieldControl}
              value={draft.start}
              onChange={(event) => update({ start: event.target.value })}
            />
          </Captioned>
        </div>
      )}
      {draft.kind === 'record_updated' && (
        <Captioned
          label="Watching"
          hint="None ticked: any change to the record."
        >
          <Ticks
            prefix="Watch"
            options={fieldOptions}
            value={draft.fieldKeys}
            onChange={(fieldKeys) => update({ fieldKeys })}
          />
        </Captioned>
      )}
      {draft.kind === 'transition' && (
        <>
          <Captioned label="Moves to">
            <Choice
              label="Moves to"
              value={draft.to}
              options={stateOptions}
              onChange={(to) => update({ to })}
            />
          </Captioned>
          <Captioned label="From" hint="None ticked: from any state.">
            <Ticks
              prefix="From"
              options={stateOptions.filter((one) => one.value !== draft.to)}
              value={draft.from}
              onChange={(from) => update({ from })}
            />
          </Captioned>
        </>
      )}
    </>
  )
}

/** Where one action input's value comes from: unset, a typed value, the triggering record, or the run's time. */
function InputSource({
  field,
  held: given,
  onEvent,
  fieldOptions,
  onChange,
}: {
  field: InputField
  held: SourceDraft | undefined
  onEvent: boolean
  fieldOptions: Options
  onChange: (change: Partial<SourceDraft>) => void
}) {
  const held = given ?? {
    source: 'unset' as const,
    text: '',
    fieldKey: '',
  }
  const choices: Array<{ value: SourceKind; label: string }> = [
    { value: 'unset', label: 'Not set' },
    { value: 'literal', label: 'A value' },
    ...(onEvent
      ? [
          {
            value: 'trigger_field' as const,
            label: 'From the triggering record',
          },
        ]
      : []),
    ...(field.fieldType.kind === 'timestamp' || field.fieldType.kind === 'date'
      ? [{ value: 'now' as const, label: 'The time it runs' }]
      : []),
  ]
  return (
    <Captioned label={`${field.key}${field.required ? ' (required)' : ''}`}>
      <div className="flex items-center gap-1.5">
        <Choice
          label={`Source of ${field.key}`}
          value={held.source}
          options={choices}
          onChange={(source) => onChange({ source: source as SourceKind })}
        />
        {held.source === 'literal' && (
          <input
            aria-label={`Value of ${field.key}`}
            className={fieldControl}
            value={held.text}
            onChange={(event) => onChange({ text: event.target.value })}
          />
        )}
        {held.source === 'trigger_field' && (
          <Choice
            label={`Field for ${field.key}`}
            value={held.fieldKey}
            options={fieldOptions}
            onChange={(fieldKey) => onChange({ fieldKey })}
          />
        )}
      </div>
    </Captioned>
  )
}

function RuleEditor({
  definition,
  schemas,
  rule,
  busy,
  onSubmit,
  onCancel,
}: {
  definition: CapabilityDefinition
  schemas: CollectionSchema[]
  /** The rule being edited; none adds a new one. */
  rule: RuleSpec | undefined
  busy: boolean
  onSubmit: (rule: RuleSpec) => void
  onCancel: () => void
}) {
  const mode = rule ? 'replace' : 'add'
  const [draft, setDraft] = useState(() =>
    settle(draftOf(rule, definition), definition, schemas),
  )
  const update = (change: Partial<Draft>) =>
    setDraft((held) => settle({ ...held, ...change }, definition, schemas))
  const setSource = (key: string, change: Partial<SourceDraft>) =>
    setDraft((held) =>
      settle(
        {
          ...held,
          sources: {
            ...held.sources,
            [key]: {
              ...{ source: 'unset', text: '', fieldKey: '' },
              ...held.sources[key],
              ...change,
            },
          },
        },
        definition,
        schemas,
      ),
    )

  const trigger = triggerOf(draft)
  const onEvent = draft.kind !== 'schedule'
  const action = definition.actions.find((one) => one.key === draft.actionKey)
  const built = ruleOf(draft, action)
  const problems = ruleProblems(built, { definition, schemas, mode })
  const fields = schemaFor(schemas, draft.collectionKey)?.fields ?? []
  const fieldOptions = fields.map((one) => ({
    value: one.key,
    label: one.label,
  }))
  const states = statesOf(definition, schemas, draft.collectionKey)
  const stateOptions = states.map((one) => ({ value: one, label: one }))

  return (
    <div className="flex flex-col gap-2 rounded-md border border-separator p-3">
      <div className="grid grid-cols-2 gap-2">
        <Captioned label="Key" hint="Stable: runs name the rule by it.">
          <input
            aria-label="Rule key"
            className={fieldControl}
            value={draft.key}
            disabled={mode === 'replace'}
            placeholder="weekly_review"
            onChange={(event) => update({ key: event.target.value.trim() })}
          />
        </Captioned>
        <Captioned label="Name">
          <input
            aria-label="Rule name"
            className={fieldControl}
            value={draft.label}
            placeholder="Weekly review"
            onChange={(event) => update({ label: event.target.value })}
          />
        </Captioned>
      </div>
      <Captioned label="Starts">
        <Choice
          label="Starts"
          value={draft.kind}
          options={TRIGGERS}
          onChange={(kind) => update({ kind: kind as RuleTrigger['kind'] })}
        />
      </Captioned>
      <TriggerFields
        draft={draft}
        definition={definition}
        fieldOptions={fieldOptions}
        stateOptions={stateOptions}
        onChange={update}
      />
      <Captioned
        label="Then"
        hint={
          onEvent
            ? 'An action that changes a record changes the one that started the rule.'
            : 'A schedule has no record to change, so its action creates one.'
        }
      >
        <Choice
          label="Action"
          value={draft.actionKey}
          options={ruleActions(trigger, definition).map((one) => ({
            value: one.key,
            label: one.label,
          }))}
          onChange={(actionKey) => update({ actionKey })}
        />
      </Captioned>
      {(action?.input ?? []).map((field) => (
        <InputSource
          key={field.key}
          field={field}
          held={draft.sources[field.key]}
          onEvent={onEvent}
          fieldOptions={fieldOptions}
          onChange={(change) => setSource(field.key, change)}
        />
      ))}
      {problems.length > 0 && (
        <ul className="flex flex-col gap-0.5 text-xs text-ink-faint">
          {problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      )}
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          size="sm"
          disabled={problems.length > 0 || busy}
          aria-busy={busy}
          onClick={() => onSubmit(built)}
        >
          Save rule
        </Button>
      </div>
    </div>
  )
}

function RuleItem({
  rule,
  definition,
  schemas,
  on,
  canSwitch,
  canEdit,
  busy,
  onSwitch,
  onEdit,
  onRemove,
}: {
  rule: RuleSpec
  definition: CapabilityDefinition
  schemas: CollectionSchema[]
  on: boolean
  canSwitch: boolean
  canEdit: boolean
  busy: boolean
  onSwitch: (on: boolean) => void
  onEdit: () => void
  onRemove: () => void
}) {
  const action = definition.actions.find((one) => one.key === rule.actionKey)
  return (
    <li className="flex items-center gap-3 py-2">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm text-ink">{rule.label}</p>
        <p className="text-xs text-ink-muted">
          {describeTrigger(rule.trigger, definition, schemas)}, then{' '}
          {action?.label ?? rule.actionKey}
        </p>
      </div>
      {canSwitch ? (
        <Switch
          aria-label={`${rule.label} is on`}
          checked={on}
          disabled={busy}
          onCheckedChange={onSwitch}
        />
      ) : (
        <span className="shrink-0 text-xs text-ink-faint">
          {on ? 'On' : 'Off'}
        </span>
      )}
      {canEdit && (
        <>
          <Button
            size="xs"
            variant="ghost"
            aria-label={`Edit ${rule.label}`}
            disabled={busy}
            onClick={onEdit}
          >
            <Icon.Edit className="size-3.5" />
            Edit
          </Button>
          <Button
            size="xs"
            variant="ghost"
            aria-label={`Remove ${rule.label}`}
            disabled={busy}
            onClick={onRemove}
          >
            <Icon.Delete className="size-3.5" />
            Remove
          </Button>
        </>
      )}
    </li>
  )
}

/**
 * An instance's rules, each a sentence with whether it is on, the switch for a
 * caller who may switch it, and Edit and Remove for an author.
 */
function RuleList({
  rules,
  definition,
  schemas,
  states,
  canSwitch,
  canEdit,
  busy,
  onEdit,
  onSubmit,
}: {
  rules: RuleSpec[]
  definition: CapabilityDefinition
  schemas: CollectionSchema[]
  states: ReturnType<typeof currentRuleStates>
  canSwitch: boolean
  canEdit: boolean
  busy: boolean
  onEdit: (rule: RuleSpec) => void
  onSubmit: (op: PatchOp, what: string) => void
}) {
  return (
    <>
      {!canSwitch && (
        <p className="text-xs text-ink-faint">
          Switching a rule on needs the background permission on your grant.
        </p>
      )}
      {rules.length ? (
        <ul className="flex flex-col divide-y divide-separator">
          {rules.map((rule) => (
            <RuleItem
              key={rule.key}
              rule={rule}
              definition={definition}
              schemas={schemas}
              on={ruleEnabled(states, rule.key)}
              canSwitch={canSwitch}
              canEdit={canEdit}
              busy={busy}
              onSwitch={(on) =>
                onSubmit(
                  setRuleEnabledOp(rule.key, on),
                  on ? 'Rule switched on' : 'Rule switched off',
                )
              }
              onEdit={() => onEdit(rule)}
              onRemove={() => onSubmit(removeRuleOp(rule.key), 'Rule removed')}
            />
          ))}
        </ul>
      ) : (
        <p className="text-sm text-ink-muted">
          {definition.name} has no rules yet.
        </p>
      )}
    </>
  )
}

/** The editor over the rule being edited or added, or, for an author, the button that adds one. */
function AddOrEditRule({
  editing,
  definition,
  schemas,
  canAdd,
  busy,
  onAdd,
  onCancel,
  onSave,
}: {
  editing: { rule?: RuleSpec } | undefined
  definition: CapabilityDefinition
  schemas: CollectionSchema[]
  canAdd: boolean
  busy: boolean
  onAdd: () => void
  onCancel: () => void
  onSave: (op: PatchOp, what: string) => void
}) {
  if (editing)
    return (
      <RuleEditor
        key={editing.rule?.key ?? '+new'}
        definition={definition}
        schemas={schemas}
        rule={editing.rule}
        busy={busy}
        onCancel={onCancel}
        onSubmit={(rule) =>
          onSave(
            editing.rule ? replaceRuleOp(rule) : addRuleOp(rule),
            editing.rule ? 'Rule saved' : 'Rule added',
          )
        }
      />
    )
  if (!canAdd) return null
  return (
    <Button size="xs" variant="outline" className="self-start" onClick={onAdd}>
      <Icon.Add className="size-3.5" />
      Add rule
    </Button>
  )
}

/**
 * An instance's rules, opened from the table module's view bar. An author adds,
 * edits and removes rules (definition content); a caller holding background
 * switches one on, and the rule then runs as them. Runs carry on with the page
 * closed: the server's worker owns them.
 */
export function RulesDialog({
  instanceId,
  described,
  expectedDefinitionId,
  onClose,
}: {
  instanceId: string
  described: DescribeResult
  /** The definition id the module's rows were read under; every patch names it. */
  expectedDefinitionId: string
  onClose: () => void
}) {
  const { definition, callerGrant: grant } = described
  const schemas = described.collectionSchemas
  const rules = rulesOf(definition)
  const canSwitch = mayRunInBackground(grant)
  const authoring = useCapabilityAuthor(instanceId)
  const client = useQueryClient()
  const [status, setStatus] = useState<Status>()
  const [editing, setEditing] = useState<{ rule?: RuleSpec }>()
  const [authored, setAuthored] = useState<Record<string, RuleEnablement>>()
  const [tab, setTab] = useState<'rules' | 'runs'>('rules')
  const states = currentRuleStates(described.ruleStates, authored)

  const reload = () =>
    void client.invalidateQueries({
      queryKey: capabilityKeys.instance(instanceId),
    })

  const submit = async (op: PatchOp, what: string): Promise<boolean> => {
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
        ops: [op],
      })
      setAuthored(result.instance.rules ?? {})
      setStatus({
        kind: 'saved',
        message: `${what} · the definition is now ${result.definitionId}.`,
      })
      return true
    } catch (error) {
      const conflict = refusalCode(error) === codes.DEFINITION_CONFLICT
      if (conflict) reload()
      setStatus({
        kind: 'failed',
        message: ruleRefusalMessage(error, 'Changing the rules'),
        reload: conflict,
      })
      return false
    }
  }

  return (
    <Dialog open onOpenChange={(shown) => !shown && onClose()}>
      <DialogContent showCloseButton={false} className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Rules for {definition.name}</DialogTitle>
          <DialogDescription>
            A rule runs one of this capability's actions when a record changes
            or on a schedule, through the same path a click takes. Runs keep
            going when this page is closed.
          </DialogDescription>
        </DialogHeader>
        <Segmented
          label="Rules or runs"
          value={tab}
          options={[
            { value: 'rules', label: 'Rules' },
            { value: 'runs', label: 'Runs' },
          ]}
          onChange={setTab}
        />
        {tab === 'runs' ? (
          <RunHistory instanceId={instanceId} described={described} />
        ) : (
          <>
            <StatusLine
              status={status}
              onClear={() => setStatus(undefined)}
              onReload={reload}
              onCheck={() => {}}
            />
            <RuleList
              rules={rules}
              definition={definition}
              schemas={schemas}
              states={states}
              canSwitch={canSwitch}
              canEdit={grant.author}
              busy={authoring.isPending}
              onEdit={(rule) => setEditing({ rule })}
              onSubmit={(op, what) => void submit(op, what)}
            />
            <AddOrEditRule
              editing={editing}
              definition={definition}
              schemas={schemas}
              canAdd={grant.author}
              busy={authoring.isPending}
              onAdd={() => setEditing({})}
              onCancel={() => setEditing(undefined)}
              onSave={(op, what) =>
                void submit(op, what).then(
                  (saved) => saved && setEditing(undefined),
                )
              }
            />
          </>
        )}
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Whether the table module offers its Rules button: something to read, or to write. */
export const offersRules = (described: DescribeResult) =>
  described.callerGrant.author || rulesOf(described.definition).length > 0
