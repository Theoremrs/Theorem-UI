// SOURCING: bun:test and the block render helpers, TanStack Router (the column's links), and stories/fake-theorem answering the project context routes, the Library and the Connections routes from stories/fixtures/project-context, which keeps Theorem's contract (docs/plans/project-context/CONTRACT.md): revision checks, untracked and unreadable refusals. The column and its editors run with the real client code.
import { act } from 'react'
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { installFakeTheorem } from '@/stories/fake-theorem'
import type { FakeRoutes } from '@/stories/fake-theorem'
import { projectContextRoutes } from '@/stories/fixtures/project-context'
import type { ProjectContextBody } from '@/lib/theorem/project-context'
import {
  buttonNamed,
  cleanup,
  click,
  render,
  waitFor,
} from '../../../test/blocks/render'
import { ProjectContextList } from './project-context'

const page = (
  window as unknown as { happyDOM: { setURL: (url: string) => void } }
).happyDOM
beforeAll(() => page.setURL('http://localhost:3000/'))
afterAll(() => page.setURL('about:blank'))

const CONTEXT = 'PUT /api/chat/v1/projects/:projectId/context'
const bootstrap: FakeRoutes = {
  'GET /api/chat/v1/bootstrap': () => ({ csrfToken: 'csrf', tenantId: 'test' }),
}

type Sent = { ifMatch: string | null; body: ProjectContextBody }
let sent: Sent[] = []
let restore: () => void = () => {}

/** The story's routes, with each write recorded as Theorem received it. */
function routes(overrides: FakeRoutes = {}): FakeRoutes {
  const story = projectContextRoutes(Date.now())
  const put = story[CONTEXT]!
  return {
    ...bootstrap,
    ...story,
    [CONTEXT]: async (params, request) => {
      sent.push({
        ifMatch: request.headers.get('if-match'),
        body: (await request.clone().json()) as ProjectContextBody,
      })
      return put(params, request)
    },
    ...overrides,
  }
}

