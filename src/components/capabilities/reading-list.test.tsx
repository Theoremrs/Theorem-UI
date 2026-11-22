// SOURCING: bun:test over the same capability table and record modules, and the same authoring
// dialog, that the tracker tests drive; the plan's second application (fixtures/reading-list.json,
// copied byte for byte beside this file) is the only input. Rendered with test/workspace's render
// into happy-dom, window.fetch standing in for a Theorem that serves /api/capabilities/v1, as
// capability-table.test.tsx stands one in. The Phase 4 additions (an extra lifecycle variant and a
// module-backed action) are authored data here, never code. The last test reads the UI's own
// sources to show no module knows the reading list by name.
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { act } from 'react'
import { cleanup, render, waitFor } from '../../../test/workspace'
import { CapabilityTableModule } from './capability-table'
import { CapabilityRecordModule } from './capability-record'
import { PageRuntimeProvider } from '../pages/page-runtime'
import { CAPABILITIES } from '@/lib/capabilities/api'
import { codes } from '@/lib/capabilities/contract'
import type {
  ActionSpec,
  CapabilityDefinition,
  CapabilityRecordRow,
  CollectionLifecycle,
  CollectionSchema,
  DescribeResult,
  ResolvedFieldType,
  QueryRequest,
} from '@/lib/capabilities/contract'
import { ownerGrant, row } from './fixture'
import fixture from './reading-list.fixture.json'
import type { ModuleViewProps } from '@/lib/modules/registry'

const page = (
  window as unknown as { happyDOM: { setURL: (url: string) => void } }
).happyDOM
page.setURL('http://localhost:3000/pages/Desk')

const realFetch = window.fetch

// ── The reading list, as the plan's fixture declares it ─────────────────────

/** The fixture with its tenant placeholder filled, as the server binds it. */
const reading = JSON.parse(
  JSON.stringify(fixture).replaceAll('{{tenant}}', 'tenant-a'),
) as typeof fixture
const INSTANCE = reading.instanceId
const declared = reading.declareTypes[0]!
const definition = reading.definition as unknown as CapabilityDefinition
const books = definition.collections[0]!
const STATUS = declared.fields.find((field) => field.key === 'status')!
  .field_type.variants!

/** The resolved schema describe answers for the books collection. */
const booksSchema = (variants: string[] = STATUS): CollectionSchema => ({
  collectionKey: books.key,
  objectTypeId: books.objectTypeId,
  label: declared.label_plural,
  fields: declared.fields.map((field) => ({
    key: field.key,
    label: field.label,
    fieldType: (field.key === 'status'
      ? { kind: 'enum', variants }
      : field.field_type) as ResolvedFieldType,
    required: field.required,
  })),
})

const described = (
  definitionId: string,
  over: CapabilityDefinition = definition,
  variants?: string[],
): DescribeResult => ({
  definitionId,
  definition: over,
  callerGrant: ownerGrant,
  collectionSchemas: [booksSchema(variants)],
  grants: [ownerGrant],
})

// ── Phase 4, authored: an extra lifecycle variant and a module-backed action ──

const PAUSED = [...STATUS, 'paused']
const pausedLifecycle: CollectionLifecycle = {
  ...books.lifecycle!,
  transitions: [
    ...books.lifecycle!.transitions,
    { from: ['reading'], to: 'paused' },
    { from: ['paused'], to: 'reading' },
  ],
}
const MODULE = 'capmod:7d1f0c2a9b'
/**
 * An action whose effects a registered module computes. `implementation` is
 * not part of this UI's ActionSpec: the modules must show and run it without
 * knowing it is there, which is the point.
 */
const pauseBook = {
  key: 'pause_book',
  label: 'Pause',
  collectionKey: books.key,
  creates: false,
  input: [],
  preconditions: [{ op: 'eq', fieldKey: 'status', value: 'reading' }],
  effects: [],
  implementation: { moduleId: MODULE, export: 'pause', writes: ['status'] },
} as ActionSpec
const phase4: CapabilityDefinition = {
  ...definition,
  collections: [{ ...books, lifecycle: pausedLifecycle }],
  actions: [...definition.actions, pauseBook],
}

