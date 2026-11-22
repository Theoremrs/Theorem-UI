// SOURCING: bun:test over the rule editor, reached as a person reaches it: the table module's
// Rules button, over slice2-harness's stand-in for /api/capabilities/v1. What is asserted is what
// the dialog shows and the one PatchOp each control sends; no backend is reached.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { cleanup, waitFor } from '../../../test/workspace'
import { ruleCodes } from '@/lib/capabilities/contract'
import { ownerGrant, readerGrant } from './fixture'
import {
  button,
  fill,
  install,
  named,
  press,
  screen,
  sentTo,
  server,
  showTable,
  uninstall,
  withRules,
} from './slice2-harness'

beforeEach(install)
afterEach(() => {
  uninstall()
  cleanup()
})

async function openRules(described = withRules()) {
  const { container } = await showTable(described)
  await waitFor(() => container.textContent.includes('Write the plan'))
  await press(button(container, 'Rules'))
  await waitFor(() =>
    screen().textContent.includes('Rules for Project tracker'),
  )
  return container
}

const select = (label: string) => named<HTMLSelectElement>(label)
const input = (label: string) => named<HTMLInputElement>(label)
const authored = () => sentTo('/author').map((call) => call.body)

test('each rule reads as a sentence with whether it is on', async () => {
  await openRules()
  const text = screen().textContent
  expect(text).toContain('Nightly review')
  expect(text).toContain('Every 1440 minutes, then Add task')
  expect(text).toContain('Unassign finished tasks')
  expect(text).toContain('When a Tasks record moves to done, then Assign')
  expect(named('Nightly review is on')?.getAttribute('aria-checked')).toBe(
    'true',
  )
  expect(
    named('Unassign finished tasks is on')?.getAttribute('aria-checked'),
  ).toBe('false')
})

test('a reader sees the rules and their state, but no switch and no editing', async () => {
  await openRules(withRules(readerGrant))
  expect(screen().textContent).toContain('Nightly review')
  expect(document.querySelector('[role="switch"]')).toBeNull()
  expect(screen().textContent).toContain('On')
  expect(screen().textContent).toContain('Off')
  expect(button(screen(), 'Add rule')).toBeUndefined()
  expect(named('Edit Nightly review')).toBeNull()
  expect(named('Remove Nightly review')).toBeNull()
})

test('an author without background edits rules but cannot switch one on', async () => {
  await openRules(withRules(ownerGrant))
  expect(button(screen(), 'Add rule')).toBeTruthy()
  expect(document.querySelector('[role="switch"]')).toBeNull()
  expect(screen().textContent).toContain(
    'Switching a rule on needs the background permission on your grant.',
  )
})

test('a definition with no rules shows no Rules button to a reader', async () => {
  const { container } = await showTable({
    ...withRules(readerGrant),
    definition: { ...withRules().definition, rules: undefined },
    ruleStates: undefined,
  })
  await waitFor(() => container.textContent.includes('Write the plan'))
  expect(button(container, 'Rules')).toBeUndefined()
})

test('adding a schedule rule sends one add_rule against the version the rows were read under', async () => {
  await openRules()
  await press(button(screen(), 'Add rule'))
  fill(input('Rule key'), 'weekly_review')
  fill(input('Rule name'), 'Weekly review')
  fill(select('Starts'), 'schedule')
  fill(input('Every (minutes)'), '10080')
  // A schedule has no record to change, so only creating actions are offered.
  const actions = [...select('Action')!.options].map((one) => one.value)
  expect(actions).toEqual(['add'])
  fill(select('Source of title'), 'literal')
  fill(input('Value of title'), 'Weekly review')
  // A schedule has no triggering record, so that source is not offered.
  expect(
    [...select('Source of due_at')!.options].map((one) => one.value),
  ).not.toContain('trigger_field')
  await press(button(screen(), 'Save rule'))
  await waitFor(() => authored().length === 1)
  expect(authored()[0]).toEqual({
    expectedDefinitionId: 'capdef:abc',
    ops: [
      {
        op: 'add_rule',
        rule: {
          key: 'weekly_review',
          label: 'Weekly review',
          trigger: { kind: 'schedule', intervalMinutes: 10080 },
          actionKey: 'add',
          inputs: { title: { source: 'literal', value: 'Weekly review' } },
        },
      },
    ],
  })
  await waitFor(() => screen().textContent.includes('Rule added'))
})

