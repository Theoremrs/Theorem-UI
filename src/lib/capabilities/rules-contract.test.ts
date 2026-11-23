// SOURCING: bun:test over the slice-2 rule, run and module wire as the plan pins it
// (docs/plans/user-authored-capabilities/README.md, "Slice 2: Phases 2-4 pinned design"), the same
// way contract.test.ts holds the slice-1 mirror: what this side can prove is the JSON it sends and
// reads. The Rust `deny_unknown_fields` strictness stays with the contract owner.
import { expect, test } from 'bun:test'
import {
  completedReceipt,
  trackerDefinition,
} from '@/components/capabilities/fixture'
import { ruleCodes } from './contract'
import type {
  ActionSpec,
  CapabilityDefinition,
  CapabilityInstance,
  CapabilityModule,
  DescribeResult,
  InvocationReceipt,
  PatchOp,
  RuleRun,
  RuleRunList,
  RuleSpec,
  RunRuleRequest,
} from './contract'

const wire = (value: unknown): unknown => JSON.parse(JSON.stringify(value))

const followUp: RuleSpec = {
  key: 'follow_up',
  label: 'Follow up when waiting',
  trigger: {
    kind: 'transition',
    collectionKey: 'tasks',
    to: 'waiting',
    from: ['next'],
  },
  actionKey: 'add',
  inputs: {
    title: { source: 'literal', value: 'Chase the reply' },
    due_at: { source: 'now' },
    source_title: { source: 'trigger_field', fieldKey: 'title' },
  },
}

test('a slice-1 definition and action carry no slice-2 key, so their content ids do not move', () => {
  const sent = wire(trackerDefinition) as Record<string, unknown>
  expect(Object.keys(sent)).not.toContain('rules')
  for (const action of sent.actions as Array<Record<string, unknown>>)
    expect(Object.keys(action)).not.toContain('implementation')
})

test('rules ride on the definition after its agent metadata, tagged by kind and source', () => {
  const definition: CapabilityDefinition = {
    ...trackerDefinition,
    rules: [followUp],
  }
  const sent = wire(definition) as Record<string, unknown>
  expect(Object.keys(sent).at(-1)).toBe('rules')
  expect(sent.rules).toEqual([
    {
      key: 'follow_up',
      label: 'Follow up when waiting',
      trigger: {
        kind: 'transition',
        collectionKey: 'tasks',
        to: 'waiting',
        from: ['next'],
      },
      actionKey: 'add',
      inputs: {
        title: { source: 'literal', value: 'Chase the reply' },
        due_at: { source: 'now' },
        source_title: { source: 'trigger_field', fieldKey: 'title' },
      },
    },
  ])
})

test('every trigger kind is snake_case with camelCase fields, and absent options stay absent', () => {
  const triggers: RuleSpec['trigger'][] = [
    { kind: 'record_created', collectionKey: 'tasks' },
    { kind: 'record_updated', collectionKey: 'tasks', fieldKeys: ['status'] },
    { kind: 'record_updated', collectionKey: 'tasks' },
    { kind: 'schedule', intervalMinutes: 60, startAtMs: 1_700_000_000_000 },
    { kind: 'schedule', intervalMinutes: 5 },
  ]
  expect(wire(triggers)).toEqual([
    { kind: 'record_created', collectionKey: 'tasks' },
    { kind: 'record_updated', collectionKey: 'tasks', fieldKeys: ['status'] },
    { kind: 'record_updated', collectionKey: 'tasks' },
    { kind: 'schedule', intervalMinutes: 60, startAtMs: 1_700_000_000_000 },
    { kind: 'schedule', intervalMinutes: 5 },
  ])
})

test('the four rule ops are tagged as the Rust names them', () => {
  const ops: PatchOp[] = [
    { op: 'add_rule', rule: followUp },
    { op: 'replace_rule', rule: followUp },
    { op: 'remove_rule', ruleKey: 'follow_up' },
    { op: 'set_rule_enabled', ruleKey: 'follow_up', enabled: true },
  ]
  expect(wire(ops)).toEqual([
    { op: 'add_rule', rule: wire(followUp) },
    { op: 'replace_rule', rule: wire(followUp) },
    { op: 'remove_rule', ruleKey: 'follow_up' },
    { op: 'set_rule_enabled', ruleKey: 'follow_up', enabled: true },
  ])
})