async function mount(table: FakeRoutes, projectId = 'project-theorem') {
  restore = installFakeTheorem(table)
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const root = createRootRoute({
    component: () => (
      <QueryClientProvider client={client}>
        <ProjectContextList projectId={projectId} />
      </QueryClientProvider>
    ),
  })
  const router = createRouter({
    routeTree: root,
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  await router.load()
  const view = await render(<RouterProvider router={router} />)
  await waitFor(() => !view.container.textContent.includes('Loading…'))
  return view
}

afterEach(async () => {
  await cleanup()
  restore()
  sent = []
})

const anchor = (root: ParentNode, text: string) =>
  [...root.querySelectorAll('a')].find((a) => a.textContent.trim() === text)

const dialog = () =>
  waitFor(() => document.querySelector<HTMLElement>('[role="dialog"]'))

/** Clicking the row's label is what a person does; happy-dom toggles twice if the box itself is clicked inside a label. */
const choice = (root: ParentNode, text: string) =>
  [...root.querySelectorAll('label')].find((label) =>
    label.textContent.includes(text),
  )!

async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const field = (root: ParentNode, label: string) =>
  [...root.querySelectorAll('label')]
    .find((entry) => entry.textContent.startsWith(label))!
    .querySelector('input')!

test('each kind lists what the project names, where it opens', async () => {
  const { container } = await mount(routes())
  expect(anchor(container, 'Source track')?.getAttribute('href')).toBe(
    '/notes/doc-track',
  )
  const upload = anchor(container, 'Spaces and their notes.pdf')
  expect(upload?.getAttribute('href')).toBe(
    '/api/chat/v1/uploads/upload-paper/content',
  )
  expect(upload?.getAttribute('target')).toBe('_blank')
  const repository = anchor(container, 'theorem-story/theorem')
  expect(repository?.getAttribute('href')).toBe(
    'https://github.com/theorem-story/theorem',
  )
  expect(repository?.getAttribute('rel')).toBe('noreferrer noopener')
  expect(anchor(container, 'Project context spec')?.getAttribute('href')).toBe(
    'https://example.com/spec/project-context',
  )
  expect(anchor(container, 'example.com/notes/ownership')).toBeDefined()
  // Connections read as their names once the connection list arrives.
  await waitFor(() => container.textContent.includes('GitHub'))
  expect(container.textContent).toContain('Linear')
  expect(container.textContent).not.toContain('does not serve')
})

test('a project never written shows each kind empty with Add, and every connection', async () => {
  const { container } = await mount(routes(), 'project-other')
  for (const kind of ['documents', 'repositories', 'links'])
    expect(container.querySelector(`[aria-label="Add ${kind}"]`)).not.toBeNull()
  expect(container.textContent).toContain('Every enabled connection')
})

test('a Theorem without the routes says so, with nothing to retry', async () => {
  const { container } = await mount(bootstrap)
  expect(container.textContent).toContain(
    'This Theorem does not serve project context yet.',
  )
  expect(buttonNamed(container, 'Try again')).toBeUndefined()
})

test('a project Theorem no longer has is said plainly', async () => {
  const { container } = await mount({
    ...bootstrap,
    'GET /api/chat/v1/projects/:projectId/context': () =>
      new Response(
        JSON.stringify({ code: 'chat_resource_not_found', title: 'Not found' }),
        {
          status: 404,
          headers: { 'content-type': 'application/problem+json' },
        },
      ),
  })
  expect(container.textContent).toContain('Theorem no longer has this project.')
})

test('a link is checked, added and saved against the revision that was read', async () => {
  const { container } = await mount(routes())
  await click(container.querySelector('[aria-label="Edit links"]')!)
  const editor = await dialog()

  await type(field(editor, 'Address'), 'ftp://example.com/file')
  await click(buttonNamed(editor, 'Add link')!)
  expect(editor.textContent).toContain(
    'Only http and https addresses can be kept.',
  )
  expect(buttonNamed(editor, 'Save')!.disabled).toBe(true)

  await type(field(editor, 'Address'), 'https://example.com/roadmap')
  await type(field(editor, 'Title'), 'Roadmap')
  await click(buttonNamed(editor, 'Add link')!)
  expect(editor.textContent).toContain('Roadmap')
  await click(buttonNamed(editor, 'Save')!)

  await waitFor(() => anchor(container, 'Roadmap'))
  expect(sent).toHaveLength(1)
  expect(sent[0]!.ifMatch).toBe('1')
  expect(sent[0]!.body.links).toEqual([
    {
      url: 'https://example.com/spec/project-context',
      title: 'Project context spec',
    },
    { url: 'https://example.com/notes/ownership' },
    { url: 'https://example.com/roadmap', title: 'Roadmap' },
  ])
  // Only links changed; everything else went back as it was read.
  expect(sent[0]!.body.connections).toEqual(['github', 'mcp:linear'])
  expect(document.querySelector('[role="dialog"]')).toBeNull()
})

test('an edit that loses a race is applied again to what the other writer saved', async () => {
  const story = routes()
  let raced = false
  const { container } = await mount({
    ...story,
    [CONTEXT]: async (params, request) => {
      if (!raced) {
        raced = true
        // Someone else removes a link and saves first.
        await story[CONTEXT]!(
          params,
          new Request(request.url, {
            method: 'PUT',
            headers: { 'if-match': '1', 'content-type': 'application/json' },
            body: JSON.stringify({
              documents: [],
              repositories: [],
              links: [{ url: 'https://example.com/notes/ownership' }],
              connections: null,
            }),
          }),
        )
        sent = []
      }
      return story[CONTEXT]!(params, request)
    },
  })
  await click(container.querySelector('[aria-label="Edit links"]')!)
  const editor = await dialog()
  await type(field(editor, 'Address'), 'https://example.com/roadmap')
  await click(buttonNamed(editor, 'Save')!)

  await waitFor(() => anchor(container, 'example.com/roadmap'))
  // The first write was refused at revision 1; the second carries revision 2.
  expect(sent.map((write) => write.ifMatch)).toEqual(['1', '2'])
  expect(sent[1]!.body).toEqual({
    documents: [],
    repositories: [],
    links: [
      { url: 'https://example.com/notes/ownership' },
      { url: 'https://example.com/roadmap' },
    ],
    connections: null,
  })
  expect(anchor(container, 'Project context spec')).toBeUndefined()
})

test('documents come from the Library, and a source that cannot be read cannot be added', async () => {
  const { container } = await mount(routes())
  await click(container.querySelector('[aria-label="Edit documents"]')!)
  const editor = await dialog()
  await waitFor(() => editor.textContent.includes('Scanned contract.pdf'))

  // What the project names comes first, in view, whatever the Library's order.
  const titles = [...editor.querySelectorAll('[role="group"] label')].map(
    (label) => label.textContent,
  )
  expect(titles[0]).toStartWith('Source track')
  expect(titles[1]).toStartWith('Spaces and their notes.pdf')
  expect(titles[1]).toContain('File')

  const failed = choice(editor, 'Scanned contract.pdf')
  expect(failed.textContent).toContain('Not readable')
  expect(failed.querySelector('[data-disabled]')).not.toBeNull()

  await click(choice(editor, 'Hello World!'))
  await click(choice(editor, 'Source track'))
  await click(buttonNamed(editor, 'Save')!)

  await waitFor(() => anchor(container, 'Hello World!'))
  expect(sent[0]!.body.documents).toEqual([
    {
      reference: { kind: 'upload', id: 'upload-paper' },
      title: 'Spaces and their notes.pdf',
    },
    {
      reference: { kind: 'graph_document', id: 'doc-hello' },
      title: 'Hello World!',
    },
  ])
  expect(anchor(container, 'Source track')).toBeUndefined()
})

test('repositories are chosen from the ones Theorem tracks', async () => {
  const { container } = await mount(routes())
  await click(container.querySelector('[aria-label="Edit repositories"]')!)
  const editor = await dialog()
  await waitFor(() => editor.textContent.includes('theorem-story/platinum'))
  // Not tracked, so not offered.
  expect(editor.textContent).not.toContain('theorem-story/scratch')
  // What the project names comes first, ahead of what sorts before it by name.
  const rows = () =>
    [...editor.querySelectorAll('[role="group"] label')].map((label) =>
      label.textContent.trim(),
    )
  expect(rows()).toEqual([
    'theorem-story/theorem',
    'theorem-story/platinum',
    'theorem-story/theorem-ui',
  ])

  await click(choice(editor, 'theorem-story/platinum'))
  await click(buttonNamed(editor, 'Save')!)
  await waitFor(() => anchor(container, 'theorem-story/platinum'))
  expect(sent[0]!.body.repositories).toEqual([
    { fullName: 'theorem-story/theorem' },
    { fullName: 'theorem-story/platinum' },
  ])
})

test('Theorem refusing a write says why in the editor and keeps it open', async () => {
  const { container } = await mount(
    routes({
      [CONTEXT]: () =>
        new Response(
          JSON.stringify({
            code: 'project_context_repository_untracked',
            title: 'Theorem does not track that repository',
            detail: 'theorem-story/platinum',
          }),
          {
            status: 422,
            headers: { 'content-type': 'application/problem+json' },
          },
        ),
    }),
  )
  await click(container.querySelector('[aria-label="Edit repositories"]')!)
  const editor = await dialog()
  await waitFor(() => editor.textContent.includes('theorem-story/platinum'))
  await click(choice(editor, 'theorem-story/platinum'))
  await click(buttonNamed(editor, 'Save')!)
  await waitFor(() => editor.querySelector('[role="alert"]'))
  expect(editor.querySelector('[role="alert"]')!.textContent).toContain(
    'theorem-story/platinum',
  )
  expect(document.querySelector('[role="dialog"]')).not.toBeNull()
})

test('connections go back to every enabled one, or to a chosen few', async () => {
  const { container } = await mount(routes())
  await click(container.querySelector('[aria-label="Edit connections"]')!)
  let editor = await dialog()
  await waitFor(() => editor.textContent.includes('Gmail'))
  // A connection that needs sign-in says so beside its name.
  expect(choice(editor, 'Google Drive').textContent).toContain('Needs sign-in')

  await click(choice(editor, 'Every enabled connection'))
  await click(buttonNamed(editor, 'Save')!)
  await waitFor(() =>
    container.textContent.includes('Every enabled connection'),
  )
  expect(sent[0]!.body.connections).toBeNull()

  await click(container.querySelector('[aria-label="Edit connections"]')!)
  editor = await dialog()
  await click(choice(editor, 'Only the ones chosen here'))
  await waitFor(() => editor.textContent.includes('Gmail'))
  await click(choice(editor, 'Gmail'))
  await click(buttonNamed(editor, 'Save')!)
  await waitFor(
    () => !container.textContent.includes('Every enabled connection'),
  )
  expect(sent[1]!.body.connections).toEqual(['google_gmail'])
  expect(sent[1]!.ifMatch).toBe('2')
})
