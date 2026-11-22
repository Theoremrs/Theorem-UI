// SOURCING: none — pure readings of the slice-2 rule and run wire (contract.ts), reusing
// model.ts's slug check, value parser and value text rather than a second copy. The rules here are
// the ones the plan pins (docs/plans/user-authored-capabilities/README.md, "Durable rules"); the
// server stays the authority, and these name its refusals before a patch is sent.
import type {
  ActionSpec,
  CapabilityDefinition,
  CollectionSchema,
  Grant,
  PatchOp,
  RuleEnablement,
  RuleRun,
  RuleSpec,
  RuleState,
  RuleTrigger,
  RunTrigger,
} from './contract'
import { SCHEDULE_MINUTES_MIN, ruleCodes } from './contract'
import { isValidFieldKey, parseValue, valueText } from './model'

// ── Ops ─────────────────────────────────────────────────────────────────────

export const addRuleOp = (rule: RuleSpec): PatchOp => ({ op: 'add_rule', rule })

export const replaceRuleOp = (rule: RuleSpec): PatchOp => ({
  op: 'replace_rule',
  rule,
})

export const removeRuleOp = (ruleKey: string): PatchOp => ({
  op: 'remove_rule',
  ruleKey,
})

/** Instance state, not definition content: it names the caller as the rule's `runAs`. */
export const setRuleEnabledOp = (
  ruleKey: string,
  enabled: boolean,
): PatchOp => ({
  op: 'set_rule_enabled',
  ruleKey,
  enabled,
})

/** A definition's rules; a slice-1 definition carries none. */
export const rulesOf = (definition: CapabilityDefinition): RuleSpec[] =>
  definition.rules ?? []

// ── Permission and state ────────────────────────────────────────────────────

/**
 * Whether this caller may switch rules on or run one now. `background` is the
 * slice-2 grant flag (skipped on the wire when false); the owner's effective
 * grant carries it implicitly.
 */
export const mayRunInBackground = (grant: Grant): boolean =>
  (grant as Grant & { background?: boolean }).background === true

/** Whether a rule is on. Describe omits the map, and any key, for a rule never switched on. */
export const ruleEnabled = (
  states: Record<string, RuleState | RuleEnablement> | undefined,
  ruleKey: string,
): boolean => states?.[ruleKey]?.enabled === true

/**
 * The rule states to draw: describe's, with a later patch answer's enablements
 * over them, key by key, whichever changed last. Describe is read again after a
 * patch, so the patch answer only bridges the gap until it arrives.
 */
export function currentRuleStates(
  described: Record<string, RuleState> | undefined,
  authored: Record<string, RuleEnablement> | undefined,
): Record<string, RuleState> {
  const states: Record<string, RuleState> = { ...described }
  for (const [key, state] of Object.entries(authored ?? {})) {
    const held = states[key]
    if (!held || state.changedAtMs >= held.changedAtMs) states[key] = state
  }
  return states
}

// ── Validation ──────────────────────────────────────────────────────────────

const collectionOf = (definition: CapabilityDefinition, key: string) =>
  definition.collections.find((collection) => collection.key === key)

const schemaOf = (schemas: ReadonlyArray<CollectionSchema>, key: string) =>
  schemas.find((schema) => schema.collectionKey === key)

const labelOf = (definition: CapabilityDefinition, key: string) =>
  collectionOf(definition, key)?.label ?? key

/** The actions a trigger may invoke: a schedule creates; an event creates, or updates its record. */
export function ruleActions(
  trigger: RuleTrigger,
  definition: CapabilityDefinition,
): ActionSpec[] {
  return definition.actions.filter((action) =>
    trigger.kind === 'schedule'
      ? action.creates
      : action.creates || action.collectionKey === trigger.collectionKey,
  )
}

export type RuleCheck = {
  definition: CapabilityDefinition
  schemas: ReadonlyArray<CollectionSchema>
  /** `add` needs a new key; `replace` needs an existing one. */
  mode: 'add' | 'replace'
}

type EventTrigger = Exclude<RuleTrigger, { kind: 'schedule' }>
type TransitionTrigger = Extract<RuleTrigger, { kind: 'transition' }>
type Collection = CapabilityDefinition['collections'][number]

function scheduleProblems(
  trigger: Extract<RuleTrigger, { kind: 'schedule' }>,
): string[] {
  const problems: string[] = []
  if (!Number.isInteger(trigger.intervalMinutes))
    problems.push('A schedule interval is a whole number of minutes.')
  else if (trigger.intervalMinutes < SCHEDULE_MINUTES_MIN)
    problems.push(
      `A schedule runs at most every ${SCHEDULE_MINUTES_MIN} minutes.`,
    )
  if (trigger.startAtMs !== undefined && !Number.isFinite(trigger.startAtMs))
    problems.push('The start time is not a time.')
  return problems
}

