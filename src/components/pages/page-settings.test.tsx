// SOURCING: bun:test over page-settings.tsx and over the page editor (page-view.tsx's VaultPage) with
// a capability table placed on the page, rendered with test/workspace's render and fake vault into
// happy-dom; window.fetch stands in for a Theorem that serves /api/capabilities/v1, as
// capability-table.test.tsx stands one in. What is asserted is what the saved page file holds.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { act } from 'react'
import {
  cleanup,
  fakeWorkspace,
  render,
  waitFor,
} from '../../../test/workspace'
import { CAPABILITIES } from '@/lib/capabilities/api'
import type { QueryRequest } from '@/lib/capabilities/contract'
import type { ComponentData, LayoutData } from '@/lib/modules/contract'
import { pageText, parsePage } from '@/lib/modules/contract'
import { usePageDrafts } from '@/lib/modules/drafts'
import { findComponent, newPage } from '@/lib/modules/layout'
import {
  describeResult,
  queryResult,
  taskRows,
} from '@/components/capabilities/fixture'
import {
  PageSettingsProvider,
  useOwnSettings,
  withInstanceProps,
} from './page-settings'
import { VaultPage } from './page-view'
import { SPLIT_TYPE } from './puck-config'

const page = (
  window as unknown as { happyDOM: { setURL: (url: string) => void } }
).happyDOM
page.setURL('http://localhost:3000/pages/Desk')

const realFetch = window.fetch
let library: unknown[]
let queried: string[]

beforeEach(() => {
  library = []
  queried = []
  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : undefined
    const url = new URL(request ? request.url : String(input))
    const raw =
      init?.body ?? (request ? await request.clone().text() : undefined)
    const body = raw
      ? (JSON.parse(String(raw)) as Record<string, unknown>)
      : undefined
    const json = (value: unknown, status = 200) =>
      new Response(JSON.stringify(value), {
        status,
        headers: { 'content-type': 'application/json' },
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
      return json({ templates: library })
    }
    if (rest.length === 1) return json({ instances: [] })
    if (rest.length === 2) return json(describeResult())
    if (rest[2] === 'query') {
      const asked = body as unknown as QueryRequest
      queried.push(asked.viewKey ?? '')
      return json(queryResult(asked.viewKey === 'next' ? taskRows : []))
    }
    return json({}, 404)
  }) as typeof fetch
})

afterEach(() => {
  window.fetch = realFetch
  cleanup()
  usePageDrafts.setState({ drafts: {} })
})

const instance = (
  type: string,
  id: string,
  props: Record<string, unknown> = {},
): ComponentData => ({ type, props: { id, ...props } })

const button = (container: ParentNode, name: string) =>
  [...container.querySelectorAll('button')].find(
    (one) => one.textContent.trim() === name,
  )

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

/** A vault holding one page with this layout, opened in the page editor. */
async function openPage(layout: LayoutData) {
  const fake = fakeWorkspace({
    'Pages/Desk.page.json': pageText({ ...newPage('Desk'), layout }),
  })
  const [entry] = (await fake.client.tree()).filter(
    (e) => e.path === 'Pages/Desk.page.json',
  )
  const shown = await render(
    <VaultPage client={fake.client} entryId={entry!.id} />,
  )
  const saved = () =>
    parsePage('Pages/Desk.page.json', fake.text('Pages/Desk.page.json')!)
  return { ...shown, fake, saved }
}

const current = (container: HTMLElement) =>
  container.querySelector('nav[aria-label="Views"] [aria-current="true"]')
    ?.textContent

// ── The pure parts ──────────────────────────────────────────────────────────

test('one instance’s props change wherever it sits, and nothing else does', () => {
  const layout: LayoutData = {
    root: { props: {} },
    content: [
      instance('theorem.capability.table', 'table', { viewKey: '' }),
      instance(SPLIT_TYPE, 'split', {
        first: [
          instance('theorem.capability.table', 'inner', {
            instanceId: 'tracker/main',
            viewKey: 'next',
            bind: {},
          }),
        ],
        second: [],
      }),
    ],
  }
  const next = withInstanceProps(layout, 'inner', { viewKey: 'all' })
  expect(findComponent(next, 'inner')?.props).toEqual({
    id: 'inner',
    instanceId: 'tracker/main',
    viewKey: 'all',
    bind: {},
  })
  expect(findComponent(next, 'table')?.props).toEqual({
    id: 'table',
    viewKey: '',
  })
  // The layout it was given is left as it was.
  expect(findComponent(layout, 'inner')?.props.viewKey).toBe('next')
})

