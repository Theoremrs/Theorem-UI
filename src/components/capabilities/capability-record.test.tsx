// SOURCING: bun:test over the capability record module, rendered with test/workspace's render into
// happy-dom with window.fetch standing in for a Theorem that serves /api/capabilities/v1. What is
// asserted is the module's own rule: the fields come from describe's resolved schemas, a save runs a
// declared action naming the revision on screen, and a change no declared action writes is refused
// here rather than pushed through a second path.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { act } from 'react'
import { cleanup, render, waitFor } from '../../../test/workspace'
import { CapabilityRecordModule } from './capability-record'
import { PageFileContext } from '../pages/page-route'
import { PageRuntimeProvider } from '../pages/page-runtime'
import { CAPABILITIES } from '@/lib/capabilities/api'
import { codes } from '@/lib/capabilities/contract'
import type {
  QueryResult,
  DescribeResult,
  Grant,
} from '@/lib/capabilities/contract'
import { describeResult, row, taskRows } from './fixture'
import type { ModuleViewProps } from '@/lib/modules/registry'
import type { CapabilityContextReference } from '@/lib/capabilities/reference'

const page = (
  window as unknown as { happyDOM: { setURL: (url: string) => void } }
).happyDOM
page.setURL('http://localhost:3000/pages/Desk')
const realFetch = window.fetch

type Call = {
  method: string
  path: string
  body?: Record<string, unknown>
  headers: Headers
}
let calls: Call[]
/** What a collection query answers, and what describe grants this caller. */
let rows: QueryResult['records']
let described: DescribeResult
let invokeRefusal: { status: number; code: string } | undefined
/** Invokes answer a journaled call that has not finished. */
let invokeDispatched = false
/** The next finished call failed with this code and message. */
let invokeFailure: { code: string; message: string } | undefined
/** A receipt read back is refused. */
let receiptRefused = false
let recordReadGate: Promise<void> | undefined
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  })
const refusal = (status: number, code: string) =>
  new Response(
    JSON.stringify({
      type: 'about:blank',
      title: 'Refused',
      status,
      code,
      detail: 'The record moved on since it was read.',
    }),
    { status, headers: { 'content-type': 'application/problem+json' } },
  )

const button = (container: HTMLElement, name: string) =>
  [...container.querySelectorAll('button')].find(
    (one) => one.textContent.trim() === name,
  )

/** The pencil that opens one field's editor, by its label. */
const editMark = (container: HTMLElement, label: string) =>
  container.querySelector<HTMLButtonElement>(
    `button[aria-label="Edit ${label}"]`,
  )

const input = (container: HTMLElement, label: string) =>
  container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)

/** Enter, which is how the records' own editors save a value in place. */
function pressEnter(field: HTMLElement) {
  act(() => {
    field.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    )
  })
}

