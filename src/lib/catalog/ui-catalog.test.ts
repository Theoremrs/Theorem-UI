// SOURCING: bun:test over the catalog and the files it names. Components are
// checked by reading source text rather than importing, so the test needs no
// DOM or CSS loader (src/lib/modules tests render; this one only reads).
import { expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import pkg from '../../../package.json'
import { THEME_TOKENS, UI_CATALOG, describeUiCatalog } from './ui-catalog'

const src = join(import.meta.dir, '../..')
const declared: Record<string, string> = {
  ...pkg.dependencies,
  ...pkg.devDependencies,
}

const resolve = (importPath: string) => {
  const base = join(src, importPath.replace(/^@\//, ''))
  return ['.ts', '.tsx', '/index.ts', '/index.tsx']
    .map((ext) => base + ext)
    .find(existsSync)
}

const exportsName = (text: string, name: string) => {
  const code = text.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')
  if (name === 'default') return /\bexport\s+default\b/.test(code)
  const decl = new RegExp(
    `\\bexport\\s+(?:declare\\s+)?(?:async\\s+)?(?:const|let|function|class|type|interface|enum)\\s+${name}\\b`,
  )
  if (decl.test(code)) return true
  const lists =
    code.match(/\bexport\s+(?:type\s+)?(?:const\s+)?\{[^}]*\}/g) ?? []
  const word = new RegExp(`(^|[\\s,{])(?:\\w+\\s+as\\s+)?${name}\\s*(?=[,}])`)
  return lists.some((l) => word.test(l))
}

test('every importPath resolves and exports each listed symbol', () => {
  for (const entry of UI_CATALOG) {
    if (entry.importPath === null) continue
    const file = resolve(entry.importPath)
    expect(file, `${entry.purpose}: ${entry.importPath}`).toBeDefined()
    const text = readFileSync(file as string, 'utf8')
    for (const name of entry.exports) {
      expect(
        exportsName(text, name),
        `${entry.purpose}: ${entry.importPath} exports ${name}`,
      ).toBe(true)
    }
  }
})

test('library versions equal package.json', () => {
  for (const { library, purpose } of UI_CATALOG) {
    expect(declared[library.name], `${purpose}: ${library.name}`).toBe(
      library.version,
    )
  }
})

test('purposes are unique and every canonical entry has an import path or a direct-import note', () => {
  const purposes = UI_CATALOG.map((e) => e.purpose)
  expect(new Set(purposes).size).toBe(purposes.length)
  for (const e of UI_CATALOG) {
    expect(e.example.length).toBeGreaterThan(0)
    if (e.importPath === null) expect(e.notes.length).toBeGreaterThan(0)
  }
})

test('every theme token is defined in src/styles.css', () => {
  const css = readFileSync(join(src, 'styles.css'), 'utf8')
  for (const { name } of THEME_TOKENS) {
    const def = new RegExp(`^\\s*${name}\\s*:`, 'm')
    expect(def.test(css), name).toBe(true)
  }
})

test('describeUiCatalog round-trips through JSON', () => {
  const described = describeUiCatalog()
  expect(described.schema).toBe('theorem.ui-catalog/1')
  expect(JSON.parse(JSON.stringify(described))).toEqual(described)
})
