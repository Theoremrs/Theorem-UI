// SOURCING: bun:test over the catalog query's parsing, with the skills route
// answered by a stub fetch; no Theorem is running.
import { afterEach, expect, test } from 'bun:test'
import { QueryClient } from '@tanstack/react-query'
import { catalogQuery, skillOrigin } from './catalog'

const page = (
  window as unknown as { happyDOM: { setURL: (url: string) => void } }
).happyDOM
page.setURL('http://localhost:3000/settings/plugins')

const real = window.fetch
afterEach(() => {
  window.fetch = real
})

function serve(body: unknown) {
  window.fetch = Object.assign(
    async () =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    { preconnect: real.preconnect },
  )
}

test('an MCP server skill keeps its origin, so its id says which connection serves it', async () => {
  serve({
    plugins: [],
    skills: [
      {
        id: 'native-pack',
        name: 'Native',
        description: 'A native pack',
        plugin: null,
      },
      {
        id: 'mcp:docs/skill://review/SKILL.md',
        name: 'review',
        description: 'Review a change.',
        plugin: null,
        source: {
          kind: 'mcp',
          connection: 'mcp:docs',
          uri: 'skill://review/SKILL.md',
          dynamic: false,
        },
      },
    ],
  })
  const client = new QueryClient()
  const catalog = await client.fetchQuery(catalogQuery)
  expect(catalog.skills).toHaveLength(2)
  const served = catalog.skills.find((skill) => skill.name === 'review')!
  expect(served.id).toBe('mcp:docs/skill://review/SKILL.md')
  expect(served.source).toEqual({
    kind: 'mcp',
    connection: 'mcp:docs',
    uri: 'skill://review/SKILL.md',
    dynamic: false,
  })
  expect(
    catalog.skills.find((skill) => skill.id === 'native-pack')!.source,
  ).toBeUndefined()
})

test('imported skill provenance and friendly MCP labels survive catalog refresh', async () => {
  serve({
    plugins: [{ id: 'install:team', name: 'team', skillCount: 1 }],
    skills: [
      {
        id: 'skill:imported',
        name: 'review',
        plugin: 'team',
        source: {
          kind: 'import',
          installationId: 'install:team',
          source: 'https://example.test/team',
          version: '1.2.0',
        },
      },
      {
        id: 'skill:detached',
        name: 'review',
        source: {
          kind: 'import',
          installationId: null,
          source: 'file:local-review',
          version: null,
        },
      },
      {
        id: 'mcp:docs/skill://review/SKILL.md',
        name: 'review',
        source: {
          kind: 'mcp',
          connection: 'mcp:docs',
          connectionLabel: 'Docs team',
          uri: 'skill://review/SKILL.md',
          dynamic: false,
        },
      },
    ],
  })
  const client = new QueryClient()
  const catalog = await client.fetchQuery(catalogQuery)
  expect(catalog.skills.map(skillOrigin)).toEqual([
    'team',
    'file:local-review',
    'Docs team',
  ])
  expect(catalog.skills[0]?.source).toEqual({
    kind: 'import',
    installationId: 'install:team',
    source: 'https://example.test/team',
    version: '1.2.0',
  })
})