test('an instance names who each enabled rule runs as', () => {
  const instance: CapabilityInstance = {
    instanceId: 'tracker/main',
    capabilityId: 'project-tracker',
    definitionId: 'capdef:abc',
    config: {},
    grants: [],
    ownerPrincipal: 'user:travis',
    createdAtMs: 1,
    rules: {
      follow_up: { enabled: true, runAs: 'user:travis', changedAtMs: 5 },
    },
  }
  expect(Object.keys(wire(instance) as object).at(-1)).toBe('rules')
})

test('a run reads with its status flattened beside its attempts', () => {
  const wireRun = {
    runId: 'caprun:1',
    instanceId: 'tracker/main',
    ruleKey: 'follow_up',
    definitionId: 'capdef:abc',
    trigger: { kind: 'event', journalId: 'capop:9', recordId: 'rec-1' },
    runAs: 'user:travis',
    cause: { depth: 1, chain: ['follow_up'] },
    status: 'skipped',
    code: 'capability_rule_loop',
    message: 'follow_up is already in this chain',
    attempts: [],
    nextAttemptAtMs: 0,
    createdAtMs: 10,
    finishedAtMs: 10,
  }
  const run = wireRun as RuleRun
  expect(run.status).toBe('skipped')
  if (run.status !== 'skipped') throw new Error('unreachable')
  expect(run.code).toBe(ruleCodes.RULE_LOOP)

  const list: RuleRunList = { runs: [run], nextCursor: 'c2' }
  expect(wire(list)).toEqual({ runs: [wireRun], nextCursor: 'c2' })
})

test('describe tells a caller which rules are on, and whom they run as only when it may know', () => {
  const described: DescribeResult = {
    definition: trackerDefinition,
    definitionId: 'capdef:tracker',
    callerGrant: {
      principal: 'user:reader',
      read: true,
      invoke: [],
      author: false,
    },
    collectionSchemas: [],
    ruleStates: { follow_up: { enabled: true, changedAtMs: 5 } },
  }
  expect(described.ruleStates?.follow_up?.enabled).toBe(true)
  expect(described.ruleStates?.follow_up?.runAs).toBeUndefined()
  // The server leaves the map out when no rule was ever switched.
  const plain: DescribeResult = { ...described, ruleStates: undefined }
  expect(Object.keys(wire(plain) as object)).not.toContain('ruleStates')
})

test('a manual run sends an empty body, so the Idempotency-Key names it', () => {
  const body: RunRuleRequest = {}
  expect(wire(body)).toEqual({})
})

test('a receipt a rule dispatched names its cause; one a person dispatched names none', () => {
  const plain = completedReceipt('complete', [{ id: 'rec-1', revision: 7 }])
  expect(Object.keys(wire(plain) as object)).not.toContain('cause')
  const caused: InvocationReceipt = {
    ...plain,
    cause: { ruleKey: 'follow_up', runId: 'caprun:1', depth: 1 },
  }
  expect((wire(caused) as Record<string, unknown>).cause).toEqual({
    ruleKey: 'follow_up',
    runId: 'caprun:1',
    depth: 1,
  })
})

test('an action names its module implementation; a module names its source and exports', () => {
  const action: ActionSpec = {
    ...trackerDefinition.actions[1]!,
    implementation: {
      moduleId: 'capmod:abc',
      export: 'complete',
      writes: ['completed_at'],
    },
  }
  expect(Object.keys(wire(action) as object).at(-1)).toBe('implementation')
  const module: CapabilityModule = {
    moduleId: 'capmod:abc',
    language: 'wasm',
    source: { kind: 'wat', text: '(module)' },
    exports: ['complete'],
  }
  expect(wire(module)).toEqual({
    moduleId: 'capmod:abc',
    language: 'wasm',
    source: { kind: 'wat', text: '(module)' },
    exports: ['complete'],
  })
})

test('the slice-2 refusal codes are the ones the plan pins', () => {
  const values: string[] = Object.values(ruleCodes)
  expect(values.sort()).toEqual(
    [
      'capability_background_denied',
      'capability_module_failed',
      'capability_module_not_found',
      'capability_rule_loop',
      'capability_rule_unknown',
      'capability_run_not_found',
      'capability_run_not_retryable',
    ].sort(),
  )
})
