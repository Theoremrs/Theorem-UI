// SOURCING: bun:test over the capability table module, rendered with test/workspace's render (a
// QueryClient) into happy-dom, with window.fetch standing in for a Theorem that serves
// /api/capabilities/v1. What the module decides is what is asserted: which view it reads, which
// action a click runs, what a receipt leaves on screen, and what the composer envelope carries. No
// backend is reached and no model is called.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { act } from 'react'
import { cleanup, render, waitFor } from '../../../test/workspace'
import { CapabilityTableModule } from './capability-table'
import { PageFileContext } from '../pages/page-route'
import { PageRuntimeProvider } from '../pages/page-runtime'
import { CAPABILITIES } from '@/lib/capabilities/api'
import { codes } from '@/lib/capabilities/contract'
import type {
  CapabilityRecordRow,
  DescribeResult,
  QueryRequest,
  Grant,
} from '@/lib/capabilities/contract'
import { describeResult, queryResult, readerGrant, taskRows } from './fixture'
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
let described: DescribeResult
/** The next invoke answers this problem instead of a receipt. */
let invokeRefusal: { status: number; code: string } | undefined
/** What each view answers: rows, and whether a filter or the page cut them down. */
let answers: Record<
  string,
  { rows: CapabilityRecordRow[]; filtered: boolean; total: number }
>
/** The definition version the rows were read under; a patch has to name it. */
let pinned = 'capdef:abc'

const button = (container: HTMLElement, name: string) =>
  [...container.querySelectorAll('button')].find(
    (one) => one.textContent.trim() === name,
  )

/** A control by the name it gives assistive tech, not the words it shows. */
const byLabel = (container: ParentNode, label: string) =>
  container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)

function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value',
  )!.set!
  act(() => {
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

beforeEach(() => {
  calls = []
  described = describeResult()
  invokeRefusal = undefined
  pinned = 'capdef:abc'
  answers = {
    next: { rows: taskRows, filtered: true, total: 4 },
    all: { rows: [], filtered: false, total: 0 },
    people: { rows: [], filtered: false, total: 0 },
  }
  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    // The SDK's transport hands on a Request, so the body comes from either
    // shape, as components/work/api.test.ts reads it.
    const request = input instanceof Request ? input : undefined
    const url = new URL(request ? request.url : String(input))
    const headers = new Headers(
      init?.headers ?? (request ? request.headers : undefined),
    )
    const method = init?.method ?? (request ? request.method : 'GET')
    const raw =
      init?.body ?? (request ? await request.clone().text() : undefined)
    const body = raw
      ? (JSON.parse(String(raw)) as Record<string, unknown>)
      : undefined
    calls.push({ method, path: url.pathname, body, headers })
    const json = (value: unknown, status = 200) =>
      new Response(JSON.stringify(value), {
        status,
        headers: { 'content-type': 'application/json' },
      })
    if (url.pathname === '/api/chat/v1/bootstrap')
      return json({ schema: 'theorem.chat.bootstrap.v1', csrfToken: 'csrf' })
    const rest = url.pathname.slice(CAPABILITIES.length + 1).split('/')
    const tail = rest[2]
    if (rest.length === 1) return json({ instances: [] })
    if (rest.length === 2) return json(described)
    if (tail === 'query') {
      const asked = body as unknown as QueryRequest
      const answer = answers[asked.viewKey ?? ''] ?? {
        rows: [],
        filtered: false,
        total: 0,
      }
      return json(
        queryResult(answer.rows, {
          filtered: answer.filtered,
          total: answer.total,
          definitionId: pinned,
        }),
      )
    }
    if (tail === 'invoke') {
      if (invokeRefusal)
        return new Response(
          JSON.stringify({
            type: 'about:blank',
            title: 'Refused',
            status: invokeRefusal.status,
            code: invokeRefusal.code,
            detail: 'The record moved on.',
          }),
          {
            status: invokeRefusal.status,
            headers: { 'content-type': 'application/problem+json' },
          },
        )
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
          affected: [{ id: body?.recordId ?? 'rec-new', revision: 7 }],
          fields: { status: 'done' },
        },
        finishedAtMs: 2,
      })
    }
    if (tail === 'author') {
      if (body?.expectedDefinitionId !== 'capdef:abc')
        return new Response(
          JSON.stringify({
            type: 'about:blank',
            title: 'Refused',
            status: 409,
            code: codes.DEFINITION_CONFLICT,
            detail: 'A newer definition is pinned.',
          }),
          {
            status: 409,
            headers: { 'content-type': 'application/problem+json' },
          },
        )
      return json({
        definitionId: 'capdef:def',
        instance: { instanceId: 'tracker/main', definitionId: 'capdef:def' },
      })
    }
    return json({}, 404)
  }) as typeof fetch
})