const bookRows = {
  reading: [
    row(
      'book-1',
      { title: 'Piranesi', author: 'Susanna Clarke', status: 'reading' },
      4,
    ),
  ],
  queued: [
    row('book-2', { title: 'The Left Hand of Darkness', status: 'queued' }, 2),
  ],
  finished: [
    row(
      'book-3',
      {
        title: 'The Dispossessed',
        author: 'Ursula K. Le Guin',
        status: 'finished',
        rating: 5,
        finished_at: '2026-11-02T18:00:00Z',
      },
      7,
    ),
  ],
} satisfies Record<string, CapabilityRecordRow[]>
const allBooks = Object.values(bookRows).flat()

// ── A Theorem that serves the reading list ──────────────────────────────────

type Call = { method: string; path: string; body?: Record<string, unknown> }
let calls: Call[]
/** What describe answers now. */
let describing: DescribeResult
/** What describe answers after each accepted patch, in order. */
let afterAuthor: DescribeResult[]
let library: unknown[]

beforeEach(() => {
  calls = []
  describing = described('capdef:reading-4', phase4, PAUSED)
  afterAuthor = []
  library = []
  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : undefined
    const url = new URL(request ? request.url : String(input))
    const method = init?.method ?? (request ? request.method : 'GET')
    const raw =
      init?.body ?? (request ? await request.clone().text() : undefined)
    const body = raw
      ? (JSON.parse(String(raw)) as Record<string, unknown>)
      : undefined
    calls.push({ method, path: url.pathname, body })
    const json = (value: unknown, status = 200) =>
      new Response(JSON.stringify(value), {
        status,
        headers: {
          'content-type':
            status >= 400 ? 'application/problem+json' : 'application/json',
        },
      })
    if (url.pathname === '/api/chat/v1/bootstrap')
      return json({ schema: 'theorem.chat.bootstrap.v1', csrfToken: 'csrf' })
    const rest = url.pathname.slice(CAPABILITIES.length + 1).split('/')
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
      if (method === 'POST') {
        const saved = {
          templateId: 'captpl:reading',
          name: body?.name,
          description: body?.description,
          definition: describing.definition,
          declareTypes: reading.declareTypes,
          requirements: { modules: ['theorem.capability.table'] },
          savedBy: ownerGrant.principal,
          savedAtMs: 1,
        }
        library = [saved]
        return json(saved, 201)
      }
      return json({ templates: library })
    }
    if (rest.length === 1) return json({ instances: [] })
    if (rest.length === 2) return json(describing)
    const tail = rest[2]
    if (tail === 'query') {
      const asked = body as unknown as QueryRequest
      const rows = asked.viewKey
        ? (bookRows[asked.viewKey as keyof typeof bookRows] ?? [])
        : allBooks
      return json({
        records: rows,
        total: rows.length,
        filtered: !!asked.viewKey,
        truncated: false,
        definitionId: describing.definitionId,
      })
    }
    if (tail === 'records') {
      const found = allBooks.find(
        (one) => one.id === decodeURIComponent(rest[3] ?? ''),
      )
      return found
        ? json(found)
        : json({ status: 404, code: codes.RECORD_NOT_FOUND }, 404)
    }
    if (tail === 'invoke')
      return json({
        recordId: 'capop:reading',
        invocationKey: body?.invocationKey,
        instanceId: INSTANCE,
        actionKey: body?.actionKey,
        definitionId: describing.definitionId,
        requestDigest: 'sha256:reading',
        startedAtMs: 1,
        status: 'finished',
        outcome: {
          outcome: 'completed',
          affected: [
            {
              id: body?.recordId ?? 'book-new',
              revision: Number(body?.expectedRevision ?? 0) + 1,
            },
          ],
          fields: {},
        },
        finishedAtMs: 2,
      })
    if (tail === 'author') {
      if (body?.expectedDefinitionId !== describing.definitionId)
        return json(
          {
            type: 'about:blank',
            title: 'Refused',
            status: 409,
            code: codes.DEFINITION_CONFLICT,
          },
          409,
        )
      describing = afterAuthor.shift() ?? describing
      return json({
        definitionId: describing.definitionId,
        instance: {
          instanceId: INSTANCE,
          definitionId: describing.definitionId,
        },
      })
    }
    return json({ status: 404 }, 404)
  }) as typeof fetch
})

afterEach(() => {
  window.fetch = realFetch
  cleanup()
})

// ── Helpers, the same reads the tracker tests make ──────────────────────────

const screen = () => document.body

const button = (container: ParentNode, name: string) =>
  [...container.querySelectorAll('button')].find(
    (one) => one.textContent.trim() === name,
  )

