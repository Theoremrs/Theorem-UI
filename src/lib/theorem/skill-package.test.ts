import { expect, test } from 'bun:test'
import { readSkillPackage } from './skill-package'

const markdown = (name: string) =>
  `---\nname: ${name}\ndescription: Review a change.\n---\nRead references/guide.md.\n`
const file = (path: string, body: string | Uint8Array, type = 'text/plain') => {
  const data = typeof body === 'string' ? body : new Uint8Array(body).buffer
  const item = new File([data], path.split('/').at(-1)!, { type })
  Object.defineProperty(item, 'webkitRelativePath', { value: 'bundle/' + path })
  return item
}

test('a standalone SKILL.md keeps its standard name and instructions', async () => {
  const result = await readSkillPackage([file('SKILL.md', markdown('review'))])
  expect(result.kind).toBe('skill')
  expect(result.request.markdown).toBe(markdown('review'))
  expect(result.request.source).toBe('file:bundle')
})

test('a skill folder retains its text and binary supporting files', async () => {
  const result = await readSkillPackage([
    file('SKILL.md', markdown('review')),
    file('references/guide.md', 'Check the changed behavior.'),
    file('scripts/check.py', 'print("check")'),
    file(
      'assets/sample.bin',
      new Uint8Array([0, 255, 10]),
      'application/octet-stream',
    ),
  ])
  expect(result.request.files).toEqual([
    {
      path: 'references/guide.md',
      content: 'Check the changed behavior.',
      mimeType: 'text/plain;charset=utf-8',
    },
    {
      path: 'scripts/check.py',
      content: 'print("check")',
      mimeType: 'text/plain;charset=utf-8',
    },
    {
      path: 'assets/sample.bin',
      base64: 'AP8K',
      mimeType: 'application/octet-stream',
    },
  ])
})

test('a Claude plugin resolves local manifests, default and extra skills, and reports unsupported files', async () => {
  const result = await readSkillPackage([
    file(
      '.claude-plugin/plugin.json',
      JSON.stringify({
        name: 'review-pack',
        version: '2.0.0',
        skills: './extra-skills',
        mcpServers: './.mcp.json',
        hooks: { PreToolUse: [] },
      }),
    ),
    file(
      '.mcp.json',
      JSON.stringify({
        mcpServers: { github: { url: 'https://example.test/mcp' } },
      }),
    ),
    file('skills/review/SKILL.md', markdown('review')),
    file('skills/review/references/guide.md', 'Read this.'),
    file('extra-skills/triage/SKILL.md', markdown('triage')),
    file('extra-skills/triage/scripts/check.py', 'pass'),
    file('README.md', 'The package readme.'),
  ])
  expect(result.name).toBe('review-pack')
  expect(result.version).toBe('2.0.0')
  expect(result.requirements).toEqual(['github'])
  expect(result.request.manifest?.mcpServers).toEqual({
    github: { url: 'https://example.test/mcp' },
  })
  expect(result.request.skills?.map((skill) => skill.name)).toEqual([
    'review',
    'triage',
  ])
  expect(result.request.skills?.[0]?.files?.map((item) => item.path)).toEqual([
    'references/guide.md',
  ])
  expect(result.request.skills?.[1]?.files?.map((item) => item.path)).toEqual([
    'scripts/check.py',
  ])
  expect(result.notices).toContain('Unsupported contribution: hooks')
  expect(result.notices).toContain('File outside installed skills: README.md')
})

test('a default .mcp.json contributes requirements without an inline manifest key', async () => {
  const result = await readSkillPackage([
    file('.claude-plugin/plugin.json', '{"name":"tools"}'),
    file(
      '.mcp.json',
      '{"mcpServers":{"docs":{"url":"https://example.test/mcp"}}}',
    ),
  ])
  expect(result.requirements).toEqual(['docs'])
  expect(result.request.skills).toEqual([])
  expect(result.notices).toEqual([])
})

test('a manifest cannot escape the selected folder or fetch a config URL', async () => {
  for (const path of [
    '../outside.json',
    '/outside.json',
    'https://example.test/config.json',
  ]) {
    await expect(
      readSkillPackage([
        file(
          'plugin.json',
          JSON.stringify({ name: 'broken', mcpServers: path }),
        ),
      ]),
    ).rejects.toThrow('outside its folder')
  }
})

