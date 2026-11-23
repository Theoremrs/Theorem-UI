// SOURCING: bun:test over the run history, reached as a person reaches it: the table module's Rules
// button, then the Runs tab, over slice2-harness's stand-in for /api/capabilities/v1. What is
// asserted is what the panel shows of the server's run records and the one call each control
// sends; no backend and no worker are reached.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { act } from 'react'
import { focusManager } from '@tanstack/react-query'
import { cleanup, waitFor } from '../../../test/workspace'
import { ruleCodes } from '@/lib/capabilities/contract'
import type { RuleRun } from '@/lib/capabilities/contract'
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

const at = (minute: number) => Date.UTC(2026, 10, 20, 10, minute)
const iso = (minute: number) => new Date(at(minute)).toISOString()

const failed = {
  runId: 'caprun:f1',
  instanceId: 'tracker/main',
  ruleKey: 'unassign_done',
  definitionId: 'capdef:abc',
  trigger: { kind: 'event', journalId: 'j-1', recordId: 'rec-1' },
  runAs: 'user:travis',
  cause: { depth: 0, chain: [] },
  status: 'failed',
  code: 'capability_grant_denied',
  message: 'The grant was revoked.',
  attempts: [
    {
      attempt: 1,
      invocationKey: 'rule:caprun:f1:1',
      journalId: 'j-2',
      startedAtMs: at(1),
      finishedAtMs: at(2),
      outcomeCode: 'capability_grant_denied',
    },
  ],
  nextAttemptAtMs: 0,
  createdAtMs: at(0),
  finishedAtMs: at(2),
} as RuleRun

const unknown = {
  ...failed,
  runId: 'caprun:d1',
  status: 'dead',
  code: 'invocation_effect_unknown',
  message: 'The attempt may have taken effect.',
  attempts: [
    {
      attempt: 1,
      invocationKey: 'rule:caprun:d1:1',
      journalId: 'j-3',
      startedAtMs: at(3),
    },
  ],
} as RuleRun

const loop = {
  ...failed,
  runId: 'caprun:s1',
  status: 'skipped',
  code: ruleCodes.RULE_LOOP,
  message: 'This rule is already in the chain.',
  cause: { depth: 1, chain: ['unassign_done'] },
  attempts: [],
} as RuleRun

const nightlyRun = {
  ...failed,
  runId: 'caprun:ok',
  ruleKey: 'nightly_review',
  trigger: { kind: 'schedule', slot: 3, slotStartMs: at(30) },
  status: 'succeeded',
  attempts: [
    {
      attempt: 1,
      invocationKey: 'rule:caprun:ok:1',
      journalId: 'j-4',
      startedAtMs: at(30),
      finishedAtMs: at(31),
    },
  ],
} as RuleRun

beforeEach(() => {
  install()
  server.runs = [failed, unknown, loop, nightlyRun]
})
afterEach(() => {
  focusManager.setFocused(undefined)
  uninstall()
  cleanup()
})

async function openRuns(described = withRules()) {
  const { container } = await showTable(described)
  await waitFor(() => container.textContent.includes('Write the plan'))
  await press(button(container, 'Rules'))
  await waitFor(() =>
    screen().textContent.includes('Rules for Project tracker'),
  )
  await press(button(screen(), 'Runs'))
  await waitFor(() => screen().textContent.includes('caprun:f1'))
  return container
}

const row = (runId: string) => named(`Run ${runId}`)

test('each run shows its status, trigger, attempts, outcome codes and times', async () => {
  await openRuns()
  const first = row('caprun:f1')?.textContent ?? ''
  expect(first).toContain('Unassign finished tasks')
  expect(first).toContain(
    'Failed: The grant was revoked. (capability_grant_denied)',
  )
  expect(first).toContain('Record rec-1 changed')
  expect(first).toContain('1 attempt')
  expect(first).toContain('capability_grant_denied')
  expect(first).toContain(`Queued ${iso(0)}`)
  expect(first).toContain(`Finished ${iso(2)}`)

  expect(row('caprun:d1')?.textContent).toContain(
    'Gave up: The attempt may have taken effect. (invocation_effect_unknown)',
  )
  expect(row('caprun:ok')?.textContent).toContain('Succeeded')
  expect(row('caprun:ok')?.textContent).toContain(
    `Scheduled slot 3, ${iso(30)}`,
  )

  // The list is a read: no CSRF, and with no rule chosen, no rule filter.
  const [list] = sentTo('/runs')
  expect(list?.method).toBe('GET')
  expect(list?.search).toBe('')
  expect(list?.headers.get('X-CSRF-Token')).toBeNull()
})