const named = <T extends Element = HTMLElement>(label: string) =>
  document.querySelector<T>(`[aria-label="${label}"]`)

async function click(target: Element | null | undefined) {
  expect(target).toBeTruthy()
  await act(async () => (target as HTMLElement).click())
}

function fill(label: string, value: string) {
  const field = named<HTMLInputElement | HTMLSelectElement>(label)
  expect(field).toBeTruthy()
  const proto =
    field instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : HTMLInputElement.prototype
  act(() => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(field, value)
    field!.dispatchEvent(
      new Event(field instanceof HTMLSelectElement ? 'change' : 'input', {
        bubbles: true,
      }),
    )
  })
}

const sentTo = (suffix: string) =>
  calls.filter((call) => call.path.endsWith(suffix))

function moduleView(settings: Record<string, unknown>): ModuleViewProps {
  return {
    instanceId: 'module-1',
    path: 'module-1',
    settings,
    inputs: {},
    output: () => {},
    emit: () => {},
    arranging: false,
  }
}

const showTable = (settings = { instanceId: INSTANCE, viewKey: '' }) =>
  render(
    <PageRuntimeProvider>
      <CapabilityTableModule {...moduleView(settings)} />
    </PageRuntimeProvider>,
  )

// ── The table module ────────────────────────────────────────────────────────

test('the reading list’s views, quick-add and actions come from its definition alone', async () => {
  const { container } = await showTable()
  await waitFor(() => container.textContent.includes('Piranesi'))
  // The first view is the one shown, as a list, read through the instance contract.
  expect(sentTo('/query')[0]!.body).toEqual({
    instanceId: INSTANCE,
    viewKey: 'reading',
    limit: 50,
  })
  expect(container.querySelector('ul[aria-label="Records"]')).toBeTruthy()
  expect(container.textContent).toContain('status is reading')
  for (const view of definition.views)
    expect(button(container, view.label)).toBeTruthy()
  expect(button(container, 'Add book')).toBeTruthy()
  // Every update action over books is offered on the row, the module-backed one too.
  for (const label of ['Start reading', 'Finish', 'Pause'])
    expect(button(container, label)).toBeTruthy()
  expect(container.textContent).not.toContain('The Left Hand of Darkness')
})

test('the module-backed action is invoked like any other: the same call, the same receipt', async () => {
  const { container } = await showTable()
  await waitFor(() => container.textContent.includes('Piranesi'))
  await click(button(container, 'Pause'))
  const paused = await waitFor(() => sentTo('/invoke')[0])
  expect(paused.body).toEqual({
    instanceId: INSTANCE,
    actionKey: 'pause_book',
    invocationKey: expect.any(String),
    recordId: 'book-1',
    expectedRevision: 4,
    inputs: {},
  })
  // Nothing about the module rides on the call: the server runs it.
  expect(JSON.stringify(paused.body)).not.toContain(MODULE)
  await waitFor(() => container.textContent.includes('pause_book saved · r5'))

  // A declared action with static effects goes out in exactly the same shape.
  await click(button(container, 'Start reading'))
  const started = await waitFor(() => sentTo('/invoke')[1])
  expect(Object.keys(started.body!).sort()).toEqual(
    Object.keys(paused.body!).sort(),
  )
  expect(started.body!.actionKey).toBe('start_book')
})

test('quick-add runs the reading list’s create action with its declared inputs', async () => {
  const { container } = await showTable()
  await waitFor(() => container.textContent.includes('Piranesi'))
  await click(button(container, 'Add book'))
  const title = await waitFor(() =>
    container.querySelector<HTMLInputElement>('input[aria-label="title"]'),
  )
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!.call(title, 'Kindred')
    title.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await click(button(container, 'Add book'))
  const added = await waitFor(() => sentTo('/invoke')[0])
  expect(added.body).toEqual({
    instanceId: INSTANCE,
    actionKey: 'add_book',
    invocationKey: expect.any(String),
    inputs: { title: 'Kindred' },
  })
})

