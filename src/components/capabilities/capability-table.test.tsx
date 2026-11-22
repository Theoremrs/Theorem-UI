// SOURCING: bun:test over the capability table module, rendered with test/workspace's render (a
// QueryClient) into happy-dom, with window.fetch standing in for a Theorem that serves
// /api/capabilities/v1. What the module decides is what is asserted: which view it reads, which
// action a click runs, what a receipt leaves on screen, and what the composer envelope carries. No
// backend is reached and no model is called.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { act } from 'react'
import { cleanup, render, settle, waitFor } from '../../../test/workspace'
import { useComposerReferences } from '@/components/chat/composer-references'
import { CapabilityTableModule } from './capability-table'
import { PageFileContext } from '../pages/page-route'
import { PageRuntimeProvider } from '../pages/page-runtime'
import { CAPABILITIES } from '@/lib/capabilities/api'
import { codes } from '@/lib/capabilities/contract'
import type {
  CapabilityRecordRow,
  DescribeResult,
  InvocationOutcome,
  InvokeTarget,
  QueryFilter,
  QueryRequest,
  Grant,
} from '@/lib/capabilities/contract'
import {
  describeResult,
  ownerGrant,
  queryResult,
  readerGrant,
  taskRows,
} from './fixture'
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
  {
    rows: CapabilityRecordRow[]
    filtered: boolean
    total: number
    truncated?: boolean
    /** A second page, read by the cursor the first one names. */
    next?: CapabilityRecordRow[]
  }
>
/** The next query answers this problem instead of rows. */
let queryRefusal: string | undefined
/** Invokes answer a journaled call that has not finished. */
let invokeDispatched = false
/** A receipt read back answers this problem instead of the finished call. */
let receiptRefusal: string | undefined
/** The definition version the rows were read under; a patch has to name it. */
let pinned = 'capdef:abc'
/** The caller's saved templates. */
let library: unknown[] = []
/** The next finished receipt carries this outcome instead of a completion. */
let invokeOutcome: InvocationOutcome | undefined

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
  library = []
  invokeOutcome = undefined
  queryRefusal = undefined
  invokeDispatched = false
  receiptRefusal = undefined
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
    const problem = (status: number, detail: string) =>
      new Response(
        JSON.stringify({
          type: 'about:blank',
          title: 'Refused',
          status,
          code: 'store_unavailable',
          detail,
        }),
        { status, headers: { 'content-type': 'application/problem+json' } },
      )
    if (url.pathname === '/api/chat/v1/bootstrap')
      return json({ schema: 'theorem.chat.bootstrap.v1', csrfToken: 'csrf' })
    const rest = url.pathname.slice(CAPABILITIES.length + 1).split('/')
    const tail = rest[2]
    if (rest[0] === 'library') {
      if (rest.at(-1) === 'instantiate')
        return json(
          {
            definitionId: 'capdef:fresh',
            instance: {
              instanceId: body?.instanceId,
              definitionId: 'capdef:fresh',
            },
          },
          201,
        )
      return json({ templates: library })
    }
    if (rest.length === 1) return json({ instances: [] })
    if (rest.length === 2) return json(described)
    if (tail === 'query') {
      if (queryRefusal) return problem(503, queryRefusal)
      const asked = body as unknown as QueryRequest
      const answer = answers[asked.viewKey ?? ''] ?? {
        rows: [],
        filtered: false,
        total: 0,
      }
      const later = asked.cursor !== undefined
      return json(
        queryResult(later ? (answer.next ?? []) : answer.rows, {
          filtered: answer.filtered,
          total: answer.total,
          truncated: answer.truncated ?? false,
          definitionId: pinned,
          ...(answer.next && !later ? { nextCursor: 'page-2' } : {}),
        }),
      )
    }
    if (tail === 'invocations') {
      if (receiptRefusal) return problem(404, receiptRefusal)
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
          affected: [{ id: 'rec-1', revision: 7 }],
          fields: { status: 'done' },
        },
        finishedAtMs: 2,
      })
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
      if (invokeDispatched)
        return json({
          recordId: 'capop:abc',
          invocationKey: body?.invocationKey,
          instanceId: 'tracker/main',
          actionKey: body?.actionKey,
          definitionId: 'capdef:abc',
          requestDigest: 'sha256:abc',
          startedAtMs: 1,
          status: 'dispatched',
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
        outcome: invokeOutcome ?? {
          outcome: 'completed',
          // Several targets move together, each one revision on.
          affected: Array.isArray(body?.targets)
            ? (body.targets as InvokeTarget[]).map((target) => ({
                id: target.recordId,
                revision: (target.expectedRevision ?? 0) + 1,
              }))
            : [{ id: body?.recordId ?? 'rec-new', revision: 7 }],
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
    inputs: { title: 'Ship the slice' },
  })
  // A blank optional input is absent, not null: null is refused by the executor.
  expect(Object.hasOwn(invoked.body!.inputs as object, 'due_at')).toBe(false)
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
  await act(async () => button(screen(), 'Customize')?.click())
  await waitFor(() => screen().textContent.includes('Author Project tracker'))
}

