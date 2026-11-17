import { describe, expect, test } from 'bun:test'
import * as esbuild from 'esbuild-wasm'
import { tsc } from '@tsrs/wasm'
import { checkLibraryFromDisk } from '../../../test/blocks/check-library'
import { appDependencies, AppDependencies } from './app-dependencies'
import type { AppDependencyFetch } from './app-dependencies'
import { dependencyDeclarations } from './app-dependency-types'
import { checkAppSources } from './app-check'
import { AppBuildError } from './app-source'
import { bundleAppSources } from './export'

const library = checkLibraryFromDisk()

function modules(entries: Record<string, { source: string; types?: string; url?: string }>) {
  const requested: Array<string> = []
  const request: AppDependencyFetch = async (input) => {
    const url = String(input)
    requested.push(url)
    const entry = entries[url]
    const response = new Response(entry?.source ?? 'Not found', {
      status: entry ? 200 : 404,
      headers: entry?.types ? { 'x-typescript-types': entry.types } : {},
    })
    Object.defineProperty(response, 'url', { value: entry?.url ?? url })
    return response
  }
  return { request, requested }
}

describe('App dependency resolution', () => {
  test('the vendored modules are a fast path, and packages outside them resolve normally', () => {
    const resolver = new AppDependencies({ '@luma.gl/core': '9.2.3' })
    expect(resolver.resolve('react').kind).toBe('vendor')
    expect(resolver.resolve('react-dom').kind).toBe('vendor')
    expect(resolver.resolve('react-dom/server').path).toContain('/react-dom@19.3.1/server?')
    expect(resolver.resolve('npm:react@19.3.1').kind).toBe('vendor')
    expect(resolver.resolve('@observablehq/plot@0.6.19').kind).toBe('vendor')
    const luma = resolver.resolve('@luma.gl/core')
    expect(luma.kind).toBe('url')
    const url = new URL(luma.path)
    expect(url.pathname).toBe('/@luma.gl/core@9.2.3')
    expect(url.searchParams.get('external')).toBe('react,react-dom')
    expect(resolver.resolve('npm:some-browser-package@2.4.0/widgets').path)
      .toContain('/some-browser-package@2.4.0/widgets?')
    expect(resolver.resolve('https://modules.example/widget.js').path)
      .toBe('https://modules.example/widget.js')
    expect(resolver.resolve('../other.js', 'https://modules.example/v1/sub/entry.js').path)
      .toBe('https://modules.example/v1/other.js')
  })

  test('explicit package versions take precedence over the vendored version', () => {
    const resolver = new AppDependencies({ react: '18.3.1', alias: 'npm:real-package@1.2.3' })
    expect(resolver.resolve('react/jsx-runtime').path).toContain('/react@18.3.1/jsx-runtime?')
    expect(resolver.resolve('react-dom/client').path).toContain('/react-dom@18.3.1/client?')
    expect(resolver.resolve('react-dom').path).toContain('/react-dom@18.3.1?')
    expect(resolver.resolve('alias/subpath').path).toContain('/real-package@1.2.3/subpath?')
  })

  test('build and check share one resolution session for the same package.json versions', () => {
    const sources = { entry: 'main.ts', files: { 'main.ts': '', 'package.json': '{"dependencies":{"pkg":"1.0.0"}}' } }
    expect(appDependencies(sources)).toBe(appDependencies({ ...sources, files: { ...sources.files, 'main.ts': 'export {}' } }))
    expect(() => appDependencies({ entry: 'main.ts', files: { 'main.ts': '', 'package.json': '{broken' } })).toThrow('package.json')
  })

  test('canonical response content is cached and failures can be retried', async () => {
    const remote = modules({ 'https://modules.example/latest.js': { source: 'export const n=1', url: 'https://modules.example/v1.js' } })
    const resolver = new AppDependencies({}, remote.request)
    const first = await resolver.load('https://modules.example/latest.js')
    expect(await resolver.load('https://modules.example/v1.js')).toBe(first)
    expect(remote.requested).toHaveLength(1)
    for (let attempt = 0; attempt < 2; attempt++)
      await expect(resolver.load('https://modules.example/missing.js')).rejects.toThrow('HTTP 404')
    expect(remote.requested.filter((url) => url.endsWith('missing.js'))).toHaveLength(2)
  })
})

test('arbitrary TSX components, relative files and nonvendored dependencies use the real App compiler', async () => {
  const remote = modules({
    'https://modules.example/particles.js': {
      source: 'export { particleCount } from "./count.js"',
    },
    'https://modules.example/count.js': { source: 'export const particleCount = 37' },
  })
  const bundle = await bundleAppSources({ entry: 'main.tsx', files: {
    'main.tsx': 'import { createRoot } from "react-dom/client"; import { ParticleWorkbench } from "./components/ParticleWorkbench.tsx"; createRoot(document.getElementById("root")!).render(<ParticleWorkbench title="Custom" />)',
    'components/ParticleWorkbench.tsx': 'import { useState } from "react"; import { particleCount } from "https://modules.example/particles.js"; export function ParticleWorkbench({title}: {title: string}) { const [count, setCount] = useState(particleCount); return <button onClick={() => setCount(count + 1)}>{title}: {count}</button> }',
  } }, esbuild, new AppDependencies({}, remote.request))
  expect(bundle.code).toContain('ParticleWorkbench')
  expect(bundle.code).toContain('37')
  expect(bundle.code).not.toContain('https://modules.example/particles.js";')
  expect(JSON.parse(bundle.map).sources).toContain('components/ParticleWorkbench.tsx')
}, 60_000)