test('the Finished view is the table its definition declares', async () => {
  const { container } = await showTable()
  await waitFor(() => container.textContent.includes('Piranesi'))
  await click(button(container, 'Finished'))
  await waitFor(() => container.textContent.includes('The Dispossessed'))
  expect(sentTo('/query').at(-1)!.body).toEqual({
    instanceId: INSTANCE,
    viewKey: 'finished',
    limit: 50,
  })
  const table = container.querySelector('table')
  expect(table).toBeTruthy()
  // Its columns are the declared type's fields, labelled as declared.
  const headers = [...table!.querySelectorAll('th')].map((th) =>
    th.textContent.trim(),
  )
  for (const field of declared.fields) expect(headers).toContain(field.label)
  expect(table!.textContent).toContain('Ursula K. Le Guin')
})

// ── The record module ───────────────────────────────────────────────────────

test('the record module shows one book and runs the module-backed action on it', async () => {
  const { container } = await render(
    <PageRuntimeProvider>
      <CapabilityRecordModule
        {...moduleView({ instanceId: INSTANCE, recordId: 'book-1' })}
      />
    </PageRuntimeProvider>,
  )
  await waitFor(() => container.textContent.includes('Piranesi'))
  expect(container.textContent).toContain('Susanna Clarke')
  expect(container.textContent).toContain('Books · r4')
  for (const label of ['Start reading', 'Finish', 'Pause'])
    expect(button(container, label)).toBeTruthy()
  await click(button(container, 'Pause'))
  const paused = await waitFor(() => sentTo('/invoke')[0])
  expect(paused.body).toMatchObject({
    instanceId: INSTANCE,
    actionKey: 'pause_book',
    recordId: 'book-1',
    expectedRevision: 4,
    inputs: {},
  })
  await waitFor(() => container.textContent.includes('pause_book saved · r5'))
})

test('finishing with no rating sends no rating, rather than a null the executor refuses', async () => {
  const { container } = await render(
    <PageRuntimeProvider>
      <CapabilityRecordModule
        {...moduleView({ instanceId: INSTANCE, recordId: 'book-1' })}
      />
    </PageRuntimeProvider>,
  )
  await waitFor(() => container.textContent.includes('Piranesi'))
  await click(button(container, 'Finish'))
  await waitFor(() =>
    container.querySelector('input[aria-label="rating (optional)"]'),
  )
  // The rating is left blank: the form's own submit, labelled as the action.
  const submit = container.querySelector('form button[type="submit"]')
  expect(submit?.textContent.trim()).toBe('Finish')
  await click(submit)
  const finished = await waitFor(() => sentTo('/invoke')[0])
  expect(finished.body).toMatchObject({
    actionKey: 'finish_book',
    recordId: 'book-1',
    expectedRevision: 4,
    inputs: {},
  })
  expect(Object.hasOwn(finished.body!.inputs as object, 'rating')).toBe(false)
})

// ── Authoring: the extra variant and its lifecycle, through the same dialog ──

test('the paused variant and its transitions are authored through the same controls', async () => {
  // The fixture as declared, before Phase 4.
  describing = described('capdef:reading-1')
  afterAuthor = [
    described('capdef:reading-2', definition, PAUSED),
    described(
      'capdef:reading-3',
      {
        ...definition,
        collections: [{ ...books, lifecycle: pausedLifecycle }],
      },
      PAUSED,
    ),
  ]
  const { container } = await showTable()
  await waitFor(() => container.textContent.includes('Piranesi'))
  expect(button(container, 'Pause')).toBeUndefined()
  await click(button(container, 'Customize'))
  await waitFor(() => screen().textContent.includes('Author Reading list'))

  await click(button(screen(), 'Add variant'))
  await waitFor(() => named('Variant field'))
  expect(named<HTMLSelectElement>('Variant field')?.value).toBe('status')
  expect(screen().textContent).toContain(
    `Its variants now: ${STATUS.join(', ')}.`,
  )
  fill('New variant', 'paused')
  await click(named('Add enum variant'))
  await waitFor(() => sentTo('/author').length === 1)
  expect(sentTo('/author')[0]!.body).toEqual({
    expectedDefinitionId: 'capdef:reading-1',
    ops: [
      {
        op: 'add_enum_variant',
        collectionKey: 'books',
        fieldKey: 'status',
        variant: 'paused',
      },
    ],
  })
  await waitFor(() =>
    screen().textContent.includes(
      'Variant added · the definition is now capdef:reading-2',
    ),
  )

  // The lifecycle editor reads the declared lifecycle, and offers the new variant.
  await click(button(screen(), 'Lifecycle'))
  await waitFor(() => named('Initial paused'))
  expect(named<HTMLSelectElement>('Lifecycle field')?.value).toBe('status')
  expect(named('Initial queued')?.getAttribute('aria-checked')).toBe('true')
  expect(named('Initial paused')?.getAttribute('aria-checked')).toBe('false')
  expect(named<HTMLSelectElement>('Transition 5 to')?.value).toBe('reading')
  expect(
    named('Transition 5 from finished')?.getAttribute('aria-checked'),
  ).toBe('true')

  await click(button(screen(), 'Add transition'))
  await click(named('Transition 6 from reading'))
  fill('Transition 6 to', 'paused')
  await click(button(screen(), 'Add transition'))
  await click(named('Transition 7 from paused'))
  fill('Transition 7 to', 'reading')
  await click(button(screen(), 'Save lifecycle'))
  await waitFor(() => sentTo('/author').length === 2)
  expect(sentTo('/author')[1]!.body).toEqual({
    expectedDefinitionId: 'capdef:reading-2',
    ops: [
      {
        op: 'set_lifecycle',
        collectionKey: 'books',
        lifecycle: pausedLifecycle,
      },
    ],
  })
})