/** Types through the control's own value setter, as React reads it. */
function type(field: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value',
  )!.set!
  act(() => {
    setter.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

beforeEach(() => {
  calls = []
  rows = taskRows
  described = describeResult()
  invokeRefusal = undefined
  invokeDispatched = false
  invokeFailure = undefined
  receiptRefused = false
  recordReadGate = undefined
  window.fetch = (async (info: RequestInfo | URL, init?: RequestInit) => {
    const request = info instanceof Request ? info : undefined
    const url = new URL(request ? request.url : String(info))
    const method = init?.method ?? (request ? request.method : 'GET')
    const raw =
      init?.body ?? (request ? await request.clone().text() : undefined)
    const body = raw
      ? (JSON.parse(String(raw)) as Record<string, unknown>)
      : undefined
    calls.push({
      method,
      path: url.pathname,
      body,
      headers: new Headers(
        init?.headers ?? (request ? request.headers : undefined),
      ),
    })
    if (url.pathname === '/api/chat/v1/bootstrap')
      return json({ schema: 'theorem.chat.bootstrap.v1', csrfToken: 'csrf' })
    const rest = url.pathname.slice(CAPABILITIES.length + 1).split('/')
    if (rest.length === 2) return json(described)
    if (rest[2] === 'query') {
      // The page a locate-walk reads when nothing names the collection; the
      // people collection answers its own rows, for a relation's picker.
      const people =
        (body?.query as { collectionKey?: string } | undefined)
          ?.collectionKey === 'people'
      return json({
        records: people ? peopleRows : rows,
        total: rows.length,
        filtered: false,
        truncated: false,
        definitionId: 'capdef:abc',
      })
    }
    if (rest[2] === 'records') {
      if (recordReadGate) await recordReadGate
      // One record, read by id. Absent and withheld are the same refusal.
      const wanted = decodeURIComponent(rest[3] ?? '')
      const found = rows.find((one) => one.id === wanted)
      if (!found) return refusal(404, codes.RECORD_NOT_FOUND)
      return json(found)
    }
    if (rest[2] === 'invocations') {
      if (receiptRefused) return refusal(404, 'invocation_unknown')
      return json({
        recordId: 'capop:abc',
        invocationKey: 'k',
        instanceId: 'tracker/main',
        actionKey: 'complete',
        definitionId: 'capdef:abc',
        requestDigest: 'sha256:abc',
        startedAtMs: 1,
        status: 'finished',
        outcome: {
          outcome: 'completed',
          affected: [{ id: 'rec-1', revision: 8 }],
          fields: {},
        },
        finishedAtMs: 2,
      })
    }
    if (rest[2] === 'invoke') {
      if (invokeRefusal)
        return refusal(invokeRefusal.status, invokeRefusal.code)
      const receipt = {
        recordId: 'capop:abc',
        invocationKey: body?.invocationKey,
        instanceId: 'tracker/main',
        actionKey: body?.actionKey,
        definitionId: 'capdef:abc',
        requestDigest: 'sha256:abc',
        startedAtMs: 1,
      }
      if (invokeDispatched) return json({ ...receipt, status: 'dispatched' })
      if (invokeFailure)
        return json({
          ...receipt,
          status: 'finished',
          outcome: { outcome: 'failed', ...invokeFailure },
          finishedAtMs: 2,
        })
      return json({
        recordId: 'capop:abc',
        invocationKey: body?.invocationKey,
        instanceId: 'tracker/main',
        actionKey: body?.actionKey,
        definitionId: 'capdef:abc',
        requestDigest: 'sha256:abc',
        startedAtMs: 1,
        status: 'finished',
        outcome: {
          outcome: 'completed',
          affected: [{ id: String(body?.recordId), revision: 8 }],
          fields: {
            title: body?.inputs
              ? (body.inputs as Record<string, unknown>).title
              : undefined,
          },
        },
        finishedAtMs: 2,
      })
    }
    return json({}, 404)
  }) as typeof fetch
})

afterEach(() => {
  window.fetch = realFetch
  cleanup()
})

async function showRecord(
  settings: Record<string, unknown> = {
    instanceId: 'tracker/main',
    recordId: 'rec-1',
  },
  inputs: Record<string, unknown> = {},
  grant?: Grant,
  /** The page file it is on; none outside a page. */
  page?: string,
) {
  if (grant) described = describeResult(grant)
  const outputs: Record<string, unknown[]> = {}
  const view: ModuleViewProps = {
    instanceId: 'record-1',
    path: 'record-1',
    settings,
    inputs,
    output: (name, value) => {
      ;(outputs[name] ??= []).push(value)
    },
    emit: () => {},
    arranging: false,
  }
  const shown = await render(
    <PageFileContext.Provider value={page}>
      <PageRuntimeProvider>
        <CapabilityRecordModule {...view} />
      </PageRuntimeProvider>
    </PageFileContext.Provider>,
  )
  return { ...shown, outputs }
}

const invoked = () => calls.filter((call) => call.path.endsWith('/invoke'))

const peopleRows = [
  row('person-1', { name: 'Ada' }, 1),
  row('person-2', { name: 'Grace' }, 1),
]

/** The options a select offers, as value and the words shown. */
const optionsOf = (select: HTMLSelectElement) =>
  [...select.options].map((one) => ({
    value: one.value,
    text: one.textContent.trim(),
    disabled: one.disabled,
  }))

/** Picks a value through the select's own setter, as React reads a change. */
function choose(select: HTMLSelectElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLSelectElement.prototype,
      'value',
    )!.set!.call(select, value)
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

/** Every input value any invoke carried: none may be null. */
const sentValues = () =>
  invoked().flatMap((call) =>
    Object.values((call.body?.inputs ?? {}) as Record<string, unknown>),
  )

// ── A relation is picked, never cleared: the contract cannot clear a field ───

test('a relation that holds a value offers no clearing choice, and never sends null', async () => {
  rows = [
    {
      ...taskRows[0]!,
      fields: { ...taskRows[0]!.fields, assignee: 'person-1' },
    },
  ]
  const { container } = await showRecord()
  await waitFor(() => container.textContent.includes('Write the plan'))
  await act(async () => editMark(container, 'Assignee')?.click())
  const select = await waitFor(() => {
    const found = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Choose Assignee"]',
    )
    return found && found.options.length > 1 ? found : null
  })
  // Only the people it can point at: no empty value, no "(none)".
  expect(optionsOf(select)).toEqual([
    { value: 'person-1', text: 'Ada', disabled: false },
    { value: 'person-2', text: 'Grace', disabled: false },
  ])
  expect(select.value).toBe('person-1')
  // An empty value forced onto the control is not taken as a choice.
  choose(select, '')
  expect(container.textContent).not.toContain('unsaved')

  choose(select, 'person-2')
  await waitFor(() => container.textContent.includes('unsaved'))
  await act(async () => button(container, 'Save Assignee')?.click())
  const call = await waitFor(() => invoked()[0])
  expect(call.body!.actionKey).toBe('assign')
  expect(call.body!.inputs).toEqual({ assignee: 'person-2' })
  expect(sentValues()).not.toContain(null)
})

/** A key pressed in a field, as the records' editors listen for it. */
function press(field: HTMLElement, key: string) {
  act(() => {
    field.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
  })
}

const clearControl = (root: ParentNode) =>
  [...root.querySelectorAll('button')].find(
    (one) => one.textContent.trim() === 'Clear',
  )

test('the record’s own editors offer no clear control, and an emptied field is never sent as null', async () => {
  const { container } = await showRecord()
  await waitFor(() => container.textContent.includes('Write the plan'))

  // A date: no Clear, and emptying it is refused where it is typed.
  await act(async () => editMark(container, 'Due')?.click())
  const day = await waitFor(() => input(container, 'Due'))
  expect(clearControl(container)).toBeUndefined()
  type(day, '')
  pressEnter(day)
  expect(day.getAttribute('aria-invalid')).toBe('true')
  expect(container.textContent).toContain('Cannot be emptied')
  press(day, 'Escape')
  await waitFor(() => !input(container, 'Due'))

  // A number: emptied, it is refused in place too.
  await act(async () => editMark(container, 'Effort (minutes)')?.click())
  const effort = await waitFor(() => input(container, 'Effort (minutes)'))
  type(effort, '')
  pressEnter(effort)
  expect(effort.getAttribute('aria-invalid')).toBe('true')
  expect(effort.placeholder).toBe('Cannot be emptied')
  press(effort, 'Escape')
  await waitFor(() => !input(container, 'Effort (minutes)'))

  // A select offers its variants and no Clear.
  await act(async () => editMark(container, 'Status')?.click())
  await waitFor(() => container.querySelector('[role="option"]'))
  expect(clearControl(container)).toBeUndefined()

  // Nothing was left to save, and nothing was sent.
  expect(container.textContent).not.toContain('unsaved')
  expect(invoked()).toHaveLength(0)
  expect(sentValues()).not.toContain(null)
})

test('an empty relation shows a placeholder that cannot be chosen', async () => {
  const { container } = await showRecord()
  await waitFor(() => container.textContent.includes('Write the plan'))
  await act(async () => editMark(container, 'Assignee')?.click())
  const select = await waitFor(() => {
    const found = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Choose Assignee"]',
    )
    return found && found.options.length > 1 ? found : null
  })
  const [placeholder, ...people] = optionsOf(select)
  // The empty state is shown, and disabled, so it is never a submitted value.
  expect(placeholder).toEqual({
    value: '',
    text: 'Not set · choose one',
    disabled: true,
  })
  expect(people.map((one) => one.value)).toEqual(['person-1', 'person-2'])
  expect(select.value).toBe('')
  choose(select, '')
  expect(container.textContent).not.toContain('unsaved')
  expect(button(container, 'Save Assignee')).toBeUndefined()

  choose(select, 'person-1')
  await waitFor(() => container.textContent.includes('unsaved'))
  await act(async () => button(container, 'Save Assignee')?.click())
  const call = await waitFor(() => invoked()[0])
  expect(call.body!.inputs).toEqual({ assignee: 'person-1' })
  expect(sentValues()).not.toContain(null)
})