test('remote component CSS imports and relative fonts are bundled into the App', async () => {
  const remote = modules({
    'https://modules.example/theme.css': { source: '@import "./reset.css"; @font-face { font-family: Custom; src: url("./font.woff2") } .widget { font-family: Custom; background-image: url("data:image/svg+xml,%3Csvg/%3E") }' },
    'https://modules.example/reset.css': { source: '.widget { box-sizing: border-box }' },
    'https://modules.example/font.woff2': { source: 'font bytes' },
  })
  const bundle = await bundleAppSources({ entry: 'main.ts', files: {
    'main.ts': 'import "https://modules.example/theme.css"; document.body.className = "widget";',
  } }, esbuild, new AppDependencies({}, remote.request))
  expect(bundle.css).toContain('border-box')
  // esbuild chooses the shorter encoding; printable test bytes may use a
  // URL-encoded payload while an actual binary font normally uses base64.
  const embedded = /url\(data:font\/woff2(;base64)?,([^)]*)\)/.exec(bundle.css)
  expect(embedded).not.toBeNull()
  const payload = embedded![1]
    ? atob(embedded![2]!)
    : decodeURIComponent(embedded![2]!.replace(/\\(.)/g, '$1'))
  expect(payload).toBe('font bytes')
  expect(bundle.css).not.toContain('url("./font.woff2")')
  expect(remote.requested.sort()).toEqual([
    'https://modules.example/font.woff2',
    'https://modules.example/reset.css',
    'https://modules.example/theme.css',
  ])
}, 60_000)

test('a missing external module reports the requesting App file and URL', async () => {
  const remote = modules({})
  try {
    await bundleAppSources({ entry: 'main.ts', files: { 'main.ts': 'import "https://modules.example/absent.js"' } }, esbuild, new AppDependencies({}, remote.request))
    throw new Error('Expected a build error')
  } catch (error) {
    expect(error).toBeInstanceOf(AppBuildError)
    expect((error as AppBuildError).problems[0]).toMatchObject({ file: 'main.ts', line: 1 })
    expect((error as AppBuildError).message).toContain('https://modules.example/absent.js: HTTP 404')
  }
})

test('external declarations and their relative imports are checked by tsrs', async () => {
  const url = new AppDependencies().resolve('typed-browser-library@1.0.0').path
  const remote = modules({
    [url]: { source: 'export const label = x => String(x)', types: 'https://modules.example/index.d.ts' },
    'https://modules.example/index.d.ts': { source: 'import type { Count } from "./types.js"; export declare function label(value: Count): string;' },
    'https://modules.example/types.d.ts': { source: 'export type { Count } from "./count";' },
    'https://modules.example/count.d.ts': { source: 'export type Count = number;' },
  })
  const sources = { entry: 'main.ts', files: {
    'main.ts': 'import { label } from "typed-browser-library@1.0.0";\nconst wrong: string = label("not a number");',
  } }
  const dependencies = await dependencyDeclarations(sources, new AppDependencies({}, remote.request))
  expect(dependencies.problems).toEqual([])
  const result = await checkAppSources(sources, tsc, library, {}, dependencies)
  expect(result.problems).toHaveLength(1)
  expect(result.problems[0]).toMatchObject({ file: 'main.ts', line: 2, code: 'TS2345' })
}, 120_000)

test('a type-only dependency is resolved and missing types are reported without ambient any', async () => {
  const url = new AppDependencies().resolve('untyped-browser-library@1.0.0').path
  const remote = modules({ [url]: { source: 'export const n = 1' } })
  const dependencies = await dependencyDeclarations({ entry: 'main.ts', files: {
    'main.ts': 'import type { Thing } from "untyped-browser-library@1.0.0"; export const n = 1;',
  } }, new AppDependencies({}, remote.request))
  expect(remote.requested).toEqual([url])
  expect(dependencies.problems[0]).toMatchObject({ file: 'main.ts', code: 'APP_DEPENDENCY_TYPES' })
  expect(dependencies.problems[0]!.message).toContain('can run')
  expect(dependencies.files).toEqual({})
  expect(dependencies.paths).toEqual({})
})

test('an author can supply local declarations for an untyped HTTPS module', async () => {
  const remote = modules({ 'https://modules.example/custom.js': { source: 'export const n = 1' } })
  const sources = { entry: 'main.ts', files: {
    'main.ts': 'import { n } from "https://modules.example/custom.js"; const wrong: string = n;',
    'types.d.ts': 'declare module "https://modules.example/custom.js" { export const n: number }',
  } }
  const declarations = await dependencyDeclarations(sources, new AppDependencies({}, remote.request))
  expect(declarations.problems).toEqual([])
  const result = await checkAppSources(sources, tsc, library, {}, declarations)
  expect(result.problems[0]).toMatchObject({ file: 'main.ts', code: 'TS2322' })
}, 120_000)

test('CSS, embedded assets and JSON use their actual bundle types', async () => {
  const remote = modules({
    'https://modules.example/style.css?v=1': { source: 'body { color: red }' },
    'https://modules.example/logo.svg': { source: '<svg></svg>' },
    'https://modules.example/data.json': { source: '{"count":3}' },
  })
  const sources = { entry: 'main.ts', files: { 'main.ts': [
    'import "https://modules.example/style.css?v=1";',
    'import logo from "https://modules.example/logo.svg";',
    'import data from "https://modules.example/data.json";',
    'const asset: string = logo; const count: string = data.count;',
  ].join('\n') } }
  const declarations = await dependencyDeclarations(sources, new AppDependencies({}, remote.request))
  expect(declarations.problems).toEqual([])
  const result = await checkAppSources(sources, tsc, library, {}, declarations)
  expect(result.problems).toHaveLength(1)
  expect(result.problems[0]).toMatchObject({ file: 'main.ts', line: 4, code: 'TS2322' })
}, 120_000)