// ── Templates: the reading list's design, saved and started again ───────────

test('the reading list saves as a template, and a new instance starts from it', async () => {
  const first = await showTable()
  await waitFor(() => first.container.textContent.includes('Piranesi'))
  await click(button(first.container, 'Customize'))
  await waitFor(() => screen().textContent.includes('Author Reading list'))
  await click(button(screen(), 'Templates'))
  await click(button(screen(), 'Save as template'))
  const saved = await waitFor(() =>
    calls.find(
      (call) => call.method === 'POST' && call.path.endsWith('/templates'),
    ),
  )
  expect(saved.body).toEqual({
    instanceId: INSTANCE,
    name: definition.name,
    description: definition.purpose,
  })
  await waitFor(() =>
    screen().textContent.includes(
      'Saved as template Reading list · captpl:reading.',
    ),
  )
  cleanup()

  const fresh = await showTable({ instanceId: '', viewKey: '' })
  await waitFor(() =>
    fresh.container.querySelector('input[aria-label="New instance id"]'),
  )
  fill('New instance id', 'reading/home')
  await click(button(fresh.container, 'Create instance'))
  const made = await waitFor(() => sentTo('/instantiate')[0])
  expect(made.path).toEndWith(
    `/library/templates/${encodeURIComponent('captpl:reading')}/instantiate`,
  )
  expect(made.body).toEqual({ instanceId: 'reading/home' })
  await waitFor(() =>
    fresh.container.textContent.includes(
      'Created reading/home from Reading list.',
    ),
  )
})

// ── No reading-list code ────────────────────────────────────────────────────

const SRC = join(import.meta.dir, '../..')
const SELF = join(import.meta.dir, 'reading-list.fixture.json')

/** Every UI source file a module could carry reading-list code in. */
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sources(path)
    if (!/\.(tsx?|jsx?|json)$/.test(entry.name)) return []
    if (/\.test\.tsx?$/.test(entry.name) || path === SELF) return []
    return [path]
  })
}

/** What only the reading list would name: its ids, its action keys, its node label. */
const MARKS = [
  definition.capabilityId,
  INSTANCE,
  ...phase4.actions.map((action) => action.key),
  declared.node_label,
  MODULE,
]

const mentions = (text: string) => MARKS.filter((mark) => text.includes(mark))

test('no module, page or library source names the reading list', () => {
  const files = sources(SRC)
  // The walk reaches the modules this file drove, so an empty walk cannot pass.
  const seen = files.map((file) => relative(SRC, file))
  for (const owner of [
    'components/capabilities/capability-table.tsx',
    'components/capabilities/capability-record.tsx',
    'components/capabilities/authoring.tsx',
    'components/pages/capability-modules.tsx',
    'lib/capabilities/contract.ts',
  ])
    expect(seen).toContain(owner)
  // The same check finds every mark where the reading list is declared.
  const declaredText = readFileSync(SELF, 'utf8') + JSON.stringify(pauseBook)
  expect(mentions(declaredText)).toEqual(MARKS)

  const found = files.flatMap((file) =>
    mentions(readFileSync(file, 'utf8')).map(
      (mark) => `${relative(SRC, file)}: ${mark}`,
    ),
  )
  expect(found).toEqual([])
})