test('the fields come from the resolved schema, at the revision on screen', async () => {
  const { container, outputs } = await showRecord()
  await waitFor(() => container.textContent.includes('Write the plan'))
  // This module shows one record, as describe's resolved schemas name its fields.
  expect(container.textContent).toContain('Effort (minutes)')
  expect(container.textContent).toContain('20')
  expect(container.textContent).toContain('Tasks · r6')
  expect(container.textContent).not.toContain('Sketch the page')
  // A record id named with no collection is located first: the definition's
  // collections are walked, and the row itself comes from the record route.
  const queries = calls.filter((call) => call.path.endsWith('/query'))
  expect(queries[0]!.body).toMatchObject({
    instanceId: 'tracker/main',
    query: { collectionKey: 'tasks' },
  })
  expect(calls.some((call) => call.path.endsWith('/records/rec-1'))).toBe(true)
  // What it shows is also its Selected output, with where the record came from.
  expect(outputs.selected?.at(-1)).toEqual({
    id: 'rec-1',
    kind: 'capability-record',
    label: 'Write the plan',
    scope: {
      kind: 'capability',
      instanceId: 'tracker/main',
      collectionKey: 'tasks',
    },
  })
})

test('editing a field saves through the update action that declares it, at its revision', async () => {
  const { container } = await showRecord()
  await waitFor(() => container.textContent.includes('Write the plan'))
  await act(async () => editMark(container, 'Title')?.click())
  const field = await waitFor(() => input(container, 'Title'))
  type(field, 'Write the plan v2')
  pressEnter(field)
  await waitFor(() => container.textContent.includes('unsaved'))
  await act(async () => button(container, 'Save Title')?.click())
  const call = await waitFor(() => invoked()[0])
  // An untouched lifecycle status must not be sent back as a self-transition.
  expect(call.body!.inputs).toEqual({ title: 'Write the plan v2' })
  expect(call.body!.actionKey).toBe('update')
  expect(call.body!.recordId).toBe('rec-1')
  expect(call.body!.expectedRevision).toBe(6)
  expect(call.body!.invocationKey).toBeString()
  expect(call.headers.get('Idempotency-Key')).toBe(
    call.body!.invocationKey as string,
  )
  await waitFor(() => container.textContent.includes('update saved · r8'))
  // The draft is gone once the call saved: what is shown is what the instance holds.
  await waitFor(() => !container.textContent.includes('unsaved'))
})

