// SOURCING: bun:test over the pure rule and run readings the rule editor and the run history panel
// draw from, against the tracker fixture the Rust contract tests build. The server stays the
// authority on every rule; these tests prove the UI names the same problems before it sends one.
import { describe, expect, test } from 'bun:test'
import {
  peopleSchema,
  tasksSchema,
  trackerDefinition,
} from '@/components/capabilities/fixture'
import type { RuleRun, RuleSpec } from './contract'
import { ruleCodes } from './contract'
import {
  addRuleOp,
  canRetry,
  currentRuleStates,
  describeRunStatus,
  describeRunTrigger,
  describeTrigger,
  isLoopSkip,
  mayRunInBackground,
  removeRuleOp,
  replaceRuleOp,
  ruleActions,
  ruleEnabled,
  ruleProblems,
  rulesOf,
  setRuleEnabledOp,
} from './rules'

const schemas = [tasksSchema, peopleSchema]

const nightly: RuleSpec = {
  key: 'nightly_review',
  label: 'Nightly review',
  trigger: { kind: 'schedule', intervalMinutes: 60 * 24 },
  actionKey: 'add',
  inputs: {
    title: { source: 'literal', value: 'Review the day' },
    due_at: { source: 'now' },
  },
}

const onDone: RuleSpec = {
  key: 'unassign_done',
  label: 'Unassign finished tasks',
  trigger: { kind: 'transition', collectionKey: 'tasks', to: 'done' },
  actionKey: 'assign',
  inputs: { assignee: { source: 'literal', value: null } },
}

const withRules = { ...trackerDefinition, rules: [nightly, onDone] }

describe('rule ops', () => {
  test('are the four PatchOp members the plan names', () => {
    expect(addRuleOp(nightly)).toEqual({ op: 'add_rule', rule: nightly })
    expect(replaceRuleOp(onDone)).toEqual({ op: 'replace_rule', rule: onDone })
    expect(removeRuleOp('nightly_review')).toEqual({
      op: 'remove_rule',
      ruleKey: 'nightly_review',
    })
    expect(setRuleEnabledOp('nightly_review', false)).toEqual({
      op: 'set_rule_enabled',
      ruleKey: 'nightly_review',
      enabled: false,
    })
  })

  test('a slice-1 definition has no rules, not an empty list on the wire', () => {
    expect(rulesOf(trackerDefinition)).toEqual([])
    expect(rulesOf(withRules).map((rule) => rule.key)).toEqual([
      'nightly_review',
      'unassign_done',
    ])
  })
})

describe('ruleProblems', () => {
  const check = (rule: RuleSpec, mode: 'add' | 'replace' = 'add') =>
    ruleProblems(rule, {
      definition: mode === 'add' ? trackerDefinition : withRules,
      schemas,
      mode,
    })

  test('a well-formed schedule rule and transition rule have none', () => {
    expect(check(nightly)).toEqual([])
    expect(check(onDone)).toEqual([])
    expect(check(nightly, 'replace')).toEqual([])
  })

  test('a key must be a slug, new on add and present on replace', () => {
    expect(check({ ...nightly, key: 'Nightly Review' })).toContain(
      'The rule key must start with a lowercase letter and use only a-z, 0-9 and _.',
    )
    expect(
      ruleProblems(nightly, { definition: withRules, schemas, mode: 'add' }),
    ).toContain('A rule with the key "nightly_review" already exists.')
    expect(
      ruleProblems(nightly, {
        definition: trackerDefinition,
        schemas,
        mode: 'replace',
      }),
    ).toContain('There is no rule "nightly_review" to replace.')
    expect(check({ ...nightly, label: '  ' })).toContain(
      'Give the rule a name.',
    )
  })

  test('a schedule runs no more often than every five whole minutes, and only a create action', () => {
    expect(
      check({ ...nightly, trigger: { kind: 'schedule', intervalMinutes: 4 } }),
    ).toContain('A schedule runs at most every 5 minutes.')
    expect(
      check({
        ...nightly,
        trigger: { kind: 'schedule', intervalMinutes: 7.5 },
      }),
    ).toContain('A schedule interval is a whole number of minutes.')
    expect(check({ ...nightly, actionKey: 'complete', inputs: {} })).toContain(
      'A schedule has no record to change, so its action must create one: "Complete" updates a record.',
    )
  })

  test('an event rule that updates must update the collection that triggered it', () => {
    expect(
      check({
        ...onDone,
        trigger: { kind: 'record_created', collectionKey: 'people' },
      }),
    ).toContain(
      '"Assign" updates Tasks, but this rule starts from People: an updating action changes the record that triggered it.',
    )
  })

  test('a trigger names a collection, fields and lifecycle states the definition has', () => {
    expect(
      check({
        ...onDone,
        trigger: { kind: 'record_created', collectionKey: 'projects' },
      }),
    ).toContain('There is no collection "projects".')
    expect(
      check({
        ...onDone,
        trigger: {
          kind: 'record_updated',
          collectionKey: 'tasks',
          fieldKeys: ['status', 'colour'],
        },
      }),
    ).toContain('Tasks has no field "colour".')
    expect(
      check({
        ...onDone,
        trigger: { kind: 'transition', collectionKey: 'tasks', to: 'archived' },
      }),
    ).toContain('"archived" is not a Status of Tasks.')
    expect(
      check({
        ...onDone,
        trigger: {
          kind: 'transition',
          collectionKey: 'people',
          to: 'done',
        },
        actionKey: 'add',
        inputs: { title: { source: 'literal', value: 'x' } },
      }),
    ).toContain('People declares no lifecycle, so it has no transitions.')
  })

  test('the action must exist, every input must be one it takes, and every required one sourced', () => {
    expect(check({ ...nightly, actionKey: 'archive' })).toContain(
      'There is no action "archive".',
    )
    expect(
      check({
        ...nightly,
        inputs: { ...nightly.inputs, colour: { source: 'literal', value: 1 } },
      }),
    ).toContain('"Add task" takes no input "colour".')
    expect(
      check({ ...nightly, inputs: { due_at: { source: 'now' } } }),
    ).toContain('"Add task" needs "title".')
    expect(
      check({
        ...nightly,
        inputs: { title: { source: 'literal', value: '' } },
      }),
    ).toContain('"Add task" needs "title".')
  })

  test('a trigger field comes from an event, and from the triggering collection', () => {
    expect(
      check({
        ...nightly,
        inputs: { title: { source: 'trigger_field', fieldKey: 'title' } },
      }),
    ).toContain('A schedule has no triggering record to read "title" from.')
    expect(
      check({
        ...onDone,
        inputs: { assignee: { source: 'trigger_field', fieldKey: 'name' } },
      }),
    ).toContain('Tasks has no field "name".')
  })

  test('a literal must parse as the input type the action declares', () => {
    expect(
      check({
        key: 'estimate',
        label: 'Estimate new tasks',
        trigger: { kind: 'record_created', collectionKey: 'tasks' },
        actionKey: 'update',
        inputs: { effort_minutes: { source: 'literal', value: 'soon' } },
      }),
    ).toContain('"effort_minutes": not a number')
  })
})