/** Whether resolved fields lack this key; unresolved fields lack nothing, the server decides. */
const lacksField = (schema: CollectionSchema | undefined, fieldKey: string) =>
  schema !== undefined && !schema.fields.some((field) => field.key === fieldKey)

/**
 * The states a transition names that its lifecycle field does not offer. Only a
 * lifecycle field resolved as a choice is read; otherwise the server decides.
 */
function transitionProblems(
  trigger: TransitionTrigger,
  collection: Collection,
  schema: CollectionSchema | undefined,
): string[] {
  const lifecycle = collection.lifecycle
  if (!lifecycle)
    return [
      `${collection.label} declares no lifecycle, so it has no transitions.`,
    ]
  if (!trigger.to.trim()) return ['Name the state the record moves to.']
  const field = schema?.fields.find((one) => one.key === lifecycle.fieldKey)
  if (field?.fieldType.kind !== 'enum') return []
  const { variants } = field.fieldType
  return [trigger.to, ...(trigger.from ?? [])]
    .filter((state) => !variants.includes(state))
    .map(
      (state) => `"${state}" is not a ${field.label} of ${collection.label}.`,
    )
}

function eventProblems(
  trigger: EventTrigger,
  { definition, schemas }: RuleCheck,
): string[] {
  const collection = collectionOf(definition, trigger.collectionKey)
  if (!collection) return [`There is no collection "${trigger.collectionKey}".`]
  const schema = schemaOf(schemas, trigger.collectionKey)
  switch (trigger.kind) {
    case 'record_created':
      return []
    case 'record_updated':
      return (trigger.fieldKeys ?? [])
        .filter((fieldKey) => lacksField(schema, fieldKey))
        .map((fieldKey) => `${collection.label} has no field "${fieldKey}".`)
    case 'transition':
      return transitionProblems(trigger, collection, schema)
  }
}

const triggerProblems = (trigger: RuleTrigger, check: RuleCheck): string[] =>
  trigger.kind === 'schedule'
    ? scheduleProblems(trigger)
    : eventProblems(trigger, check)

type InputSource = RuleSpec['inputs'][string]

/** What is wrong with one input's source, read against the field the action declares. */
function sourceProblems(
  key: string,
  source: InputSource,
  field: ActionSpec['input'][number],
  trigger: RuleTrigger,
  { definition, schemas }: RuleCheck,
): string[] {
  if (source.source === 'literal') {
    const parsed = parseValue(field.fieldType, valueText(source.value))
    return parsed.ok ? [] : [`"${key}": ${parsed.message}`]
  }
  if (source.source !== 'trigger_field') return []
  if (trigger.kind === 'schedule')
    return [
      `A schedule has no triggering record to read "${source.fieldKey}" from.`,
    ]
  return lacksField(schemaOf(schemas, trigger.collectionKey), source.fieldKey)
    ? [
        `${labelOf(definition, trigger.collectionKey)} has no field "${source.fieldKey}".`,
      ]
    : []
}

/** A required input left without a source, or with a blank literal. */
const unsourced = (source: InputSource | undefined): boolean =>
  !source ||
  (source.source === 'literal' && valueText(source.value).trim() === '')

function inputProblems(
  rule: RuleSpec,
  action: ActionSpec,
  check: RuleCheck,
): string[] {
  const given = Object.entries(rule.inputs).flatMap(([key, source]) => {
    const field = action.input.find((one) => one.key === key)
    return field
      ? sourceProblems(key, source, field, rule.trigger, check)
      : [`"${action.label}" takes no input "${key}".`]
  })
  const missing = action.input
    .filter((field) => field.required && unsourced(rule.inputs[field.key]))
    .map((field) => `"${action.label}" needs "${field.key}".`)
  return [...given, ...missing]
}

function keyProblems(
  rule: RuleSpec,
  { definition, mode }: RuleCheck,
): string[] {
  if (!isValidFieldKey(rule.key))
    return [
      'The rule key must start with a lowercase letter and use only a-z, 0-9 and _.',
    ]
  const exists = rulesOf(definition).some((one) => one.key === rule.key)
  if (mode === 'add' && exists)
    return [`A rule with the key "${rule.key}" already exists.`]
  if (mode === 'replace' && !exists)
    return [`There is no rule "${rule.key}" to replace.`]
  return []
}

/** Whether the trigger may invoke this action: a schedule creates; an update changes its own record. */
function reachProblems(
  trigger: RuleTrigger,
  action: ActionSpec,
  definition: CapabilityDefinition,
): string[] {
  if (action.creates) return []
  if (trigger.kind === 'schedule')
    return [
      `A schedule has no record to change, so its action must create one: "${action.label}" updates a record.`,
    ]
  if (
    action.collectionKey === trigger.collectionKey ||
    !collectionOf(definition, trigger.collectionKey)
  )
    return []
  return [
    `"${action.label}" updates ${labelOf(definition, action.collectionKey)}, but this rule starts from ${labelOf(definition, trigger.collectionKey)}: an updating action changes the record that triggered it.`,
  ]
}