afterEach(() => {
  window.fetch = realFetch
  cleanup()
})

async function showTable(
  settings: Record<string, unknown> = {
    instanceId: 'tracker/main',
    viewKey: '',
  },
  grant?: Grant,
  /** The page file it is on, and where on it; none outside a page. */
  where: { page?: string; path?: string } = {},
) {
  if (grant) described = describeResult(grant)
  const outputs: Record<string, unknown[]> = {}
  const view: ModuleViewProps = {
    instanceId: 'table-1',
    path: where.path ?? 'table-1',
    settings,
    inputs: {},
    output: (name, value) => {
      ;(outputs[name] ??= []).push(value)
    },
    emit: () => {},
    arranging: false,
  }
  const shown = await render(
    <PageFileContext.Provider value={where.page}>
      <PageRuntimeProvider>
        <CapabilityTableModule {...view} />
      </PageRuntimeProvider>
    </PageFileContext.Provider>,
  )
  return { ...shown, outputs }
}

const sentTo = (suffix: string) =>
  calls.filter((call) => call.path.endsWith(suffix))
const reads = () => calls.filter((call) => call.method === 'GET')

test('a view reads its rows through the instance contract and offers its sibling views', async () => {
  const { container } = await showTable()
  await waitFor(() => container.textContent.includes('Write the plan'))
  expect(container.textContent).toContain('Sketch the page')
  // The switcher holds the views over this collection, and no other's.
  expect(button(container, 'Next')).toBeTruthy()
  expect(button(container, 'All tasks')).toBeTruthy()
  expect(button(container, 'People')).toBeUndefined()
  const queries = sentTo('/query')
  expect(queries.length).toBe(1)
  expect(queries[0]!.body).toEqual({
    instanceId: 'tracker/main',
    viewKey: 'next',
    limit: 50,
  })
  // A view filter is read from the answer, not recomputed here.
  expect(container.textContent).toContain('status is next')
})

test('switching the view asks for that view’s rows', async () => {
  const { container } = await showTable()
  await waitFor(() => container.textContent.includes('Write the plan'))
  await act(async () => button(container, 'All tasks')?.click())
  await waitFor(() => sentTo('/query').length > 1)
  expect(sentTo('/query').at(-1)!.body).toEqual({
    instanceId: 'tracker/main',
    viewKey: 'all',
    limit: 50,
  })
})

test('quick-add runs the create action, then reads the rows back', async () => {
  const { container } = await showTable()
  await waitFor(() => container.textContent.includes('Write the plan'))
  await act(async () => button(container, 'Add task')?.click())
  const title = await waitFor(() =>
    container.querySelector<HTMLInputElement>('input[aria-label="title"]'),
  )
  type(title, 'Ship the slice')
  await act(async () => button(container, 'Add task')?.click())
  const invoked = await waitFor(() => sentTo('/invoke')[0])
  expect(invoked.body).toEqual({
    instanceId: 'tracker/main',
    actionKey: 'add',
    invocationKey: expect.any(String),
    inputs: { title: 'Ship the slice', due_at: null },
  })
  expect(invoked.body!.recordId).toBeUndefined()
  expect(invoked.headers.get('Idempotency-Key')).toBe(
    invoked.body!.invocationKey as string,
  )
  expect(invoked.headers.get('X-CSRF-Token')).toBeTruthy()
  // The receipt is the answer the person reads, and the rows come back at their new revisions.
  await waitFor(() => container.textContent.includes('add saved'))
  expect(sentTo('/query').length).toBeGreaterThan(1)
})