test('a change no declared action writes is refused here, and says what the actions do write', async () => {
  const { container } = await showRecord()
  await waitFor(() => container.textContent.includes('Write the plan'))
  // No action covers `due_at`, so saving a change to it has to stop here.
  await act(async () => editMark(container, 'Due')?.click())
  const field = await waitFor(() => input(container, 'Due'))
  type(field, '2026-12-01')
  pressEnter(field)
  await waitFor(() => container.textContent.includes('unsaved'))
  await act(async () => button(container, 'Save Due')?.click())
  await waitFor(() => container.querySelector('[role="alert"]'))
  expect(container.textContent).toContain(
    'No declared action your grant reaches covers due_at',
  )
  expect(container.textContent).toContain('Complete (status, completed_at)')
  expect(invoked().length).toBe(0)
})

test('a stale revision is a reload-and-retry state', async () => {
  invokeRefusal = { status: 409, code: codes.REVISION_CONFLICT }
  const { container } = await showRecord()
  await waitFor(() => container.textContent.includes('Write the plan'))
  await act(async () => button(container, 'Complete')?.click())
  const call = await waitFor(() => invoked()[0])
  expect(call.body).toMatchObject({
    actionKey: 'complete',
    recordId: 'rec-1',
    expectedRevision: 6,
    inputs: {},
  })
  await waitFor(() => container.querySelector('[role="alert"]'))
  expect(container.textContent).toContain(
    'changed this record while you were looking at it',
  )
  expect(button(container, 'Reload')).toBeTruthy()
})