/**
 * What the server would refuse in this rule, one line each, or none. Checks the
 * key, the trigger against the definition and its resolved fields, the action a
 * trigger may invoke, and that each input is one the action takes, parses as
 * its declared type, and is sourced when required.
 */
export function ruleProblems(rule: RuleSpec, check: RuleCheck): string[] {
  const named = [
    ...keyProblems(rule, check),
    ...(rule.label.trim() ? [] : ['Give the rule a name.']),
    ...triggerProblems(rule.trigger, check),
  ]
  const action = check.definition.actions.find(
    (one) => one.key === rule.actionKey,
  )
  if (!action) return [...named, `There is no action "${rule.actionKey}".`]
  return [
    ...named,
    ...reachProblems(rule.trigger, action, check.definition),
    ...inputProblems(rule, action, check),
  ]
}

// ── Describing ──────────────────────────────────────────────────────────────

const either = (words: string[]) =>
  words.length <= 1
    ? (words[0] ?? '')
    : `${words.slice(0, -1).join(', ')} or ${words.at(-1)}`

const iso = (ms: number) => new Date(ms).toISOString()

/** The fields an update trigger watches, by label where the resolved schema names them. */
function describeUpdated(
  trigger: Extract<RuleTrigger, { kind: 'record_updated' }>,
  label: string,
  schemas: ReadonlyArray<CollectionSchema>,
): string {
  const fields = trigger.fieldKeys ?? []
  if (!fields.length) return `When a ${label} record changes`
  const resolved = schemaOf(schemas, trigger.collectionKey)?.fields ?? []
  const names = fields.map(
    (key) => resolved.find((field) => field.key === key)?.label ?? key,
  )
  return `When ${either(names)} changes on a ${label} record`
}

const describeSchedule = (
  trigger: Extract<RuleTrigger, { kind: 'schedule' }>,
) =>
  `Every ${trigger.intervalMinutes} minutes${
    trigger.startAtMs === undefined ? '' : ` from ${iso(trigger.startAtMs)}`
  }`

/** A trigger in one sentence, naming collections and fields by their labels. */
export function describeTrigger(
  trigger: RuleTrigger,
  definition: CapabilityDefinition,
  schemas: ReadonlyArray<CollectionSchema>,
): string {
  if (trigger.kind === 'schedule') return describeSchedule(trigger)
  const label = labelOf(definition, trigger.collectionKey)
  switch (trigger.kind) {
    case 'record_created':
      return `When a ${label} record is created`
    case 'record_updated':
      return describeUpdated(trigger, label, schemas)
    case 'transition':
      return trigger.from?.length
        ? `When a ${label} record moves from ${either(trigger.from)} to ${trigger.to}`
        : `When a ${label} record moves to ${trigger.to}`
  }
}

/** What put a run in the queue, in words. */
export function describeRunTrigger(trigger: RunTrigger): string {
  switch (trigger.kind) {
    case 'event':
      return `Record ${trigger.recordId} changed`
    case 'schedule':
      return `Scheduled slot ${trigger.slot}, ${iso(trigger.slotStartMs)}`
    case 'manual':
      return trigger.recordId
        ? `Run by hand on record ${trigger.recordId}`
        : 'Run by hand'
  }
}

/** A loop the server refused to run: inspectable, never silently dropped. */
export const isLoopSkip = (run: RuleRun): boolean =>
  run.status === 'skipped' && run.code === ruleCodes.RULE_LOOP

/** A run's status in words, with the code a failure or skip carries. */
export function describeRunStatus(run: RuleRun): string {
  switch (run.status) {
    case 'pending':
      return 'Waiting to run'
    case 'leased':
      return 'Running'
    case 'succeeded':
      return 'Succeeded'
    case 'failed':
      return `Failed: ${run.message} (${run.code})`
    case 'dead':
      return `Gave up: ${run.message} (${run.code})`
    case 'skipped':
      return isLoopSkip(run)
        ? `Skipped: ${run.message} (chain: ${run.cause.chain.join(' → ')}, depth ${run.cause.depth})`
        : `Skipped: ${run.message} (${run.code})`
  }
}

/**
 * Whether the server would take a retry: a failed or dead run whose last attempt
 * finished. An attempt that never finished may have taken effect, so retrying it
 * could do the work twice; the server refuses it, and so does this.
 */
export function canRetry(run: RuleRun): boolean {
  if (run.status !== 'failed' && run.status !== 'dead') return false
  const last = run.attempts.at(-1)
  return last !== undefined && last.finishedAtMs !== undefined
}
