// SOURCING: bun:test over the capability record module, rendered with test/workspace's render into
// happy-dom with window.fetch standing in for a Theorem that serves /api/capabilities/v1. What is
// asserted is the module's own rule: the fields come from describe's resolved schemas, a save runs a
// declared action naming the revision on screen, and a change no declared action writes is refused
// here rather than pushed through a second path.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { act } from 'react'
import { cleanup, render, waitFor } from '../../../test/workspace'
import { CapabilityRecordModule } from './capability-record'
import { PageRuntimeProvider } from '../pages/page-runtime'
import { CAPABILITIES } from '@/lib/capabilities/api'
import { codes } from '@/lib/capabilities/contract'
import type {
  QueryResult,
  DescribeResult,
  Grant,
} from '@/lib/capabilities/contract'
import { describeResult, taskRows } from './fixture'
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
      // A record is found by walking its collection: one page, no cursor.
      return json({
        records: rows,
        total: rows.length,
        filtered: false,
        truncated: false,
        definitionId: 'capdef:abc',
      })
    }
    if (rest[2] === 'invoke') {
      if (invokeRefusal)
        return refusal(invokeRefusal.status, invokeRefusal.code)
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
    <PageRuntimeProvider>
      <CapabilityRecordModule {...view} />
    </PageRuntimeProvider>,
  )
  return { ...shown, outputs }
}

const invoked = () => calls.filter((call) => call.path.endsWith('/invoke'))

test('the fields come from the resolved schema, at the revision on screen', async () => {
  const { container, outputs } = await showRecord()
  await waitFor(() => container.textContent.includes('Write the plan'))
  // This module shows one record, as describe's resolved schemas name its fields.
  expect(container.textContent).toContain('Effort (minutes)')
  expect(container.textContent).toContain('20')
  expect(container.textContent).toContain('Tasks · r6')
  expect(container.textContent).not.toContain('Sketch the page')
  // One record is read by walking its collection through the query route.
  const queries = calls.filter((call) => call.path.endsWith('/query'))
  expect(queries[0]!.body).toMatchObject({
    instanceId: 'tracker/main',
    query: { collectionKey: 'tasks' },
  })
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
  // `update` is the generic action: it declares an input for the edited field.
  // An action writes its whole effect set, so the fields nobody edited ride at
  // the values the row shows — which is why a declared action whose effects are
  // exactly the edited fields is preferred over this one.
  expect(call.body!.actionKey).toBe('update')
  expect(call.body!.recordId).toBe('rec-1')
  expect(call.body!.expectedRevision).toBe(6)
  expect(call.body!.invocationKey).toBeString()
  expect(call.headers.get('Idempotency-Key')).toBe(
    call.body!.invocationKey as string,
  )
  expect(call.body!.inputs).toEqual({
    title: 'Write the plan v2',
    status: 'next',
    effort_minutes: 20,
  })
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
  expect(container.textContent).toContain('No declared action covers due_at')
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

test('a record that is not in the collections says so', async () => {
  rows = []
  const { container } = await showRecord()
  await waitFor(() => container.textContent.includes('Not in this capability'))
  expect(container.textContent).toContain('rec-1')
})

test('a bound Item names the record, and its scope names the collection to walk', async () => {
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
  const queries = calls.filter((call) => call.path.endsWith('/query'))
  expect(queries[0]!.body).toMatchObject({ query: { collectionKey: 'tasks' } })
})

test('what it shows rides to the composer as context, at one revision', async () => {
  const { container, outputs } = await showRecord()
  const context = await waitFor(
    () => outputs.context?.at(-1) as CapabilityContextReference,
  )
  // Outside a page route there is no page to name, so the envelope carries none.
  expect(context.location.resource).toEqual({
    kind: 'capability',
    instanceId: 'tracker/main',
    collectionKey: 'tasks',
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