test('a writer is handed only to an instance on the page itself, while the page is used', async () => {
  const seen: Record<string, boolean> = {}
  function Probe({
    name,
    path,
    arranging = false,
  }: {
    name: string
    path: string
    arranging?: boolean
  }) {
    seen[name] = !!useOwnSettings({ instanceId: 'table', path, arranging })
    return null
  }
  await render(
    <>
      <Probe name="no page" path="table" />
      <PageSettingsProvider value={() => {}}>
        <Probe name="on the page" path="table" />
        <Probe name="in a composite" path="box/table" />
        <Probe name="arranging" path="table" arranging />
      </PageSettingsProvider>
    </>,
  )
  expect(seen).toEqual({
    'no page': false,
    'on the page': true,
    'in a composite': false,
    arranging: false,
  })
})

// ── Through the page editor ─────────────────────────────────────────────────

test('the view picked in a table is written into the page, and saved with it', async () => {
  const { container, saved } = await openPage({
    root: { props: {} },
    content: [
      instance('theorem.capability.table', 'table', {
        instanceId: 'tracker/main',
        viewKey: '',
      }),
    ],
  })
  await waitFor(() => container.textContent.includes('Write the plan'))
  expect(current(container)).toBe('Next')
  expect(container.textContent).not.toContain('Unsaved changes')

  await act(async () => button(container, 'All tasks')?.click())
  await waitFor(() => current(container) === 'All tasks')
  await waitFor(() => queried.includes('all'))
  // The page now differs from its file, and says so until it is saved.
  await waitFor(() => container.textContent.includes('Unsaved changes'))
  expect(findComponent(saved().layout, 'table')?.props.viewKey).toBe('')

  act(() => button(container, 'Save')!.click())
  await waitFor(() => !container.textContent.includes('Unsaved changes'))
  expect(findComponent(saved().layout, 'table')?.props).toEqual({
    id: 'table',
    instanceId: 'tracker/main',
    viewKey: 'all',
  })
})

test('a view bound as an input wins, and picking another leaves the page as it is', async () => {
  const { container, saved } = await openPage({
    root: { props: {} },
    content: [
      instance('theorem.text', 'pick', { text: 'all' }),
      instance('theorem.capability.table', 'table', {
        instanceId: 'tracker/main',
        viewKey: 'next',
        bind: { viewKey: { from: 'pick', port: 'text' } },
      }),
    ],
  })
  // The bound value takes the setting's place.
  await waitFor(() => current(container) === 'All tasks')
  await act(async () => button(container, 'Next')?.click())
  await waitFor(() => current(container) === 'Next')
  expect(container.textContent).not.toContain('Unsaved changes')
  expect(findComponent(saved().layout, 'table')?.props.viewKey).toBe('next')
})

test('a bound instance id is the one read', async () => {
  const { container } = await openPage({
    root: { props: {} },
    content: [
      instance('theorem.text', 'which', { text: 'tracker/main' }),
      instance('theorem.capability.table', 'table', {
        instanceId: '',
        viewKey: '',
        bind: { instanceId: { from: 'which', port: 'text' } },
      }),
    ],
  })
  await waitFor(() => container.textContent.includes('Write the plan'))
})

test('an instance made from a template is opened by writing the module’s settings', async () => {
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
  const { container, saved } = await openPage({
    root: { props: {} },
    content: [
      instance('theorem.capability.table', 'table', {
        instanceId: '',
        viewKey: '',
      }),
    ],
  })
  const id = await waitFor(() =>
    container.querySelector<HTMLInputElement>(
      'input[aria-label="New instance id"]',
    ),
  )
  type(id, 'reading/home')
  await act(async () => button(container, 'Create instance')?.click())
  await waitFor(() => container.textContent.includes('Unsaved changes'))
  // The module now reads the new instance.
  await waitFor(() => current(container) === 'Next')
  act(() => button(container, 'Save')!.click())
  await waitFor(() => !container.textContent.includes('Unsaved changes'))
  expect(findComponent(saved().layout, 'table')?.props).toEqual({
    id: 'table',
    instanceId: 'reading/home',
    viewKey: '',
  })
})
