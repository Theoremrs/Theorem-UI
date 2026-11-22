// SOURCING: Agent Skills' SKILL.md layout, https://code.claude.com/docs/en/plugins-reference, and yaml.
// Only files the person selected are read; manifest paths never cause a fetch.
import { parseDocument } from 'yaml'
import type {
  ImportedSkill,
  SkillFile,
  SkillImport,
} from '@/lib/theorem/skill-installations'

const MAX_IMPORT = 8 * 1024 * 1024
const MAX_FILE = 2 * 1024 * 1024
const MAX_SKILL = 256 * 1024
const MAX_FILES = 256
type SelectedFile = Pick<
  File,
  'name' | 'size' | 'type' | 'text' | 'arrayBuffer'
> & { webkitRelativePath?: string }
export type PreparedImport = {
  name: string
  kind: 'skill' | 'plugin'
  version?: string
  request: SkillImport
  requirements: string[]
  notices: string[]
}

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

/** Package paths must stay inside the selected directory. */
function localPath(raw: string): string {
  const path = raw.replace(/^\.\//, '').replace(/\/$/, '')
  if (
    !path ||
    path.startsWith('/') ||
    path.includes('\\') ||
    path.split('/').some((part) => !part || part === '.' || part === '..') ||
    Array.from(path).some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    ) ||
    /^[a-z]+:/i.test(path)
  )
    throw new Error(`This package names a path outside its folder: ${raw}`)
  return path
}

function json(text: string, path: string): Record<string, unknown> {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new Error(`${path} is not valid JSON.`)
  }
  if (!object(value)) throw new Error(`${path} must contain a JSON object.`)
  return value
}

function skillName(markdown: string, path: string): string {
  const front = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown)
  if (!front)
    throw new Error(
      `${path} needs YAML frontmatter with a name and description.`,
    )
  const document = parseDocument(front[1]!)
  if (document.errors.length)
    throw new Error(`${path} has invalid YAML frontmatter.`)
  const value: unknown = document.toJS({ maxAliasCount: 20 })
  if (!object(value) || typeof value.name !== 'string' || !value.name.trim())
    throw new Error(`${path} needs a name in its frontmatter.`)
  return value.name.trim()
}

async function supportingFile(
  path: string,
  file: SelectedFile,
): Promise<SkillFile> {
  const mimeType = file.type || undefined
  const text =
    file.type.startsWith('text/') ||
    /\.(md|txt|json|ya?ml|toml|csv|tsv|py|sh|bash|js|ts|tsx|jsx|html|css|svg|xml|rs|sql)$/i.test(
      path,
    )
  if (text)
    return {
      path,
      content: await file.text(),
      ...(mimeType ? { mimeType } : {}),
    }
  const bytes = new Uint8Array(await file.arrayBuffer())
  let binary = ''
  for (let at = 0; at < bytes.length; at += 8192)
    binary += String.fromCharCode(...bytes.subarray(at, at + 8192))
  return { path, base64: btoa(binary), ...(mimeType ? { mimeType } : {}) }
}