test('a pending run says when it tries next, attempts are counted, and older runs are paged in', async () => {
  const retrying = {
    ...failed,
    runId: 'caprun:p1',
    status: 'pending',
    attempts: [
      failed.attempts[0]!,
      { ...failed.attempts[0]!, attempt: 2, finishedAtMs: at(5) },
    ],
    nextAttemptAtMs: at(10),
    finishedAtMs: undefined,
  } as RuleRun
  const queued = {
    ...retrying,
    runId: 'caprun:q1',
    attempts: [],
    nextAttemptAtMs: at(11),
  } as RuleRun
  // The server pages the list: the first page names the cursor of the next.
  const served = window.fetch
  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.pathname.endsWith('/runs')) {
      const older = url.searchParams.get('cursor') === 'c2'
      return new Response(
        JSON.stringify(
          older
            ? { runs: [nightlyRun] }
            : { runs: [failed, retrying, queued], nextCursor: 'c2' },
        ),
        { headers: { 'content-type': 'application/json' } },
      )
    }
    return served(input, init)
  }) as typeof fetch
  await openRuns()
  const next = row('caprun:p1')?.textContent ?? ''
  expect(next).toContain(
    '2 attempts (capability_grant_denied, capability_grant_denied)',
  )
  expect(next).toContain(`Next attempt ${iso(10)}`)
  expect(next).not.toContain('Finished')
  // Not yet tried: nothing says when it tries next.
  expect(row('caprun:q1')?.textContent).toContain(
    `0 attempts · Queued ${iso(0)}`,
  )
  expect(row('caprun:q1')?.textContent).not.toContain('Next attempt')

  expect(row('caprun:ok')).toBeNull()
  await press(button(screen(), 'Older runs'))
  await waitFor(() => row('caprun:ok'))
  expect(button(screen(), 'Older runs')).toBeUndefined()
  // An attempt with no outcome code adds nothing after the count.
  expect(row('caprun:ok')?.textContent).toContain(
    `1 attempt · Queued ${iso(0)}`,
  )
})

test('a refused list or run read says why, and an empty list says no rule has run', async () => {
  server.refuse.set('/runs', {
    status: 404,
    code: ruleCodes.RULE_UNKNOWN,
    detail: 'no rule',
  })
  const { container } = await showTable(withRules())
  await waitFor(() => container.textContent.includes('Write the plan'))
  await press(button(container, 'Rules'))
  await press(await waitFor(() => button(screen(), 'Runs')))
  await waitFor(() =>
    screen().textContent.includes(
      'This rule is no longer part of the definition.',
    ),
  )
  expect(screen().textContent).not.toContain('No rule has run yet.')
  cleanup()

  server.refuse = new Map([
    [
      `/runs/${encodeURIComponent('caprun:f1')}`,
      { status: 404, code: ruleCodes.RUN_NOT_FOUND, detail: 'no run' },
    ],
  ])
  await openRuns()
  await press(named('Inspect run caprun:f1'))
  await waitFor(() =>
    row('caprun:f1')?.textContent.includes('That run is not here.'),
  )
  cleanup()

  server.refuse = new Map()
  server.runs = []
  const shown = await showTable(withRules())
  await waitFor(() => shown.container.textContent.includes('Write the plan'))
  await press(button(shown.container, 'Rules'))
  await press(await waitFor(() => button(screen(), 'Runs')))
  await waitFor(() => screen().textContent.includes('No rule has run yet.'))
  expect(button(screen(), 'Older runs')).toBeUndefined()
})

test('a skipped loop run shows why it did not run', async () => {
  await openRuns()
  expect(row('caprun:s1')?.textContent).toContain(
    'Skipped: This rule is already in the chain. (chain: unassign_done, depth 1)',
  )
})

test('choosing a rule asks the server for that rule’s runs only', async () => {
  await openRuns()
  fill(named<HTMLSelectElement>('Runs of'), 'nightly_review')
  await waitFor(() => !!row('caprun:ok') && !row('caprun:f1'))
  expect(row('caprun:d1')).toBeNull()
  expect(sentTo('/runs').at(-1)?.search).toBe('?ruleKey=nightly_review')
})

