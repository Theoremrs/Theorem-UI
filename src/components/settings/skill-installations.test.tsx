// SOURCING: real import/settings components and request helpers over the in-memory API fixture.
import { act } from 'react'
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { installFakeTheorem } from '@/stories/fake-theorem'
import type {
  SkillImport,
  SkillInstallation,
} from '@/lib/theorem/skill-installations'
import { catalogKey } from '@/lib/theorem/catalog'
import {
  cleanup,
  render,
  waitFor,
  buttonNamed,
} from '../../../test/blocks/render'
import { SkillInstallations } from './skill-installations'

const page = (
  window as unknown as { happyDOM: { setURL: (url: string) => void } }
).happyDOM
const endpoint = '/api/chat/v1/skill-installations'
const markdown =
  '---\nname: review\ndescription: Review a change.\n---\nRead references/guide.md.\n'
const fixture = (
  patch: Partial<SkillInstallation> = {},
): SkillInstallation => ({
  installationId: 'install:review',
  name: 'review',
  kind: 'skill',
  source: 'file:original',
  revision: 1,
  status: 'ready',
  skills: [{ id: 'skill:review', name: 'review' }],
  connections: {},
  requirements: [],
  unsupported: [],
  ...patch,
})
type Seen = { method: string; path: string; body: unknown; headers: Headers }
let seen: Seen[]
let installed: SkillInstallation[]
let refusal: { status: number; detail: string } | undefined
let preserved: string[]
let restore: () => void
let client: QueryClient

beforeAll(() => page.setURL('http://localhost:3000/settings/plugins'))
afterAll(() => page.setURL('about:blank'))
beforeEach(() => {
  installed = []
  seen = []
  preserved = []
  refusal = undefined
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  client.setQueryData(catalogKey, { plugins: [], skills: [] })
  const record = async (request: Request) => {
    const body = request.method === 'DELETE' ? undefined : await request.json()
    seen.push({
      method: request.method,
      path: new URL(request.url).pathname,
      body,
      headers: request.headers,
    })
    return body
  }
  const refused = () =>
    refusal &&
    new Response(JSON.stringify({ detail: refusal.detail }), {
      status: refusal.status,
      headers: { 'content-type': 'application/json' },
    })
  restore = installFakeTheorem({
    'GET /api/chat/v1/bootstrap': () => ({
      csrfToken: 'fixture-csrf',
      tenantId: 't',
    }),
    ['GET ' + endpoint]: () => ({ installations: installed }),
    ['POST ' + endpoint]: async (_params, request) => {
      const body = (await record(request)) as SkillImport
      if (refusal) return refused()
      const receipt = fixture({
        source: body.source,
        kind: body.manifest ? 'plugin' : 'skill',
        name:
          typeof body.manifest?.name === 'string'
            ? body.manifest.name
            : 'review',
        revision: installed.length ? 2 : 1,
        version:
          typeof body.manifest?.version === 'string'
            ? body.manifest.version
            : undefined,
        connections: body.connections ?? {},
        status: body.manifest ? 'needs_setup' : 'ready',
        requirements: body.manifest
          ? [{ name: 'docs', status: 'needs_setup' }]
          : [],
        unsupported: body.unsupported ?? [],
        preserved,
      })
      installed = [receipt]
      return receipt
    },
    ['PATCH ' + endpoint + '/:id']: async (_params, request) => {
      const body = (await record(request)) as {
        connections: Record<string, string>
      }
      if (refusal) return refused()
      const receipt = fixture({
        ...installed[0],
        connections: body.connections,
        revision: 2,
        status: body.connections.docs ? 'ready' : 'needs_setup',
        requirements: [
          {
            name: 'docs',
            connectionId: body.connections.docs,
            status: body.connections.docs ? 'ready' : 'needs_setup',
          },
        ],
      })
      installed = [receipt]
      return receipt
    },
    ['DELETE ' + endpoint + '/:id']: async (params, request) => {
      await record(request)
      if (refusal) return refused()
      installed = []
      return {
        removed: decodeURIComponent(params.id!),
        retired: ['skill:review'],
        preserved,
      }
    },
    'GET /api/connections/v1/mcp': () => ({
      servers: [
        {
          id: 'mcp:docs',
          label: 'Docs server',
          kind: 'mcp',
          status: 'connected',
          enabled: true,
          health: { state: 'ok' },
          transport: 'http',
          url: 'https://docs.example.test/mcp',
          auth: { type: 'none', configured: false },
          tools: [],
        },
      ],
    }),
  })
})
afterEach(async () => {
  await cleanup()
  client.clear()
  restore()
})
const press = (element: Element) =>
  act(async () => (element as HTMLElement).click())
