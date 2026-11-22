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

function triggerProblems(
  trigger: RuleTrigger,
  { definition, schemas }: RuleCheck,
): string[] {
  if (trigger.kind === 'schedule') {
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
  const collection = collectionOf(definition, trigger.collectionKey)
  if (!collection) return [`There is no collection "${trigger.collectionKey}".`]
  const schema = schemaOf(schemas, trigger.collectionKey)
  const fieldMissing = (fieldKey: string) =>
    schema && !schema.fields.some((field) => field.key === fieldKey)
      ? [`${collection.label} has no field "${fieldKey}".`]
      : []
  switch (trigger.kind) {
    case 'record_created':
      return []
    case 'record_updated':
      return (trigger.fieldKeys ?? []).flatMap(fieldMissing)
    case 'transition': {
      const lifecycle = collection.lifecycle
      if (!lifecycle)
        return [
          `${collection.label} declares no lifecycle, so it has no transitions.`,
        ]
      if (!trigger.to.trim()) return ['Name the state the record moves to.']
      const field = schema?.fields.find((one) => one.key === lifecycle.fieldKey)
      const variants =
        field?.fieldType.kind === 'enum' ? field.fieldType.variants : undefined
      if (!field || !variants) return []
      return [trigger.to, ...(trigger.from ?? [])]
        .filter((state) => !variants.includes(state))
        .map(
          (state) =>
            `"${state}" is not a ${field.label} of ${collection.label}.`,
        )
    }
  }
}

function inputProblems(
  rule: RuleSpec,
  action: ActionSpec,
  { definition, schemas }: RuleCheck,
): string[] {
  const problems: string[] = []
  const trigger = rule.trigger
  for (const [key, source] of Object.entries(rule.inputs)) {
    const field = action.input.find((one) => one.key === key)
    if (!field) {
      problems.push(`"${action.label}" takes no input "${key}".`)
      continue
    }
    if (source.source === 'literal') {
      const parsed = parseValue(field.fieldType, valueText(source.value))
      if (!parsed.ok) problems.push(`"${key}": ${parsed.message}`)
    }
    if (source.source === 'trigger_field') {
      if (trigger.kind === 'schedule') {
        problems.push(
          `A schedule has no triggering record to read "${source.fieldKey}" from.`,
        )
        continue
      }
      const schema = schemaOf(schemas, trigger.collectionKey)
      if (schema && !schema.fields.some((one) => one.key === source.fieldKey))
        problems.push(
          `${labelOf(definition, trigger.collectionKey)} has no field "${source.fieldKey}".`,
        )
    }
  }
  for (const field of action.input) {
    if (!field.required) continue
    const source = rule.inputs[field.key]
    const blank =
      !source ||
      (source.source === 'literal' && valueText(source.value).trim() === '')
    if (blank) problems.push(`"${action.label}" needs "${field.key}".`)
  }
  return problems
}

/**
 * What the server would refuse in this rule, one line each, or none. Checks the
 * key, the trigger against the definition and its resolved fields, the action a
 * trigger may invoke, and that each input is one the action takes, parses as
 * its declared type, and is sourced when required.
 */
export function ruleProblems(rule: RuleSpec, check: RuleCheck): string[] {
  const { definition, mode } = check
  const problems: string[] = []
  const exists = rulesOf(definition).some((one) => one.key === rule.key)
  if (!isValidFieldKey(rule.key))
    problems.push(
      'The rule key must start with a lowercase letter and use only a-z, 0-9 and _.',
    )
  else if (mode === 'add' && exists)
    problems.push(`A rule with the key "${rule.key}" already exists.`)
  else if (mode === 'replace' && !exists)
    problems.push(`There is no rule "${rule.key}" to replace.`)
  if (!rule.label.trim()) problems.push('Give the rule a name.')

  problems.push(...triggerProblems(rule.trigger, check))

  const action = definition.actions.find((one) => one.key === rule.actionKey)
  if (!action) {
    problems.push(`There is no action "${rule.actionKey}".`)
    return problems
  }
  const trigger = rule.trigger
  if (trigger.kind === 'schedule' && !action.creates)
    problems.push(
      `A schedule has no record to change, so its action must create one: "${action.label}" updates a record.`,
    )
  if (
    trigger.kind !== 'schedule' &&
    !action.creates &&
    action.collectionKey !== trigger.collectionKey &&
    collectionOf(definition, trigger.collectionKey)
  )
    problems.push(
      `"${action.label}" updates ${labelOf(definition, action.collectionKey)}, but this rule starts from ${labelOf(definition, trigger.collectionKey)}: an updating action changes the record that triggered it.`,
    )
  problems.push(...inputProblems(rule, action, check))
  return problems
}

// ── Describing ──────────────────────────────────────────────────────────────

const either = (words: string[]) =>
  words.length <= 1
    ? (words[0] ?? '')
    : `${words.slice(0, -1).join(', ')} or ${words.at(-1)}`

const iso = (ms: number) => new Date(ms).toISOString()

/** A trigger in one sentence, naming collections and fields by their labels. */
export function describeTrigger(
  trigger: RuleTrigger,
  definition: CapabilityDefinition,
  schemas: ReadonlyArray<CollectionSchema>,
): string {
  if (trigger.kind === 'schedule')
    return `Every ${trigger.intervalMinutes} minutes${
      trigger.startAtMs === undefined ? '' : ` from ${iso(trigger.startAtMs)}`
    }`
  const label = labelOf(definition, trigger.collectionKey)
  switch (trigger.kind) {
    case 'record_created':
      return `When a ${label} record is created`
    case 'record_updated': {
      const fields = trigger.fieldKeys ?? []
      if (!fields.length) return `When a ${label} record changes`
      const schema = schemaOf(schemas, trigger.collectionKey)
      const names = fields.map(
        (key) =>
          schema?.fields.find((field) => field.key === key)?.label ?? key,
      )
      return `When ${either(names)} changes on a ${label} record`
    }
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
      return 'Run by hand'
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