test('missing declared skills and missing config files stop the import', async () => {
  await expect(
    readSkillPackage([
      file('plugin.json', '{"name":"broken","skills":"./missing"}'),
    ]),
  ).rejects.toThrow('was not selected')
  await expect(
    readSkillPackage([
      file('plugin.json', '{"name":"broken","mcpServers":"./missing.json"}'),
    ]),
  ).rejects.toThrow('was not selected')
})

test('a missing name or an oversized SKILL.md stops the import', async () => {
  await expect(
    readSkillPackage([file('SKILL.md', 'No frontmatter')]),
  ).rejects.toThrow('frontmatter')
  await expect(
    readSkillPackage([
      file('SKILL.md', markdown('large') + 'x'.repeat(256 * 1024)),
    ]),
  ).rejects.toThrow('256 KiB')
})

test('MCP declarations supplement the default file and later named entries take precedence', async () => {
  const result = await readSkillPackage([
    file(
      'plugin.json',
      JSON.stringify({
        name: 'tools',
        mcpServers: [
          './config/extra.json',
          { docs: { url: 'https://final.example.test/mcp' } },
        ],
      }),
    ),
    file(
      '.mcp.json',
      '{"mcpServers":{"docs":{"url":"https://default.example.test/mcp"},"issues":{"url":"https://issues.example.test/mcp"}}}',
    ),
    file(
      'config/extra.json',
      '{"docs":{"url":"https://extra.example.test/mcp"},"search":{"url":"https://search.example.test/mcp"}}',
    ),
  ])
  expect(result.requirements).toEqual(['docs', 'issues', 'search'])
  expect(result.request.manifest?.mcpServers).toMatchObject({
    docs: { url: 'https://final.example.test/mcp' },
    issues: { url: 'https://issues.example.test/mcp' },
    search: { url: 'https://search.example.test/mcp' },
  })
  expect(result.notices).toEqual([])
})

test('plugin-root skills retain their files without taking another skill or consumed package configuration', async () => {
  const result = await readSkillPackage([
    file('.claude-plugin/plugin.json', '{"name":"root-pack","skills":"."}'),
    file('.mcp.json', '{"mcpServers":{}}'),
    file('SKILL.md', markdown('root')),
    file('references/guide.md', 'Root guide.'),
    file('skills/nested/SKILL.md', markdown('nested')),
    file('skills/nested/scripts/check.py', 'pass'),
    file('hooks/hooks.json', '{"hooks":{}}'),
  ])
  expect(result.request.skills?.map((skill) => skill.name)).toEqual([
    'root',
    'nested',
  ])
  expect(result.request.skills?.[0]?.files?.map((item) => item.path)).toEqual([
    'references/guide.md',
    'hooks/hooks.json',
  ])
  expect(result.request.skills?.[1]?.files?.map((item) => item.path)).toEqual([
    'scripts/check.py',
  ])
  expect(result.notices).toContain('Unsupported contribution: hooks')
})

test('MCP bundles are reported as unsupported without fetching or executing them', async () => {
  const result = await readSkillPackage([
    file(
      'plugin.json',
      '{"name":"bundled","mcpServers":["./server.mcpb","https://example.test/other.dxt"]}',
    ),
    file('server.mcpb', new Uint8Array([0, 255]), 'application/octet-stream'),
    file('skills/review/SKILL.md', markdown('review')),
  ])
  expect(result.request.skills?.map((skill) => skill.name)).toEqual(['review'])
  expect(result.requirements).toEqual([])
  expect(result.notices).toEqual([
    'Unsupported MCP bundle: ./server.mcpb',
    'Unsupported MCP bundle: https://example.test/other.dxt',
  ])
  expect(result.request.unsupported).toEqual(result.notices)
})

test('a nested plugin skill must match its directory and sends its exact entrypoint path', async () => {
  await expect(
    readSkillPackage([
      file('plugin.json', '{"name":"review-pack"}'),
      file('skills/wrong-directory/SKILL.md', markdown('review')),
    ]),
  ).rejects.toThrow('must match its directory')
  const root = await readSkillPackage([
    file('plugin.json', '{"name":"root-pack","skills":"."}'),
    file('SKILL.md', markdown('review')),
    file('skills/triage/SKILL.md', markdown('triage')),
  ])
  expect(root.request.skills?.map((skill) => skill.path)).toEqual([
    'SKILL.md',
    'skills/triage/SKILL.md',
  ])
})