describe('the actions a trigger may invoke', () => {
  test('a schedule only creates; an event creates anywhere or updates its own collection', () => {
    const keys = (trigger: RuleSpec['trigger']) =>
      ruleActions(trigger, trackerDefinition).map((action) => action.key)
    expect(keys({ kind: 'schedule', intervalMinutes: 60 })).toEqual(['add'])
    expect(keys({ kind: 'record_created', collectionKey: 'tasks' })).toEqual([
      'add',
      'complete',
      'update',
      'assign',
    ])
    expect(keys({ kind: 'record_created', collectionKey: 'people' })).toEqual([
      'add',
    ])
  })
})

describe('describing a rule', () => {
  test('in a sentence, naming collections and fields by label', () => {
    expect(describeTrigger(onDone.trigger, withRules, schemas)).toBe(
      'When a Tasks record moves to done',
    )
    expect(
      describeTrigger(
        {
          kind: 'transition',
          collectionKey: 'tasks',
          to: 'done',
          from: ['next'],
        },
        withRules,
        schemas,
      ),
    ).toBe('When a Tasks record moves from next to done')
    expect(
      describeTrigger(
        {
          kind: 'record_updated',
          collectionKey: 'tasks',
          fieldKeys: ['status', 'due_at'],
        },
        withRules,
        schemas,
      ),
    ).toBe('When Status or Due changes on a Tasks record')
    expect(
      describeTrigger(
        { kind: 'record_updated', collectionKey: 'tasks' },
        withRules,
        schemas,
      ),
    ).toBe('When a Tasks record changes')
    expect(
      describeTrigger(
        { kind: 'record_created', collectionKey: 'tasks' },
        withRules,
        schemas,
      ),
    ).toBe('When a Tasks record is created')
    expect(describeTrigger(nightly.trigger, withRules, schemas)).toBe(
      'Every 1440 minutes',
    )
    expect(
      describeTrigger(
        {
          kind: 'schedule',
          intervalMinutes: 30,
          startAtMs: Date.UTC(2026, 10, 1, 9),
        },
        withRules,
        schemas,
      ),
    ).toBe('Every 30 minutes from 2026-11-01T09:00:00.000Z')
  })
})

const baseRun = {
  runId: 'caprun:1',
  instanceId: 'tracker/main',
  ruleKey: 'unassign_done',
  definitionId: 'capdef:abc',
  trigger: { kind: 'event', journalId: 'capop:9', recordId: 'rec-1' },
  runAs: 'user:travis',
  cause: { depth: 0, chain: [] },
  nextAttemptAtMs: 0,
  createdAtMs: 10,
} as const

const runOf = (rest: Partial<RuleRun> & Pick<RuleRun, 'status'>): RuleRun =>
  ({ ...baseRun, attempts: [], ...rest }) as RuleRun