test('a schedule faster than every five minutes is not sent, and the dialog says why', async () => {
  await openRules()
  await press(button(screen(), 'Add rule'))
  fill(input('Rule key'), 'often')
  fill(input('Rule name'), 'Often')
  fill(select('Starts'), 'schedule')
  fill(input('Every (minutes)'), '4')
  fill(select('Source of title'), 'literal')
  fill(input('Value of title'), 'x')
  expect(screen().textContent).toContain(
    'A schedule runs at most every 5 minutes.',
  )
  expect(button(screen(), 'Save rule')?.disabled).toBe(true)
})

test('an event rule reads the triggering record and a transition names the lifecycle states', async () => {
  await openRules()
  await press(button(screen(), 'Add rule'))
  fill(input('Rule key'), 'chase')
  fill(input('Rule name'), 'Chase waiting tasks')
  fill(select('Starts'), 'transition')
  fill(select('Collection'), 'tasks')
  expect([...select('Moves to')!.options].map((one) => one.value)).toEqual([
    'next',
    'in_progress',
    'waiting',
    'done',
  ])
  fill(select('Moves to'), 'waiting')
  await press(named('From next'))
  fill(select('Action'), 'add')
  fill(select('Source of title'), 'trigger_field')
  fill(select('Field for title'), 'title')
  fill(select('Source of due_at'), 'now')
  await press(button(screen(), 'Save rule'))
  await waitFor(() => authored().length === 1)
  expect(authored()[0]?.ops).toEqual([
    {
      op: 'add_rule',
      rule: {
        key: 'chase',
        label: 'Chase waiting tasks',
        trigger: {
          kind: 'transition',
          collectionKey: 'tasks',
          to: 'waiting',
          from: ['next'],
        },
        actionKey: 'add',
        inputs: {
          title: { source: 'trigger_field', fieldKey: 'title' },
          due_at: { source: 'now' },
        },
      },
    },
  ])
})

test('a record_updated rule names the fields it watches, or none for any', async () => {
  await openRules()
  await press(button(screen(), 'Add rule'))
  fill(input('Rule key'), 'restimate')
  fill(input('Rule name'), 'Re-estimate')
  fill(select('Starts'), 'record_updated')
  await press(named('Watch Status'))
  fill(select('Action'), 'update')
  fill(select('Source of effort_minutes'), 'literal')
  fill(input('Value of effort_minutes'), '30')
  await press(button(screen(), 'Save rule'))
  await waitFor(() => authored().length === 1)
  expect(authored()[0]?.ops).toEqual([
    {
      op: 'add_rule',
      rule: {
        key: 'restimate',
        label: 'Re-estimate',
        trigger: {
          kind: 'record_updated',
          collectionKey: 'tasks',
          fieldKeys: ['status'],
        },
        actionKey: 'update',
        inputs: { effort_minutes: { source: 'literal', value: 30 } },
      },
    },
  ])
})

test('editing a rule replaces it, and removing one removes it', async () => {
  await openRules()
  await press(named('Edit Unassign finished tasks'))
  expect(input('Rule key')?.disabled).toBe(true)
  expect(select('Moves to')?.value).toBe('done')
  fill(input('Rule name'), 'Unassign done tasks')
  await press(button(screen(), 'Save rule'))
  await waitFor(() => authored().length === 1)
  expect(authored()[0]?.ops).toEqual([
    {
      op: 'replace_rule',
      rule: {
        key: 'unassign_done',
        label: 'Unassign done tasks',
        trigger: { kind: 'transition', collectionKey: 'tasks', to: 'done' },
        actionKey: 'assign',
        inputs: { assignee: { source: 'literal', value: null } },
      },
    },
  ])

  await press(named('Remove Nightly review'))
  await waitFor(() => authored().length === 2)
  expect(authored()[1]?.ops).toEqual([
    { op: 'remove_rule', ruleKey: 'nightly_review' },
  ])
})

test('the switch sends set_rule_enabled, and a refusal says why', async () => {
  await openRules()
  await press(named('Unassign finished tasks is on'))
  await waitFor(() => authored().length === 1)
  expect(authored()[0]).toEqual({
    expectedDefinitionId: 'capdef:abc',
    ops: [{ op: 'set_rule_enabled', ruleKey: 'unassign_done', enabled: true }],
  })
  await waitFor(() => screen().textContent.includes('Rule switched on'))

  server.refuse.set('/author', {
    status: 403,
    code: ruleCodes.BACKGROUND_DENIED,
    detail: 'no background',
  })
  await press(named('Nightly review is on'))
  await waitFor(() =>
    screen().textContent.includes(
      'Your grant does not let rules run in the background as you.',
    ),
  )
})