test('inspecting a run reads it by id and lists every attempt', async () => {
  await openRuns()
  await press(named('Inspect run caprun:f1'))
  await waitFor(() => screen().textContent.includes('rule:caprun:f1:1'))
  const read = sentTo('/runs/caprun%3Af1')
  expect(read).toHaveLength(1)
  expect(read[0]?.method).toBe('GET')
  const detail = named('Run caprun:f1 in detail')?.textContent ?? ''
  expect(detail).toContain('Runs as user:travis')
  expect(detail).toContain('Attempt 1')
  expect(detail).toContain('journal j-2')
  expect(detail).toContain(`started ${iso(1)}`)
  expect(detail).toContain(`finished ${iso(2)}`)
  expect(detail).toContain('capability_grant_denied')
})

test('retry is offered only where the server would take it, and sends an empty body', async () => {
  await openRuns()
  expect(named('Retry run caprun:f1')).toBeTruthy()
  // Its last attempt never finished, so it may have taken effect.
  expect(named('Retry run caprun:d1')).toBeNull()
  expect(named('Retry run caprun:s1')).toBeNull()
  expect(named('Retry run caprun:ok')).toBeNull()

  await press(named('Retry run caprun:f1'))
  await waitFor(() => sentTo('/retry').length === 1)
  const [post] = sentTo('/retry')
  expect(post?.method).toBe('POST')
  expect(post?.path).toContain('/runs/caprun%3Af1/retry')
  expect(post?.body).toEqual({})
  await waitFor(() =>
    (row('caprun:f1')?.textContent ?? '').includes('Waiting to run'),
  )
  expect(screen().textContent).toContain('Retry queued')
})

test('an author without background may retry; a reader without it may not', async () => {
  await openRuns(withRules(ownerGrant))
  expect(named('Retry run caprun:f1')).toBeTruthy()
  cleanup()
  await openRuns(withRules(readerGrant))
  expect(named('Retry run caprun:f1')).toBeNull()
})

test('run now starts a schedule rule by hand under one Idempotency-Key', async () => {
  await openRuns()
  expect(named('Run Unassign finished tasks now')).toBeNull()
  await press(named('Run Nightly review now'))
  await waitFor(() => sentTo('/rules/nightly_review/run').length === 1)
  const [post] = sentTo('/rules/nightly_review/run')
  expect(post?.method).toBe('POST')
  expect(post?.body).toEqual({})
  expect(post?.headers.get('Idempotency-Key')).toBeTruthy()
  await waitFor(() => screen().textContent.includes('Run by hand'))
  expect(screen().textContent).toContain('Run started')
})

test('without background there is no run now, and a refusal says why', async () => {
  await openRuns(withRules(ownerGrant))
  expect(named('Run Nightly review now')).toBeNull()
  expect(screen().textContent).toContain(
    'Running a rule by hand needs the background permission on your grant.',
  )
  cleanup()

  server.refuse.set('/run', {
    status: 403,
    code: ruleCodes.BACKGROUND_DENIED,
    detail: 'no background',
  })
  await openRuns()
  await press(named('Run Nightly review now'))
  await waitFor(() =>
    screen().textContent.includes(
      'Your grant does not let rules run in the background as you.',
    ),
  )
})

test('the list follows the server: it refetches on focus, and closing the dialog loses nothing', async () => {
  const container = await openRuns()
  server.runs = [{ ...nightlyRun, runId: 'caprun:new' }, ...server.runs]
  act(() => {
    focusManager.setFocused(false)
    focusManager.setFocused(true)
  })
  await waitFor(() => !!row('caprun:new'))

  // The worker finishes the run while the dialog is closed; reopening reads it.
  await press(button(screen(), 'Done'))
  await waitFor(() => !screen().textContent.includes('Rules for'))
  server.runs = server.runs.map((one) =>
    one.runId === 'caprun:f1' ? { ...one, status: 'succeeded' } : one,
  )
  await press(button(container, 'Rules'))
  await press(button(screen(), 'Runs'))
  await waitFor(() =>
    (row('caprun:f1')?.textContent ?? '').includes('Succeeded'),
  )
})