test('a draft cannot be retried until the latest record has loaded', async () => {
  invokeRefusal = { status: 409, code: codes.REVISION_CONFLICT }
  const { container } = await showRecord()
  await waitFor(() => container.textContent.includes('Write the plan'))
  await act(async () => editMark(container, 'Title')?.click())
  const field = await waitFor(() => input(container, 'Title'))
  type(field, 'My draft')
  pressEnter(field)
  await act(async () => button(container, 'Save Title')?.click())
  await waitFor(() => button(container, 'Reload'))

  const gate = Promise.withResolvers<void>()
  recordReadGate = gate.promise
  rows = taskRows.map((row) =>
    row.id === 'rec-1' ? { ...row, revision: 7 } : row,
  )
  try {
    await act(async () => button(container, 'Reload')?.click())
    expect(button(container, 'Save Title')?.disabled).toBe(true)
    expect(invoked()).toHaveLength(1)
  } finally {
    gate.resolve()
  }

  invokeRefusal = undefined
  await waitFor(() => button(container, 'Save Title')?.disabled === false)
  await act(async () => button(container, 'Save Title')?.click())
  await waitFor(() => invoked().length === 2)
  expect(invoked()[1]!.body).toMatchObject({
    expectedRevision: 7,
    inputs: { title: 'My draft' },
  })
})

test('a record that is not in the collections says so', async () => {
  rows = []
  const { container } = await showRecord()
  await waitFor(() => container.textContent.includes('Not in this capability'))
  expect(container.textContent).toContain('rec-1')
  // Withheld by a context policy, the instance answers the same way: the module
  // says "not here" and never infers a permission it cannot see.
  expect(container.textContent).toContain('withholds it from this caller')
})

test('a bound Item names the collection, so the record is read direct', async () => {
  const { container } = await showRecord(
    { instanceId: 'tracker/main', recordId: '' },
    {
      record: {
        id: 'rec-2',
        kind: 'capability-record',
        scope: {
          kind: 'capability',
          instanceId: 'tracker/main',
          collectionKey: 'tasks',
        },
      },
    },
  )
  await waitFor(() => container.textContent.includes('Sketch the page'))
  // The collection is already named, so nothing is walked: one read by id.
  expect(calls.filter((call) => call.path.endsWith('/query')).length).toBe(0)
  const read = calls.filter((call) => call.path.endsWith('/records/rec-2'))
  expect(read.length).toBe(1)
  expect(read[0]!.method).toBe('GET')
})

test('what it shows rides to the composer as context, at one revision', async () => {
  const { container, outputs } = await showRecord()
  const context = await waitFor(
    () => outputs.context?.at(-1) as CapabilityContextReference,
  )
  // Outside a page there is no page file to name; the module still names itself.
  expect(context.location.resource).toEqual({
    kind: 'capability',
    instanceId: 'tracker/main',
    collectionKey: 'tasks',
    selectedComponentId: 'record-1',
    purpose: 'Track personal projects and tasks',
    selected: [{ id: 'rec-1', revision: 6 }],
    filtered: false,
    truncated: false,
  })
  // No field values ride in the resource: the agent re-reads them by query. The
  // label is the reference's own name, as a record reference carries one.
  expect(JSON.stringify(context.location.resource)).not.toContain(
    'Write the plan',
  )
  expect(context.label).toContain('Write the plan')
  expect(container.textContent).toContain('Ask Theorem')
})

test('a view bound in from a connected table is named by the envelope', async () => {
  const { outputs } = await showRecord(undefined, { viewKey: 'next' })
  const context = await waitFor(
    () => outputs.context?.at(-1) as CapabilityContextReference,
  )
  expect(context.location.resource).toMatchObject({
    instanceId: 'tracker/main',
    viewKey: 'next',
    selected: [{ id: 'rec-1', revision: 6 }],
  })
})

test('on a page, the envelope names the page file by its path', async () => {
  const { outputs } = await showRecord(
    undefined,
    undefined,
    undefined,
    'Pages/Desk.page.json',
  )
  const context = await waitFor(
    () => outputs.context?.at(-1) as CapabilityContextReference,
  )
  expect(context.location.resource).toMatchObject({
    pageId: 'Pages/Desk.page.json',
    selectedComponentId: 'record-1',
  })
})