const finishedAttempt = {
  attempt: 1,
  invocationKey: 'rule:caprun:1:1',
  journalId: 'capop:10',
  startedAtMs: 20,
  finishedAtMs: 21,
  outcomeCode: 'capability_precondition_failed',
}

describe('reading a run', () => {
  test('a failed or dead run whose last attempt finished may be retried; nothing else may', () => {
    const failed = runOf({
      status: 'failed',
      code: 'capability_precondition_failed',
      message: 'not open',
      attempts: [finishedAttempt],
    })
    expect(canRetry(failed)).toBe(true)
    const deadContended = runOf({
      status: 'dead',
      code: 'capability_write_contended',
      message: 'gave up',
      attempts: [
        { ...finishedAttempt, outcomeCode: 'capability_write_contended' },
      ],
    })
    expect(canRetry(deadContended)).toBe(true)
    // An attempt whose effect is unknown never finished: a retry could double it.
    const deadUnknown = runOf({
      status: 'dead',
      code: 'invocation_effect_unknown',
      message: 'lease expired',
      attempts: [
        { ...finishedAttempt, finishedAtMs: undefined, outcomeCode: undefined },
      ],
    })
    expect(canRetry(deadUnknown)).toBe(false)
    expect(
      canRetry(
        runOf({
          status: 'failed',
          code: 'capability_grant_denied',
          message: 'revoked',
        }),
      ),
    ).toBe(false)
    expect(
      canRetry(runOf({ status: 'succeeded', attempts: [finishedAttempt] })),
    ).toBe(false)
    expect(canRetry(runOf({ status: 'pending' }))).toBe(false)
  })

  test('a loop skip says why it did not run', () => {
    const skipped = runOf({
      status: 'skipped',
      code: ruleCodes.RULE_LOOP,
      message: 'unassign_done is already in this chain',
      cause: { depth: 2, chain: ['estimate', 'unassign_done'] },
    })
    expect(isLoopSkip(skipped)).toBe(true)
    expect(describeRunStatus(skipped)).toBe(
      'Skipped: unassign_done is already in this chain (chain: estimate → unassign_done, depth 2)',
    )
    expect(describeRunStatus(runOf({ status: 'pending' }))).toBe(
      'Waiting to run',
    )
    expect(
      describeRunStatus(runOf({ status: 'leased', leaseExpiresAtMs: 99 })),
    ).toBe('Running')
    expect(describeRunStatus(runOf({ status: 'succeeded' }))).toBe('Succeeded')
    expect(
      describeRunStatus(
        runOf({
          status: 'dead',
          code: 'capability_write_contended',
          message: 'gave up after 5 attempts',
        }),
      ),
    ).toBe('Gave up: gave up after 5 attempts (capability_write_contended)')
  })

  test('its trigger in words', () => {
    expect(describeRunTrigger(baseRun.trigger)).toBe('Record rec-1 changed')
    expect(
      describeRunTrigger({
        kind: 'schedule',
        slot: 12,
        slotStartMs: Date.UTC(2026, 10, 1),
      }),
    ).toBe('Scheduled slot 12, 2026-11-01T00:00:00.000Z')
    expect(describeRunTrigger({ kind: 'manual', invocationKey: 'k' })).toBe(
      'Run by hand',
    )
  })
})

describe('who may switch rules on', () => {
  test('a caller holding background; an absent background is false', () => {
    expect(
      mayRunInBackground({
        principal: 'user:a',
        read: true,
        invoke: ['*'],
        author: true,
      }),
    ).toBe(false)
    expect(
      mayRunInBackground({
        principal: 'user:a',
        read: true,
        invoke: [],
        author: false,
        background: true,
      } as never),
    ).toBe(true)
  })

  test('a rule is on only when describe says so; an absent state is off', () => {
    expect(
      ruleEnabled({ follow: { enabled: true, changedAtMs: 1 } }, 'follow'),
    ).toBe(true)
    expect(
      ruleEnabled({ follow: { enabled: false, changedAtMs: 1 } }, 'follow'),
    ).toBe(false)
    expect(ruleEnabled(undefined, 'follow')).toBe(false)
    expect(ruleEnabled({}, 'follow')).toBe(false)
  })
})

describe('the rule states a dialog draws', () => {
  test('a patch answer wins over an older describe, and an older patch answer does not', () => {
    const described = {
      a: { enabled: true, changedAtMs: 5, runAs: 'user:x' },
      b: { enabled: false, changedAtMs: 9 },
    }
    const authored = {
      a: { enabled: false, changedAtMs: 7, runAs: 'user:y' },
      b: { enabled: true, changedAtMs: 3, runAs: 'user:y' },
      c: { enabled: true, changedAtMs: 1, runAs: 'user:y' },
    }
    expect(currentRuleStates(described, authored)).toEqual({
      a: { enabled: false, changedAtMs: 7, runAs: 'user:y' },
      b: { enabled: false, changedAtMs: 9 },
      c: { enabled: true, changedAtMs: 1, runAs: 'user:y' },
    })
    expect(currentRuleStates(undefined, undefined)).toEqual({})
    expect(currentRuleStates(described, undefined)).toEqual(described)
  })
})