/** One of the dialog's sections, by the words its switch shows. */
async function section(name: string) {
  await act(async () => button(screen(), name)?.click())
}

/** A dialog control by its accessible name, of any element kind. */
const named = <T extends Element = HTMLElement>(label: string) =>
  document.querySelector<T>(`[aria-label="${label}"]`)

async function press(label: string) {
  await act(async () => named<HTMLElement>(label)?.click())
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
  expect(button(screen(), 'Views')).toBeTruthy()

  const readonly = await showTable(
    { instanceId: 'tracker/main', viewKey: '' },
    readerGrant,
  )
  await waitFor(() => readonly.container.textContent.includes('Write the plan'))
  expect(button(readonly.container, 'Customize')).toBeUndefined()
})

test('adding an optional field patches the version describe answered with', async () => {
  // A query page names another version: the patch still names describe's,
  // the one the definition on screen came from.
  pinned = 'capdef:rows-elsewhere'
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

// ── Views: add, edit and remove, with the whole filter tree ──────────────────

const authored = () => sentTo('/author').map((call) => call.body)

test('a view saved untouched is sent back exactly as it was read', async () => {
  const { container } = await showTable()
  await waitFor(() => container.textContent.includes('Write the plan'))
  await authoring()
  await section('Views')
  // The editor opens on the view the module shows.
  await waitFor(() => dialogSelect('View to edit')?.value === 'next')
  expect(dialogInput('View label')?.value).toBe('Next')
  expect(dialogSelect('Field of condition 1')?.value).toBe('status')
  expect(dialogInput('Value of condition 1')?.value).toBe('next')
  await act(async () => button(screen(), 'Save view')?.click())
  await waitFor(() => authored().length === 1)
  expect(authored()[0]).toEqual({
    expectedDefinitionId: 'capdef:abc',
    ops: [{ op: 'replace_view', view: described.definition.views[0] }],
  })
  await waitFor(() =>
    screen().textContent.includes(
      'View saved · the definition is now capdef:def',
    ),
  )
})

test('a view’s label, layout, sort, display fields and filter are edited together', async () => {
  const { container } = await showTable()
  await waitFor(() => container.textContent.includes('Write the plan'))
  await authoring()
  await section('Views')
  await waitFor(() => dialogInput('View label'))
  fill(dialogInput('View label')!, 'Up next')
  await act(async () => button(screen(), 'Table')?.click())
  await act(async () => button(screen(), 'Descending')?.click())
  // Choose the columns: start from every field, then leave Due out.
  await press('Show every field')
  await waitFor(() => named('Show Due'))
  await press('Show Due')
  // Beside the lone condition: an any-of group of it and a new one.
  await press('Add condition')
  fill(dialogSelect('Field of condition 2')!, 'title')
  fill(dialogSelect('Operator of condition 2')!, 'contains')
  fill(dialogInput('Value of condition 2')!, 'plan')
  fill(dialogSelect('Match for group 1')!, 'or')
  await press('Negate condition 1')
  await act(async () => button(screen(), 'Save view')?.click())
  await waitFor(() => authored().length === 1)
  expect(authored()[0]).toEqual({
    expectedDefinitionId: 'capdef:abc',
    ops: [
      {
        op: 'replace_view',
        view: {
          key: 'next',
          label: 'Up next',
          collectionKey: 'tasks',
          layout: 'table',
          orderBy: { fieldKey: 'due_at', direction: 'desc' },
          displayFields: [
            'title',
            'status',
            'effort_minutes',
            'assignee',
            'completed_at',
          ],
          filter: {
            op: 'or',
            conditions: [
              {
                op: 'not',
                condition: { op: 'eq', fieldKey: 'status', value: 'next' },
              },
              { op: 'contains', fieldKey: 'title', value: 'plan' },
            ],
          },
        },
      },
    ],
  })
})

test('an or and not filter is shown whole, and an edit changes only the condition it names', async () => {
  const nested = describeResult()
  const status: QueryFilter = { op: 'eq', fieldKey: 'status', value: 'next' }
  const quick: QueryFilter = {
    op: 'contains',
    fieldKey: 'title',
    value: 'quick',
  }
  const dated: QueryFilter = {
    op: 'not',
    condition: { op: 'is_empty', fieldKey: 'due_at' },
  }
  const tree: QueryFilter = {
    op: 'and',
    conditions: [
      status,
      {
        op: 'or',
        conditions: [
          quick,
          dated,
          { op: 'gte', fieldKey: 'effort_minutes', value: 30 },
        ],
      },
    ],
  }
  nested.definition = {
    ...nested.definition,
    views: [{ ...nested.definition.views[0]!, filter: tree }],
  }
  described = nested
  const { container } = await showTable()
  await waitFor(() => container.textContent.includes('Write the plan'))
  await authoring()
  await section('Views')
  await waitFor(() => dialogSelect('Match for group 2'))
  // Every condition is on screen, the negated one inside its negation.
  expect(dialogSelect('Match for group 1')?.value).toBe('and')
  expect(dialogSelect('Match for group 2')?.value).toBe('or')
  expect(named('Remove negation 1')).toBeTruthy()
  expect(dialogSelect('Operator of condition 3')?.value).toBe('is_empty')
  expect(dialogInput('Value of condition 4')?.value).toBe('30')
  // An integer comparison goes back as a number.
  fill(dialogInput('Value of condition 4')!, '45')
  await act(async () => button(screen(), 'Save view')?.click())
  await waitFor(() => authored().length === 1)
  const sent = authored()[0] as { ops: [{ view: { filter: unknown } }] }
  expect(sent.ops[0].view.filter).toEqual({
    op: 'and',
    conditions: [
      status,
      {
        op: 'or',
        conditions: [
          quick,
          dated,
          { op: 'gte', fieldKey: 'effort_minutes', value: 45 },
        ],
      },
    ],
  })
})

test('a new view names its key and collection, and a key already taken is refused before sending', async () => {
  const { container } = await showTable()
  await waitFor(() => container.textContent.includes('Write the plan'))
  await authoring()
  await section('Views')
  await waitFor(() => dialogSelect('View to edit'))
  fill(dialogSelect('View to edit')!, '')
  await waitFor(() => dialogInput('View key'))
  fill(dialogInput('View key')!, 'next')
  fill(dialogInput('View label')!, 'This week')
  expect(screen().textContent).toContain('a key no other view has')
  expect(button(screen(), 'Add view')?.disabled).toBe(true)
  fill(dialogInput('View key')!, 'this_week')
  await act(async () => button(screen(), 'Board')?.click())
  await press('Add condition to group 1')
  fill(dialogSelect('Field of condition 1')!, 'due_at')
  fill(dialogSelect('Operator of condition 1')!, 'lte')
  fill(dialogInput('Value of condition 1')!, '2026-11-30')
  await act(async () => button(screen(), 'Add view')?.click())
  await waitFor(() => authored().length === 1)
  expect(authored()[0]).toEqual({
    expectedDefinitionId: 'capdef:abc',
    ops: [
      {
        op: 'add_view',
        view: {
          key: 'this_week',
          label: 'This week',
          collectionKey: 'tasks',
          layout: 'board',
          filter: {
            op: 'and',
            conditions: [
              { op: 'lte', fieldKey: 'due_at', value: '2026-11-30' },
            ],
          },
        },
      },
    ],
  })
  await waitFor(() => screen().textContent.includes('View added'))
})

test('a new view’s collection takes the filter, sort and columns that named the old one’s fields with it', async () => {
  const { container } = await showTable()
  await waitFor(() => container.textContent.includes('Write the plan'))
  await authoring()
  await section('Views')
  await waitFor(() => dialogSelect('View to edit'))
  fill(dialogSelect('View to edit')!, '')
  await waitFor(() => dialogInput('View key'))
  fill(dialogInput('View key')!, 'by_name')
  fill(dialogInput('View label')!, 'By name')
  // A sort starts ascending; the direction is offered only once there is one.
  expect(button(screen(), 'Descending')).toBeUndefined()
  fill(dialogSelect('Sort by')!, 'due_at')
  expect(button(screen(), 'Ascending')?.getAttribute('aria-pressed')).toBe(
    'true',
  )
  await act(async () => button(screen(), 'Descending')?.click())
  await press('Show every field')
  await press('Add condition to group 1')
  expect(dialogSelect('Field of condition 1')).toBeTruthy()
  fill(dialogSelect('View collection')!, 'people')
  expect(dialogSelect('Sort by')?.value).toBe('')
  expect(button(screen(), 'Descending')).toBeUndefined()
  expect(named('Show every field')?.getAttribute('aria-checked')).toBe('true')
  expect(dialogSelect('Field of condition 1')).toBeNull()
  // The new collection's own field, ascending again; then no sort at all.
  fill(dialogSelect('Sort by')!, 'name')
  expect(button(screen(), 'Ascending')?.getAttribute('aria-pressed')).toBe(
    'true',
  )
  fill(dialogSelect('Sort by')!, '')
  expect(button(screen(), 'Ascending')).toBeUndefined()
  fill(dialogSelect('Sort by')!, 'name')
  await act(async () => button(screen(), 'Add view')?.click())
  await waitFor(() => authored().length === 1)
  expect(authored()[0]).toEqual({
    expectedDefinitionId: 'capdef:abc',
    ops: [
      {
        op: 'add_view',
        view: {
          key: 'by_name',
          label: 'By name',
          collectionKey: 'people',
          layout: 'list',
          orderBy: { fieldKey: 'name', direction: 'asc' },
          filter: { op: 'and', conditions: [] },
        },
      },
    ],
  })
})

test('a saved view with its sort cleared is sent with no sort, and keeping a view sends nothing', async () => {
  const { container } = await showTable()
  await waitFor(() => container.textContent.includes('Write the plan'))
  await authoring()
  await section('Views')
  await waitFor(() => dialogSelect('Sort by')?.value === 'due_at')
  await act(async () => button(screen(), 'Remove view')?.click())
  await act(async () => button(screen(), 'Keep it')?.click())
  expect(named('Confirm remove view')).toBeNull()
  expect(button(screen(), 'Remove view')).toBeTruthy()
  fill(dialogSelect('Sort by')!, '')
  await act(async () => button(screen(), 'Save view')?.click())
  await waitFor(() => authored().length === 1)
  const { orderBy, ...unsorted } = described.definition.views[0]!
  expect(orderBy).toBeTruthy()
  expect(authored()[0]).toEqual({
    expectedDefinitionId: 'capdef:abc',
    ops: [{ op: 'replace_view', view: unsorted }],
  })
})

/** The view editor, opened on the view the module shows (Next: status is next). */
async function viewEditor() {
  const { container } = await showTable()
  await waitFor(() => container.textContent.includes('Write the plan'))
  await authoring()
  await section('Views')
  await waitFor(() => dialogInput('View label'))
}

test('an any-of group with no condition is named and holds Save until it has one', async () => {
  await viewEditor()
  // Beside the lone condition: an and of it and a new, empty any-of group.
  await press('Add group')
  expect(dialogSelect('Match for group 2')?.value).toBe('or')
  expect(screen().textContent).toContain(
    'Still to do: group 2 has no condition to match any of.',
  )
  expect(button(screen(), 'Save view')?.disabled).toBe(true)
  // An empty all-of group is every record, which the server takes.
  fill(dialogSelect('Match for group 2')!, 'and')
  expect(screen().textContent).not.toContain('Still to do')
  expect(button(screen(), 'Save view')?.disabled).toBe(false)
  fill(dialogSelect('Match for group 2')!, 'or')
  expect(button(screen(), 'Save view')?.disabled).toBe(true)
  await press('Add condition to group 2')
  fill(dialogSelect('Field of condition 2')!, 'title')
  fill(dialogSelect('Operator of condition 2')!, 'contains')
  fill(dialogInput('Value of condition 2')!, 'plan')
  expect(screen().textContent).not.toContain('Still to do')
  await act(async () => button(screen(), 'Save view')?.click())
  await waitFor(() => authored().length === 1)
  const sent = authored()[0] as { ops: [{ view: { filter: unknown } }] }
  expect(sent.ops[0].view.filter).toEqual({
    op: 'and',
    conditions: [
      { op: 'eq', fieldKey: 'status', value: 'next' },
      {
        op: 'or',
        conditions: [{ op: 'contains', fieldKey: 'title', value: 'plan' }],
      },
    ],
  })
})

test('an any-of match over no condition at the top does not say the view shows every record', async () => {
  await viewEditor()
  fill(dialogSelect('View to edit')!, 'all')
  await waitFor(() => dialogSelect('Match for group 1')?.value === 'and')
  expect(screen().textContent).toContain(
    'No conditions: the view shows every record.',
  )
  expect(button(screen(), 'Save view')?.disabled).toBe(false)
  fill(dialogSelect('Match for group 1')!, 'or')
  expect(screen().textContent).not.toContain('the view shows every record')
  expect(screen().textContent).toContain(
    'Still to do: group 1 has no condition to match any of.',
  )
  expect(button(screen(), 'Save view')?.disabled).toBe(true)
  expect(authored().length).toBe(0)
})

test('an is-one-of condition with no value is named, and one with a value is sent', async () => {
  await viewEditor()
  fill(dialogSelect('Operator of condition 1')!, 'in')
  fill(dialogInput('Value of condition 1')!, ' , ,')
  expect(screen().textContent).toContain(
    'Still to do: condition 1 names no value to be one of.',
  )
  expect(button(screen(), 'Save view')?.disabled).toBe(true)
  fill(dialogInput('Value of condition 1')!, '')
  expect(button(screen(), 'Save view')?.disabled).toBe(true)
  fill(dialogInput('Value of condition 1')!, 'next, waiting,')
  expect(screen().textContent).not.toContain('Still to do')
  await act(async () => button(screen(), 'Save view')?.click())
  await waitFor(() => authored().length === 1)
  const sent = authored()[0] as { ops: [{ view: { filter: unknown } }] }
  expect(sent.ops[0].view.filter).toEqual({
    op: 'in',
    fieldKey: 'status',
    values: ['next', 'waiting'],
  })
})

test('a view with every column unticked is named and never sent with an empty column list', async () => {
  await viewEditor()
  await press('Show every field')
  for (const label of [
    'Title',
    'Status',
    'Due',
    'Effort (minutes)',
    'Assignee',
    'Completed',
  ])
    await press(`Show ${label}`)
  expect(screen().textContent).toContain('Still to do: a column to show.')
  expect(button(screen(), 'Save view')?.disabled).toBe(true)
  await act(async () => button(screen(), 'Save view')?.click())
  expect(authored().length).toBe(0)
  await press('Show Due')
  expect(screen().textContent).not.toContain('Still to do')
  await act(async () => button(screen(), 'Save view')?.click())
  await waitFor(() => authored().length === 1)
  const sent = authored()[0] as {
    ops: [{ view: { displayFields?: string[] } }]
  }
  expect(sent.ops[0].view.displayFields).toEqual(['due_at'])
})

test('removing a view asks first and says records are not changed', async () => {
  const { container } = await showTable()
  await waitFor(() => container.textContent.includes('Write the plan'))
  await authoring()
  await section('Views')
  await waitFor(() => dialogSelect('View to edit'))
  fill(dialogSelect('View to edit')!, 'all')
  await act(async () => button(screen(), 'Remove view')?.click())
  expect(screen().textContent).toContain('Records are not changed')
  expect(authored().length).toBe(0)
  await press('Confirm remove view')
  await waitFor(() => authored().length === 1)
  expect(authored()[0]).toEqual({
    expectedDefinitionId: 'capdef:abc',
    ops: [{ op: 'remove_view', viewKey: 'all' }],
  })
})

test('a stale definition base is refused, the current one is read back, and the retry is the person’s', async () => {
  // Describe answered under one version; the instance is pinned to another.
  described = { ...describeResult(), definitionId: 'capdef:older' }
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

// Saving replaces the whole grant list, so a list refused as stale and sent
// again as it was would drop a grant changed elsewhere meanwhile.
test('a grant list refused as stale is shown as read again, with the person’s change still laid over it', async () => {
  const sam: Grant = {
    principal: 'user:sam',
    read: true,
    invoke: [],
    author: false,
  }
  described = {
    ...describeResult(),
    definitionId: 'capdef:older',
    grants: [ownerGrant, sam],
  }
  const { container } = await showTable()
  await waitFor(() => container.textContent.includes('Write the plan'))
  await authoring()
  await section('Agent access')
  await waitFor(() => dialogInput('Principal 2'))
  // The person lets Sam author and adds a helper.
  await press('Grant 2 authors')
  await act(async () => button(screen(), 'Add grant')?.click())
  fill(dialogInput('Principal 3')!, 'agent:helper')
  // Meanwhile Sam was let complete tasks, and Ops let read, elsewhere.
  const ops: Grant = {
    principal: 'user:ops',
    read: true,
    invoke: [],
    author: false,
  }
  described = {
    ...describeResult(),
    grants: [ownerGrant, { ...sam, invoke: ['complete'] }, ops],
  }
  const before = reads().length
  await act(async () => button(screen(), 'Save grants')?.click())
  await waitFor(() => screen().textContent.includes('submit it once more'))
  await waitFor(() => reads().length > before)
  await settle()
  const principals = () =>
    [
      ...document.querySelectorAll<HTMLInputElement>(
        'input[aria-label^="Principal "]',
      ),
    ].map((one) => one.value)
  expect(principals()).toEqual([
    'user:travis',
    'user:sam',
    'user:ops',
    'agent:helper',
  ])
  // Sam's grant is as read again, with the person's tick over it.
  expect(named('Grant 2 invokes complete')?.getAttribute('aria-checked')).toBe(
    'true',
  )
  expect(named('Grant 2 authors')?.getAttribute('aria-checked')).toBe('true')

  // Sent again, the list keeps both changes, over the definition read again.
  const sent = [
    ownerGrant,
    { ...sam, invoke: ['complete'], author: true },
    ops,
    { principal: 'agent:helper', read: true, invoke: [], author: false },
  ]
  described = { ...describeResult(), definitionId: 'capdef:def', grants: sent }
  await act(async () => button(screen(), 'Save grants')?.click())
  await waitFor(() => screen().textContent.includes('Grants saved'))
  expect(authored().at(-1)).toEqual({
    expectedDefinitionId: 'capdef:abc',
    ops: [{ op: 'set_grants', grants: sent }],
  })
  // Read again once saved, the list is the one sent, each grant once.
  await waitFor(() =>
    screen().textContent.includes('the definition is now capdef:def'),
  )
  await settle()
  expect(principals()).toEqual([
    'user:travis',
    'user:sam',
    'user:ops',
    'agent:helper',
  ])
})

// ── Agent access from the table ─────────────────────────────────────────────

test('use in this conversation puts the view in the composer, with or without a selection', async () => {
  useComposerReferences.setState({ references: [] })
  const { container } = await showTable()
  await waitFor(() => container.textContent.includes('Write the plan'))
  await authoring()
  await section('Agent access')
  await act(async () => button(screen(), 'Use in this conversation')?.click())
  const [reference] = await waitFor(() => {
    const held = useComposerReferences.getState().references
    return held.length ? held : undefined
  })
  expect(reference?.label).toBe('Project tracker · Next')
  expect((reference as CapabilityContextReference).location.resource).toEqual({
    kind: 'capability',
    instanceId: 'tracker/main',
    collectionKey: 'tasks',
    viewKey: 'next',
    purpose: 'Track personal projects and tasks',
    selected: [],
    // The component the view is placed in, so a page patch can name it.
    selectedComponentId: 'table-1',
    filtered: true,
    truncated: false,
  })
  // The dialog steps aside for the composer, and nothing was authored.
  await waitFor(() => !screen().textContent.includes('Author Project tracker'))
  expect(sentTo('/author').length).toBe(0)
  useComposerReferences.setState({ references: [] })
})

// ── Templates from a module that names no instance ──────────────────────────

test('a module that names no instance offers a new one from a template', async () => {
  library = [
    {
      templateId: 'captpl:reading',
      name: 'Reading list',
      description: 'Books to read',
      definition: describeResult().definition,
      declareTypes: [],
      requirements: { modules: [] },
      savedBy: 'user:travis',
      savedAtMs: 1,
    },
  ]
  const { container } = await showTable({ instanceId: '', viewKey: '' })
  await waitFor(() => container.textContent.includes('New from template'))
  const id = container.querySelector<HTMLInputElement>(
    'input[aria-label="New instance id"]',
  )!
  type(id, 'reading/home')
  await act(async () => button(container, 'Create instance')?.click())
  const made = await waitFor(() => sentTo('/instantiate')[0])
  expect(made.body).toEqual({ instanceId: 'reading/home' })
  // Outside a page that can take the setting, it says where to name it.
  await waitFor(() =>
    container.textContent.includes(
      "Name it in a capability module's Instance setting to open it.",
    ),
  )
})

// ── Bulk: one update action over the selected records, all or nothing ──────

/** The bar a selection of two or more records brings up. */
const bulkBar = (container: HTMLElement) =>
  container.querySelector<HTMLElement>(
    '[role="toolbar"][aria-label="Selected records"]',
  )

/** Tick the row checkboxes at these places, in order. */
async function tick(container: HTMLElement, ...at: number[]) {
  const boxes = container.querySelectorAll<HTMLElement>(
    '[data-slot="checkbox"]',
  )
  for (const one of at) await act(async () => boxes[one]!.click())
}

test('two selected records run one update action over both, at the revisions shown', async () => {
  const { container } = await showTable()
  await waitFor(() => container.textContent.includes('Write the plan'))
  await tick(container, 0)
  // One record is a row's own business; the bar is for several.
  expect(bulkBar(container)).toBeNull()
  await tick(container, 1)
  const bar = await waitFor(() => bulkBar(container))
  expect(bar.textContent).toContain('2 selected')
  expect(bar.textContent).toContain('all or nothing')
  // Every update action the grant reaches; the create action is not one.
  expect(byLabel(bar, 'Complete the 2 selected')).toBeTruthy()
  expect(byLabel(bar, 'Edit the 2 selected')).toBeTruthy()
  expect(byLabel(bar, 'Add task the 2 selected')).toBeNull()

  await act(async () => byLabel(bar, 'Complete the 2 selected')?.click())
  const invoked = await waitFor(() => sentTo('/invoke')[0])
  expect(invoked.body).toEqual({
    instanceId: 'tracker/main',
    actionKey: 'complete',
    invocationKey: expect.any(String),
    inputs: {},
    targets: [
      { recordId: 'rec-1', expectedRevision: 6 },
      { recordId: 'rec-2', expectedRevision: 3 },
    ],
  })
  expect(sentTo('/invoke').length).toBe(1)
  await waitFor(() =>
    container.textContent.includes('complete saved on 2 records · r7, r4.'),
  )
})

test('the bar leaves out a module-backed action, which runs on one record at a time', async () => {
  // Its module answers for one record and the targets commit one shared
  // patch, so the server refuses it over several targets.
  const base = describeResult()
  described = {
    ...base,
    definition: {
      ...base.definition,
      actions: base.definition.actions.map((action) =>
        action.key === 'complete'
          ? {
              ...action,
              implementation: {
                moduleId: 'capmod:done',
                export: 'effects',
                writes: ['status'],
              },
            }
          : action,
      ),
    },
  }
  const { container } = await showTable()
  await waitFor(() => container.textContent.includes('Write the plan'))
  await tick(container, 0, 1)
  const bar = await waitFor(() => bulkBar(container))
  expect(byLabel(bar, 'Complete the 2 selected')).toBeNull()
  expect(byLabel(bar, 'Edit the 2 selected')).toBeTruthy()
})

test('the bar offers only the actions the grant reaches', async () => {
  const { container } = await showTable(undefined, {
    principal: 'user:sam',
    read: true,
    invoke: ['complete'],
    author: false,
  })
  await waitFor(() => container.textContent.includes('Write the plan'))
  await tick(container, 0, 1)
  const bar = await waitFor(() => bulkBar(container))
  expect(byLabel(bar, 'Complete the 2 selected')).toBeTruthy()
  expect(byLabel(bar, 'Edit the 2 selected')).toBeNull()
  expect(byLabel(bar, 'Assign the 2 selected')).toBeNull()
})

test('one refusing record fails the whole call, and the bar says which and that nothing changed', async () => {
  invokeOutcome = {
    outcome: 'failed',
    code: codes.PRECONDITION_FAILED,
    message: 'rec-2: status is not one of next, in_progress, waiting',
  }
  const { container } = await showTable()
  await waitFor(() => container.textContent.includes('Write the plan'))
  await tick(container, 0, 1)
  const bar = await waitFor(() => bulkBar(container))
  await act(async () => byLabel(bar, 'Complete the 2 selected')?.click())
  await waitFor(() =>
    container.textContent.includes(
      'No record was changed. capability_precondition_failed: rec-2: status is not one of next, in_progress, waiting',
    ),
  )
  expect(container.textContent).not.toContain('saved · r')
})

test('an action with inputs asks once, and the same values go to every selected record', async () => {
  const { container } = await showTable()
  await waitFor(() => container.textContent.includes('Write the plan'))
  await tick(container, 0, 1)
  const bar = await waitFor(() => bulkBar(container))
  await act(async () => byLabel(bar, 'Edit the 2 selected')?.click())
  await waitFor(() =>
    screen().textContent.includes(
      'The same values go to every selected record',
    ),
  )
  expect(screen().textContent).toContain(
    'a field left blank is left as it is on every record',
  )
  const status = screen().querySelector<HTMLInputElement>(
    'input[aria-label="status (optional)"]',
  )!
  type(status, 'waiting')
  await act(async () => button(screen(), 'Edit 2 records')?.click())
  const invoked = await waitFor(() => sentTo('/invoke')[0])
  expect(invoked.body?.targets).toEqual([
    { recordId: 'rec-1', expectedRevision: 6 },
    { recordId: 'rec-2', expectedRevision: 3 },
  ])
  // Only the filled input goes; the blank ones are absent, so no target's
  // title or effort changes and nothing null reaches the executor.
  expect(invoked.body?.inputs).toEqual({ status: 'waiting' })
  expect(Object.hasOwn(invoked.body!.inputs as object, 'title')).toBe(false)
  expect(Object.hasOwn(invoked.body!.inputs as object, 'effort_minutes')).toBe(
    false,
  )
  expect(invoked.body?.recordId).toBeUndefined()
})

test('a call the journal holds unfinished says so, and its receipt is read back on asking', async () => {
  invokeDispatched = true
  const { container } = await showTable()
  await waitFor(() => container.textContent.includes('Write the plan'))
  await act(async () => button(container, 'Complete')?.click())
  await waitFor(() =>
    container.textContent.includes(
      'complete is journaled and has not finished, so whether it took effect is not yet known.',
    ),
  )
  await act(async () => button(container, 'Check its receipt')?.click())
  await waitFor(() => container.textContent.includes('complete saved · r7.'))
  expect(sentTo('/invocations/capop%3Aabc').length).toBe(1)
})

test('a receipt that cannot be read back says why', async () => {
  invokeDispatched = true
  receiptRefusal = 'No such invocation.'
  const { container } = await showTable()
  await waitFor(() => container.textContent.includes('Write the plan'))
  await act(async () => button(container, 'Complete')?.click())
  await waitFor(() => button(container, 'Check its receipt'))
  await act(async () => button(container, 'Check its receipt')?.click())
  const alert = await waitFor(() => container.querySelector('[role="alert"]'))
  expect(alert.textContent).toContain('No such invocation.')
  expect(button(container, 'Check its receipt')).toBeUndefined()
})

test('a selection call the server refuses outright says why, and a reload reads the rows again', async () => {
  invokeRefusal = { status: 409, code: codes.REVISION_CONFLICT }
  const { container } = await showTable()
  await waitFor(() => container.textContent.includes('Write the plan'))
  await tick(container, 0, 1)
  const bar = await waitFor(() => bulkBar(container))
  await act(async () => byLabel(bar, 'Complete the 2 selected')?.click())
  const alert = await waitFor(() => container.querySelector('[role="alert"]'))
  expect(alert.textContent).toContain(
    'Complete changed this record while you were looking at it. Nothing was lost: reload it and try again.',
  )
  const before = sentTo('/query').length
  await act(async () => button(container, 'Reload')?.click())
  await waitFor(() => sentTo('/query').length > before)
  expect(container.querySelector('[role="alert"]')).toBeNull()
})

test('a view that cannot be read says why, and trying again reads it', async () => {
  queryRefusal = 'The store is not answering.'
  const { container } = await showTable()
  const alert = await waitFor(() => container.querySelector('[role="alert"]'))
  expect(alert.textContent).toContain('The store is not answering.')
  queryRefusal = undefined
  await act(async () => button(container, 'Try again')?.click())
  await waitFor(() => container.textContent.includes('Write the plan'))
})

test('a second page loads on asking, and an answer the page cut short says how much is shown', async () => {
  answers.next = {
    rows: taskRows.slice(0, 1),
    next: taskRows.slice(1),
    filtered: true,
    total: taskRows.length,
  }
  const { container } = await showTable()
  await waitFor(() => container.textContent.includes('Write the plan'))
  expect(container.textContent).not.toContain('Sketch the page')
  const more = `Load more (${taskRows.length} in all)`
  await act(async () => button(container, more)?.click())
  await waitFor(() => container.textContent.includes('Sketch the page'))
  expect(sentTo('/query').at(-1)!.body).toMatchObject({ cursor: 'page-2' })
  expect(button(container, more)).toBeUndefined()
  cleanup()

  answers.next = { rows: taskRows, filtered: true, total: 9, truncated: true }
  const cut = await showTable()
  await waitFor(() => cut.container.textContent.includes('Write the plan'))
  expect(cut.container.textContent).toContain(
    `The page cut the answer short: ${taskRows.length} of 9 rows are shown.`,
  )
})

test('a row action with inputs asks for them first, naming the record at the revision on screen', async () => {
  const { container } = await showTable()
  await waitFor(() => container.textContent.includes('Write the plan'))
  await act(async () => button(container, 'Edit')?.click())
  const dialog = await waitFor(() =>
    screen().querySelector<HTMLElement>('[role="dialog"]'),
  )
  expect(dialog.textContent).toContain('Write the plan · at revision 6')
  type(
    dialog.querySelector<HTMLInputElement>(
      'input[aria-label="status (optional)"]',
    )!,
    'waiting',
  )
  await act(async () => button(dialog, 'Edit')?.click())
  const invoked = await waitFor(() => sentTo('/invoke')[0])
  expect(invoked.body).toMatchObject({
    actionKey: 'update',
    recordId: 'rec-1',
    expectedRevision: 6,
    inputs: { status: 'waiting' },
  })
  await waitFor(() => !screen().querySelector('[role="dialog"]'))
  expect(container.textContent).toContain('update saved · r7.')
})