const button = (label: string) => buttonNamed(document, label)
const text = () => document.body.textContent
const mount = () =>
  render(
    <QueryClientProvider client={client}>
      <SkillInstallations />
    </QueryClientProvider>,
  )

function file(path: string, body: string, folder = 'new-folder') {
  const result = new File([body], path.split('/').at(-1)!, {
    type: 'text/plain',
  })
  Object.defineProperty(result, 'webkitRelativePath', {
    value: folder + '/' + path,
  })
  return result
}
async function choose(files: File[], folder = false) {
  const input = document.querySelector<HTMLInputElement>(
    folder
      ? '[aria-label="Skill or plugin folder"]'
      : '[aria-label="Skill file"]',
  )!
  await act(async () => {
    Object.defineProperty(input, 'files', { value: files, configurable: true })
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await waitFor(() => !text().includes('Reading package...'))
}
async function openImport() {
  await mount()
  await press(await waitFor(() => button('Import')))
  await waitFor(() => button('Choose SKILL.md'))
}

test('an import is reviewed before a protected write, then refreshes the installations and catalog', async () => {
  await openImport()
  await choose([file('SKILL.md', markdown)])
  expect(seen).toHaveLength(0)
  expect(text()).toContain('One skill')
  await press(button('Import package')!)
  await waitFor(() => text().includes('Imported review'))
  expect(seen).toHaveLength(1)
  expect(seen[0]).toMatchObject({
    method: 'POST',
    path: endpoint,
    body: { source: 'file:new-folder', markdown, connections: {} },
  })
  expect(seen[0]!.headers.get('X-CSRF-Token')).toBeTruthy()
  expect(seen[0]!.headers.get('Idempotency-Key')).toBeTruthy()
  expect(client.getQueryState(catalogKey)?.isInvalidated).toBe(true)
  await press(button('Done')!)
  await waitFor(() => button('Update'))
  expect(text()).toContain('file:new-folder')
})

test('plugin imports show unsupported contributions and can defer a required connection', async () => {
  await openImport()
  await choose(
    [
      file(
        '.claude-plugin/plugin.json',
        '{"name":"review","version":"1.2.0","mcpServers":{"docs":{"url":"https://docs.example.test/mcp"}},"hooks":{}}',
      ),
      file('skills/review/SKILL.md', markdown),
      file('skills/review/references/guide.md', 'The instructions.'),
      file('README.md', 'Package readme.'),
    ],
    true,
  )
  expect(text()).toContain('Connections this package needs')
  expect(text()).toContain('Unsupported contribution: hooks')
  expect(text()).toContain('File outside installed skills: README.md')
  await press(button('Import package')!)
  await waitFor(() => text().includes('Imported review'))
  expect(text()).toContain('Needs setup')
  const body = seen[0]!.body as SkillImport
  expect(body.connections).toEqual({})
  expect(body.skills?.[0]?.files).toMatchObject([
    { path: 'references/guide.md', content: 'The instructions.' },
  ])
  await press(button('Done')!)
  await waitFor(() => button('Set up'))
})

test('updating keeps the installation source even when the folder name changes', async () => {
  installed = [fixture()]
  await mount()
  await press(await waitFor(() => button('Update')))
  await choose([file('SKILL.md', markdown, 'renamed-package')])
  const source = document.querySelector<HTMLInputElement>(
    'input:not([type="file"])',
  )!
  expect(source.disabled).toBe(true)
  expect(source.value).toBe('file:original')
  await press(button('Update installation')!)
  await waitFor(() => text().includes('Updated review'))
  expect(seen[0]).toMatchObject({ body: { source: 'file:original' } })
  expect(installed[0]?.revision).toBe(2)
})

test('connection setup patches the native installation and makes readiness visible', async () => {
  installed = [
    fixture({
      kind: 'plugin',
      status: 'needs_setup',
      requirements: [{ name: 'docs', status: 'needs_setup' }],
    }),
  ]
  await mount()
  await press(await waitFor(() => button('Set up')))
  await press(
    await waitFor(() =>
      document.querySelector('[aria-label="Connection for docs"]'),
    ),
  )
  const option = await waitFor(() =>
    [...document.querySelectorAll('[role="option"]')].find((item) =>
      item.textContent.includes('Docs server'),
    ),
  )
  await press(option)
  await press(button('Save connections')!)
  await waitFor(() => button('Connections'))
  expect(seen).toHaveLength(1)
  expect(seen[0]).toMatchObject({
    method: 'PATCH',
    path: endpoint + '/install%3Areview',
    body: { connections: { docs: 'mcp:docs' } },
  })
  expect(text()).toContain('Ready')
  expect(client.getQueryState(catalogKey)?.isInvalidated).toBe(true)
})

test('removal waits for confirmation and reports shared skills preserved by the owner', async () => {
  installed = [fixture()]
  preserved = ['shared:skill']
  await mount()
  await press(await waitFor(() => button('Remove')))
  expect(seen).toHaveLength(0)
  expect(text()).toContain(
    'Locally edited or shared skills and existing connections stay available.',
  )
  await press(button('Remove installation')!)
  await waitFor(() =>
    text().includes('Locally edited or shared skills were kept.'),
  )
  expect(seen).toHaveLength(1)
  expect(seen[0]).toMatchObject({
    method: 'DELETE',
    path: endpoint + '/install%3Areview',
  })
  expect(installed).toEqual([])
  expect(client.getQueryState(catalogKey)?.isInvalidated).toBe(true)
})

test('a refused import stays open with its review and a retry action', async () => {
  refusal = { status: 422, detail: 'This package needs a valid description.' }
  await openImport()
  await choose([file('SKILL.md', markdown)])
  await press(button('Import package')!)
  await waitFor(() => text().includes(refusal!.detail))
  expect(button('Import package')?.disabled).toBe(false)
  expect(text()).toContain('One skill')
  expect(button('Done')).toBeUndefined()
})

test('an update reports locally edited skills retained outside the installation', async () => {
  installed = [fixture()]
  preserved = ['skill:local-edits']
  await mount()
  await press(await waitFor(() => button('Update')))
  await choose([file('SKILL.md', markdown)])
  await press(button('Update installation')!)
  await waitFor(() => text().includes('Updated review'))
  const details = document.querySelector('[role="dialog"] details[open]')
  expect(details?.textContent).toContain(
    'Kept 1 locally edited or shared skill.',
  )
  expect(details?.textContent).toContain('skill:local-edits')
  expect(details?.textContent).toContain(
    'These remain available separately from this installation.',
  )
})

test.each(['__proto__', 'constructor'])(
  'a declared server named %s is mapped as an ordinary own key',
  async (name) => {
    installed = [
      fixture({
        kind: 'plugin',
        status: 'needs_setup',
        requirements: [{ name, status: 'needs_setup' }],
      }),
    ]
    await mount()
    await press(await waitFor(() => button('Set up')))
    await press(
      await waitFor(() =>
        document.querySelector('[aria-label="Connection for ' + name + '"]'),
      ),
    )
    await press(
      await waitFor(() =>
        [...document.querySelectorAll('[role="option"]')].find((item) =>
          item.textContent.includes('Docs server'),
        ),
      ),
    )
    await press(button('Save connections')!)
    await waitFor(() => seen.length)
    const body = seen[0]!.body as { connections: Record<string, string> }
    expect(Object.keys(body.connections)).toEqual([name])
    expect(body.connections[name]).toBe('mcp:docs')
  },
)