/** Prepare a standalone skill folder or a Claude plugin folder for review. */
export async function readSkillPackage(
  selected: readonly SelectedFile[],
): Promise<PreparedImport> {
  if (!selected.length)
    throw new Error('Choose a SKILL.md file or a plugin folder.')
  if (selected.reduce((sum, file) => sum + file.size, 0) > MAX_IMPORT)
    throw new Error('The selected package is larger than 8 MiB.')
  if (selected.some((file) => file.size > MAX_FILE))
    throw new Error('Each supporting file must be 2 MiB or smaller.')
  const first = selected[0]!
  const folder = first.webkitRelativePath?.split('/')[0]
  const files = new Map<string, SelectedFile>()
  for (const file of selected) {
    const relative = file.webkitRelativePath || file.name
    const path = localPath(
      folder && relative.startsWith(folder + '/')
        ? relative.slice(folder.length + 1)
        : relative,
    )
    if (files.has(path))
      throw new Error(`The package contains two files named ${path}.`)
    files.set(path, file)
  }
  const used = new Set<string>()
  let supportCount = 0
  const collect = async (
    path: string,
    allSkillPaths: string[],
  ): Promise<ImportedSkill> => {
    const file = files.get(path)!
    if (file.size > MAX_SKILL)
      throw new Error(`${path} is larger than 256 KiB.`)
    const markdown = await file.text()
    const name = skillName(markdown, path)
    const segments = path.split('/')
    if (segments.at(-1) !== 'SKILL.md')
      throw new Error(`${path} must be named SKILL.md.`)
    const parent = segments.at(-2)
    if (parent && parent !== name)
      throw new Error(
        `${path}: the skill name "${name}" must match its directory "${parent}".`,
      )
    used.add(path)
    const prefix = path.includes('/')
      ? path.slice(0, path.lastIndexOf('/') + 1)
      : ''
    const children: SkillFile[] = []
    for (const [child, source] of files) {
      if (used.has(child) || !child.startsWith(prefix)) continue
      if (
        allSkillPaths.some((other) => {
          const root = other.slice(0, other.lastIndexOf('/') + 1)
          return (
            other !== path &&
            root.length > prefix.length &&
            child.startsWith(root)
          )
        })
      )
        continue
      if (++supportCount > MAX_FILES)
        throw new Error('A package may include at most 256 supporting files.')
      children.push(await supportingFile(child.slice(prefix.length), source))
      used.add(child)
    }
    return {
      name,
      markdown,
      path,
      ...(children.length ? { files: children } : {}),
    }
  }
  const manifestPath = ['.claude-plugin/plugin.json', 'plugin.json'].find(
    (path) => files.has(path),
  )
  if (!manifestPath) {
    const path = [...files.keys()].find(
      (name) => name.toLowerCase() === 'skill.md',
    )
    if (!path)
      throw new Error(
        'Choose a skill folder containing SKILL.md, or a plugin folder containing .claude-plugin/plugin.json.',
      )
    const skill = await collect(path, [path])
    return {
      name: skill.name,
      kind: 'skill',
      requirements: [],
      notices: [],
      request: {
        source: `file:${folder ?? first.name}`,
        markdown: skill.markdown,
        ...(skill.files ? { files: skill.files } : {}),
      },
    }
  }

  const manifest = json(await files.get(manifestPath)!.text(), manifestPath)
  used.add(manifestPath)
  if (typeof manifest.name !== 'string' || !manifest.name.trim())
    throw new Error('The plugin manifest needs a name.')
  const name = manifest.name.trim()
  const readJson = async (raw: string) => {
    const path = localPath(raw)
    const file = files.get(path)
    if (!file)
      throw new Error(`The manifest names ${path}, which was not selected.`)
    used.add(path)
    return json(await file.text(), path)
  }
  const unsupported: string[] = []
  const serverMap = async (
    value: unknown,
  ): Promise<Record<string, unknown>> => {
    if (typeof value === 'string') {
      if (/\.(mcpb|dxt)$/i.test(value)) {
        if (!value.startsWith('https://')) {
          const path = localPath(value)
          if (!files.has(path))
            throw new Error(
              `The manifest names ${path}, which was not selected.`,
            )
          used.add(path)
        }
        unsupported.push(`Unsupported MCP bundle: ${value}`)
        return {}
      }
      const read = await readJson(value)
      return object(read.mcpServers) ? read.mcpServers : read
    }
    if (Array.isArray(value)) {
      const entries = new Map<string, unknown>()
      for (const part of value) {
        for (const [serverName, config] of Object.entries(
          await serverMap(part),
        )) {
          entries.set(serverName, config)
        }
      }
      return Object.fromEntries(entries)
    }
    if (object(value)) return value
    throw new Error(
      'The MCP server declaration must be an object or a local JSON path.',
    )
  }
  const configs = [
    ...(files.has('.mcp.json') ? ['.mcp.json'] : []),
    ...(manifest.mcpServers !== undefined ? [manifest.mcpServers] : []),
  ]
  if (configs.length) manifest.mcpServers = await serverMap(configs)

  const roots = ['skills']
  if (manifest.skills !== undefined) {
    const declared = Array.isArray(manifest.skills)
      ? manifest.skills
      : [manifest.skills]
    for (const entry of declared) {
      if (typeof entry !== 'string')
        throw new Error('Plugin skill paths must be local folder names.')
      const path = entry === '.' || entry === './' ? '' : localPath(entry)
      if (
        path &&
        ![...files.keys()].some(
          (file) => file === path || file.startsWith(path + '/'),
        )
      )
        throw new Error(`The manifest names ${path}, which was not selected.`)
      roots.push(path)
    }
  }
  const paths = [...files.keys()].filter(
    (path) =>
      /(^|\/)SKILL\.md$/i.test(path) &&
      roots.some(
        (root) => !root || path === root || path.startsWith(root + '/'),
      ),
  )
  if (paths.length > 64)
    throw new Error('A plugin may include at most 64 skills.')
  const skills: ImportedSkill[] = []
  for (const path of paths) skills.push(await collect(path, paths))
  const notices = [
    ...unsupported,
    ...[...files.keys()]
      .filter((path) => !used.has(path))
      .map((path) => `File outside installed skills: ${path}`),
  ]
  const components: Record<string, string> = {
    hooks: 'hooks/',
    agents: 'agents/',
    commands: 'commands/',
    lspServers: '.lsp.json',
    outputStyles: 'output-styles/',
    workflows: 'workflows/',
    settings: 'settings.json',
  }
  for (const key of [
    ...Object.keys(components),
    'dependencies',
    'userConfig',
    'channels',
    'experimental',
  ])
    if (
      manifest[key] != null ||
      [...files.keys()].some((path) => {
        const location = components[key]
        return (
          location &&
          (location.endsWith('/')
            ? path.startsWith(location)
            : path === location)
        )
      })
    )
      notices.unshift(`Unsupported contribution: ${key}`)
  if (notices.length > 256 || notices.some((notice) => notice.length > 512))
    throw new Error(
      'This folder contains too many unrelated files. Choose the plugin package folder.',
    )
  const repository =
    typeof manifest.repository === 'string'
      ? manifest.repository
      : object(manifest.repository) &&
          typeof manifest.repository.url === 'string'
        ? manifest.repository.url
        : undefined
  return {
    name,
    kind: 'plugin',
    ...(typeof manifest.version === 'string'
      ? { version: manifest.version }
      : {}),
    requirements: object(manifest.mcpServers)
      ? Object.keys(manifest.mcpServers)
      : [],
    notices,
    request: {
      source: repository || `folder:${folder ?? name}`,
      manifest,
      skills,
      unsupported: notices,
    },
  }
}
