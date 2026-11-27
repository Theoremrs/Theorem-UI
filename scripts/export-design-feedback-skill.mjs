#!/usr/bin/env node
// Export the committed portable toolkit into an existing personal skill.
// Instructions live with the skill; executable source lives in this package.
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, readdir, writeFile, copyFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const destination = process.argv[2]
if (!destination || process.argv.length !== 3) {
  console.error('Usage: node scripts/export-design-feedback-skill.mjs /absolute/path/to/design-feedback')
  process.exit(2)
}
const skill = resolve(destination)
const instructions = await readFile(join(skill, 'SKILL.md'), 'utf8')
if (!/^name: design-feedback$/m.test(instructions)) throw new Error('Destination must be the existing design-feedback skill.')
const source = join(root, 'packages/design-feedback')
const names = (await readdir(source)).filter((name) => /\.(mjs|mts)$/.test(name) || ['package.json', 'package-lock.json'].includes(name)).sort()
const output = join(skill, 'scripts/toolkit')
await mkdir(output, { recursive: true })
const files = []
for (const name of names) {
  const bytes = await readFile(join(source, name))
  await writeFile(join(output, name), bytes)
  files.push({ path: name, sha256: createHash('sha256').update(bytes).digest('hex') })
}
await copyFile(join(root, 'LICENSE'), join(output, 'LICENSE'))
const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
const changed = execFileSync('git', ['status', '--porcelain', '--', 'packages/design-feedback'], { cwd: root, encoding: 'utf8' }).trim()
const manifest = {
  schemaVersion: 'design-feedback-bundle/v1',
  sourceRepository: 'https://github.com/Theoremrs/Theorem-UI',
  sourcePath: 'packages/design-feedback',
  sourceCommit,
  sourceDirty: changed.length > 0,
  files,
}
await writeFile(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
await writeFile(join(skill, 'scripts/feedback.mjs'), '#!/usr/bin/env node\nimport { main } from \'./toolkit/cli.mjs\'\nawait main()\n')
console.log(JSON.stringify({ skill, modules: files.length, sourceCommit, sourceDirty: manifest.sourceDirty }))