test('a row action names the record and the revision on screen', async () => {
  const { container } = await showTable()
  await waitFor(() => container.textContent.includes('Write the plan'))
  await act(async () => button(container, 'Complete')?.click())
  const invoked = await waitFor(() => sentTo('/invoke')[0])
  expect(invoked.body).toEqual({
    instanceId: 'tracker/main',
    actionKey: 'complete',
    invocationKey: expect.any(String),
    recordId: 'rec-1',
    expectedRevision: 6,
    inputs: {},
  })
  await waitFor(() => container.textContent.includes('complete saved · r7'))
  // The row is marked at the revision the journal reports until the rows read back the same.
  expect(container.textContent).toContain('saved · r7')
})

test('a refusal the executor answers with is a failed state, not a silent one', async () => {
  invokeRefusal = { status: 409, code: codes.REVISION_CONFLICT }
  const { container } = await showTable()
  await waitFor(() => container.textContent.includes('Write the plan'))
  await act(async () => button(container, 'Complete')?.click())
  await waitFor(() => container.querySelector('[role="alert"]'))
  expect(container.textContent).toContain(
    'changed this record while you were looking at it',
  )
  expect(button(container, 'Reload')).toBeTruthy()
})

test('a selection rides to the composer as context, with no record bodies', async () => {
  const { container, outputs } = await showTable()
  await waitFor(() => container.textContent.includes('Write the plan'))
  const boxes = container.querySelectorAll<HTMLElement>(
    '[data-slot="checkbox"]',
  )
  expect(boxes.length).toBe(2)
  await act(async () => boxes[0]!.click())
  const last = () => outputs.context?.at(-1)
  const context = await waitFor(() => last() as CapabilityContextReference)
  const { resource } = context.location
  expect(resource).toEqual({
    kind: 'capability',
    instanceId: 'tracker/main',
    collectionKey: 'tasks',
    selectedComponentId: 'table-1',
    viewKey: 'next',
    purpose: 'Track personal projects and tasks',
    selected: [{ id: 'rec-1', revision: 6 }],
    filtered: true,
    truncated: false,
  })
  // Compact: no field values ride along, so the agent re-reads them by query.
  expect(JSON.stringify(context)).not.toContain('Write the plan')
  // The selected record is also the module's Selected item, for a connected detail.
  const selected = outputs.selected?.at(-1)
  expect(selected).toEqual({
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

test('on a page, the envelope names the page file by its path and the page component that shows it', async () => {
  const { container, outputs } = await showTable(undefined, undefined, {
    page: 'Pages/Desk.page.json',
    // Inside a composite: the page holds the composite, which a page_patch names.
    path: 'cols/table-1',
  })
  await waitFor(() => container.textContent.includes('Write the plan'))
  await act(async () =>
    container.querySelector<HTMLElement>('[data-slot="checkbox"]')!.click(),
  )
  const context = await waitFor(
    () => outputs.context?.at(-1) as CapabilityContextReference,
  )
  expect(context.location.resource).toMatchObject({
    pageId: 'Pages/Desk.page.json',
    selectedComponentId: 'cols',
    viewKey: 'next',
  })
})

test('a grant without read is a permission state, and no rows are asked for', async () => {
  const { container } = await showTable(
    { instanceId: 'tracker/main', viewKey: '' },
    { ...readerGrant, read: false },
  )
  await waitFor(() =>
    container.textContent.includes('does not include reading'),
  )
  expect(sentTo('/query').length).toBe(0)
  expect(sentTo('/invoke').length).toBe(0)
})

test('a view with no rows says the collection has none', async () => {
  const { container } = await showTable({
    instanceId: 'tracker/main',
    viewKey: 'all',
  })
  await waitFor(() => container.textContent.includes('Nothing here yet'))
  expect(container.textContent).toContain('Tasks has no records the view shows')
})

test('a filtered view with no rows says nothing matches and names its filter', async () => {
  // The answer is empty and `filtered` is the server's, not read off the row count.
  answers.next = { rows: [], filtered: true, total: 0 }
  const { container } = await showTable()
  await waitFor(() => container.textContent.includes('Nothing matches'))
  expect(container.textContent).toContain(
    'No record fits this view: status is next.',
  )
})

test('a module that names no instance lists what this caller may see', async () => {
  const { container } = await showTable({ instanceId: '', viewKey: '' })
  await waitFor(() =>
    container.textContent.includes('Name the capability instance'),
  )
  expect(sentTo('/query').length).toBe(0)
})

// ── Authoring, through the table module's own affordance ──────────────────────

/**
 * Where a dialog's content is: Base UI portals it to the document, so it is not
 * inside the module's own container.
 */
const screen = () => document.body

/** The dialog, opened from the view bar that shows the rows it would change. */
async function authoring() {
  await act(async () => button(screen(), 'Fields')?.click())
  await waitFor(() => screen().textContent.includes('Author Project tracker'))
}

const dialogInput = (label: string) =>
  document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)

const dialogSelect = (label: string) =>
  document.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)

function fill(field: HTMLInputElement | HTMLSelectElement, value: string) {
  const proto =
    field instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!
  act(() => {
    setter.call(field, value)
    field.dispatchEvent(
      new Event(field instanceof HTMLSelectElement ? 'change' : 'input', {
        bubbles: true,
      }),
    )
  })
}

test('the authoring controls are offered to a caller who can author, and hidden from one who cannot', async () => {
  const { container } = await showTable()
  await waitFor(() => container.textContent.includes('Write the plan'))
  await authoring()
  expect(screen().textContent).toContain('Add field')
  expect(screen().textContent).toContain('Rename')
  expect(screen().textContent).toContain('View filter')

  const readonly = await showTable(
    { instanceId: 'tracker/main', viewKey: '' },
    readerGrant,
  )
  await waitFor(() => readonly.container.textContent.includes('Write the plan'))
  expect(button(readonly.container, 'Fields')).toBeUndefined()
})

test('adding an optional field patches the version the rows were read under', async () => {
  const { container } = await showTable()
  await waitFor(() => container.textContent.includes('Write the plan'))
  await authoring()
  fill(dialogInput('Field key')!, 'notes')
  fill(dialogInput('Field label')!, 'Notes')
  await act(async () => byLabel(screen(), 'Add optional field')?.click())
  const patched = await waitFor(() => sentTo('/author')[0])
  expect(patched.body).toEqual({
    expectedDefinitionId: 'capdef:abc',
    ops: [
      {
        op: 'add_field',
        collectionKey: 'tasks',
        field: {
          key: 'notes',
          label: 'Notes',
          fieldType: { kind: 'text' },
          required: false,
        },
      },
    ],
  })
  expect(patched.headers.get('X-CSRF-Token')).toBeTruthy()
  await waitFor(() =>
    screen().textContent.includes(
      'Field added · the definition is now capdef:def',
    ),
  )
})

test('a required field is not offered: slice 1 adds optional fields only', async () => {
  const { container } = await showTable()
  await waitFor(() => container.textContent.includes('Write the plan'))
  await authoring()
  expect(screen().textContent).toContain('adds optional fields only')
  // Nothing asks the person whether the field is required: the op always says no.
  expect(document.querySelector('input[aria-label="Required"]')).toBeNull()
  fill(dialogInput('Field key')!, 'notes')
  fill(dialogInput('Field label')!, 'Notes')
  await act(async () => byLabel(screen(), 'Add optional field')?.click())
  const patched = await waitFor(() => sentTo('/author')[0])
  expect(
    (patched.body!.ops as [{ field: { required: boolean } }])[0].field.required,
  ).toBe(false)
})

test('a key the register will not take is refused before anything is sent', async () => {
  const { container } = await showTable()
  await waitFor(() => container.textContent.includes('Write the plan'))
  await authoring()
  fill(dialogInput('Field key')!, 'Effort Minutes')
  fill(dialogInput('Field label')!, 'Effort')
  const add = byLabel(screen(), 'Add optional field')!
  expect(add.disabled).toBe(true)
  expect(screen().textContent).toContain('Still to do: a lower_snake_case key')
  expect(sentTo('/author').length).toBe(0)
})

test('renaming a field keeps its key and changes only its label', async () => {
  const { container } = await showTable()
  await waitFor(() => container.textContent.includes('Write the plan'))
  await authoring()
  await act(async () => button(screen(), 'Rename')?.click())
  fill(dialogInput('New label')!, 'Task')
  await act(async () => button(screen(), 'Rename field')?.click())
  await act(async () => button(screen(), 'Rename field')?.click())
  const patched = await waitFor(() => sentTo('/author')[0])
  expect(patched.body).toEqual({
    expectedDefinitionId: 'capdef:abc',
    ops: [
      {
        op: 'rename_field',
        collectionKey: 'tasks',
        fieldKey: 'title',
        label: 'Task',
      },
    ],
  })
  await waitFor(() =>
    screen().textContent.includes(
      'Field renamed · the definition is now capdef:def',
    ),
  )
})

test('the filter editor writes a flat and, and says what it cannot show', async () => {
  const { container } = await showTable()
  await waitFor(() => container.textContent.includes('Write the plan'))
  await authoring()
  await act(async () => button(screen(), 'View filter')?.click())
  // The view's own filter reads back as one row, with the ops its type can answer.
  await waitFor(() => dialogSelect('Filter field')?.value === 'status')
  expect(dialogSelect('Filter operator')?.value).toBe('eq')
  expect(dialogInput('Filter value')?.value).toBe('next')
  expect(screen().textContent).toContain('Conditions combine with AND')
  await act(async () => button(screen(), 'Save filter')?.click())
  const patched = await waitFor(() => sentTo('/author')[0])
  expect(patched.body).toEqual({
    expectedDefinitionId: 'capdef:abc',
    ops: [
      {
        op: 'set_view_filter',
        viewKey: 'next',
        filter: {
          op: 'and',
          conditions: [{ op: 'eq', fieldKey: 'status', value: 'next' }],
        },
      },
    ],
  })
})

test('a filter group the editor cannot show is named, not dropped quietly', async () => {
  const nested = describeResult()
  nested.definition = {
    ...nested.definition,
    views: [
      {
        ...nested.definition.views[0]!,
        filter: {
          op: 'and',
          conditions: [
            { op: 'eq', fieldKey: 'status', value: 'next' },
            {
              op: 'or',
              conditions: [
                { op: 'contains', fieldKey: 'title', value: 'quick' },
                { op: 'is_empty', fieldKey: 'due_at' },
              ],
            },
          ],
        },
      },
    ],
  }
  described = nested
  const { container } = await showTable()
  await waitFor(() => container.textContent.includes('Write the plan'))
  await authoring()
  await act(async () => button(screen(), 'View filter')?.click())
  await waitFor(() => screen().textContent.includes('this editor cannot show'))
  expect(screen().textContent).toContain('holds 1 group')
  // The one leaf the editor does show is the one row it offers.
  expect(
    document.querySelectorAll('select[aria-label="Filter field"]').length,
  ).toBe(1)
})

test('a stale definition base is refused, the current one is read back, and the retry is the person’s', async () => {
  // The rows were read under one version; the instance is pinned to another.
  pinned = 'capdef:newer'
  const { container } = await showTable()
  await waitFor(() => container.textContent.includes('Write the plan'))
  await authoring()
  const before = reads().length
  fill(dialogInput('Field key')!, 'notes')
  fill(dialogInput('Field label')!, 'Notes')
  await act(async () => byLabel(screen(), 'Add optional field')?.click())
  await waitFor(() => document.querySelector('[role="alert"]'))
  expect(screen().textContent).toContain(
    'The definition changed while you were editing it',
  )
  expect(screen().textContent).toContain('submit it once more')
  // The dialog does not retry on its own with a key it invented: it reads the
  // current definition back and asks, so the person checks the change against it.
  expect(sentTo('/author').length).toBe(1)
  expect(reads().length).toBeGreaterThan(before)
})