test('a grant without read is a permission state, and nothing is walked', async () => {
  const { container } = await showRecord(
    { instanceId: 'tracker/main', recordId: 'rec-1' },
    {},
    { principal: 'user:travis', read: false, invoke: [], author: false },
  )
  await waitFor(() =>
    container.textContent.includes('does not include reading'),
  )
  expect(calls.filter((call) => call.path.endsWith('/query')).length).toBe(0)
})

test('an action that would write something other than was entered asks before it runs', async () => {
  // The only action over `title` writes a literal, not what is typed.
  described = {
    ...describeResult(),
    definition: {
      ...describeResult().definition,
      actions: [
        {
          key: 'reset_title',
          label: 'Reset title',
          collectionKey: 'tasks',
          creates: false,
          input: [],
          preconditions: [],
          effects: [
            { fieldKey: 'title', source: 'literal', value: 'Untitled' },
          ],
        },
      ],
    },
  }
  const { container } = await showRecord()
  await waitFor(() => container.textContent.includes('Write the plan'))
  await act(async () => editMark(container, 'Title')?.click())
  const field = await waitFor(() => input(container, 'Title'))
  type(field, 'Ship it')
  pressEnter(field)
  await waitFor(() => container.textContent.includes('unsaved'))
  await act(async () => button(container, 'Save Title')?.click())
  await waitFor(() => container.textContent.includes('not what you entered'))
  expect(container.textContent).toContain(
    'Reset title writes title as Untitled',
  )
  expect(invoked().length).toBe(0)
  // Keeping on editing runs nothing; going ahead runs the named action once.
  await act(async () => button(container, 'Keep editing')?.click())
  expect(container.textContent).not.toContain('not what you entered')
  await act(async () => button(container, 'Save Title')?.click())
  await act(async () => button(container, 'Reset title anyway')?.click())
  const call = await waitFor(() => invoked()[0])
  expect(call.body!.actionKey).toBe('reset_title')
  expect(call.body!.expectedRevision).toBe(6)
  expect(invoked().length).toBe(1)
})

test('what the module published is withdrawn once it no longer shows the record', async () => {
  const { container, outputs } = await showRecord()
  await waitFor(() => container.textContent.includes('Write the plan'))
  await waitFor(() => outputs.context?.at(-1))
  expect(outputs.selected?.at(-1)).toBeDefined()
  cleanup()
  expect(outputs.context?.at(-1)).toBeUndefined()
  expect(outputs.selected?.at(-1)).toBeUndefined()
})

test('a call the journal holds unfinished says so, and its receipt is read back on asking', async () => {
  invokeDispatched = true
  const { container } = await showRecord()
  await waitFor(() => container.textContent.includes('Write the plan'))
  await act(async () => button(container, 'Complete')?.click())
  await waitFor(() =>
    container.textContent.includes(
      'complete is journaled and has not finished, so whether it took effect is not yet known.',
    ),
  )
  await act(async () => button(container, 'Check its receipt')?.click())
  await waitFor(() => container.textContent.includes('complete saved · r8.'))
})

test('a receipt that cannot be read back says why', async () => {
  invokeDispatched = true
  receiptRefused = true
  const { container } = await showRecord()
  await waitFor(() => container.textContent.includes('Write the plan'))
  await act(async () => button(container, 'Complete')?.click())
  await waitFor(() => button(container, 'Check its receipt'))
  await act(async () => button(container, 'Check its receipt')?.click())
  const alert = await waitFor(() => container.querySelector('[role="alert"]'))
  expect(alert.textContent).toContain('The record moved on since it was read.')
})

test('a call the executor finished as failed says its code and why, with no reload unless it is stale', async () => {
  invokeFailure = {
    code: codes.PRECONDITION_FAILED,
    message: 'status is not one of next, in_progress, waiting',
  }
  const { container } = await showRecord()
  await waitFor(() => container.textContent.includes('Write the plan'))
  await act(async () => button(container, 'Complete')?.click())
  const alert = await waitFor(() => container.querySelector('[role="alert"]'))
  expect(alert.textContent).toContain(
    'capability_precondition_failed: status is not one of next, in_progress, waiting',
  )
  expect(button(container, 'Reload')).toBeUndefined()
})
