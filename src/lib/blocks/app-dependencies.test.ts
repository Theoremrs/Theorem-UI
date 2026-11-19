import { describe, expect, test } from 'bun:test'
import * as esbuild from 'esbuild-wasm'
import { tsc } from '@tsrs/wasm'
import { checkLibraryFromDisk } from '../../../test/blocks/check-library'
import { readFileSync } from 'node:fs'
import { appDependencies, AppDependencies } from './app-dependencies'
import { APP_LIBRARIES } from './app-libraries'
import { librarySources } from './app-library-sources'
import { libraryDeclarations } from './check/theorem-app.generated'
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

describe('an App that pins a React version in its own imports', () => {
  // A versioned import specifier is a React choice for the whole App, exactly as
  // a package.json one is: react-dom and the JSX runtime follow it, or the
  // bundle carries two Reacts and the App cannot render its own hooks.
  const app = (files: Record<string, string>) => ({ entry: 'main.tsx', files })

  /** The build error an App raises, or '' when it builds. */
  const refusal = (files: Record<string, string>) => {
    try {
      appDependencies(app(files))
      return ''
    } catch (error) {
      return (error as Error).message
    }
  }

  test('one pin is the App React for react-dom and the JSX runtime too', () => {
    const resolver = appDependencies(app({
      'main.tsx': `import { useState } from 'npm:react@18.3.1'
import { createRoot } from 'react-dom/client'
createRoot(document.body).render(<b>{useState(0)[0]}</b>)`,
    }))
    // Two copies of React cannot render one tree, so every one of these must
    // name the 18.3.1 build the App asked for; none may stay on the vendor path.
    const client = resolver.resolve('react-dom/client')
    expect(client.kind).toBe('url')
    expect(client.path).toContain('/react-dom@18.3.1/client?')
    expect(client.path).not.toContain('19.3.1')
    expect(resolver.resolve('react/jsx-runtime').path).toContain('/react@18.3.1/jsx-runtime?')
    expect(resolver.resolve('react').path).toContain('/react@18.3.1?')
    expect(resolver.resolve('npm:react@18.3.1').path).toContain('/react@18.3.1?')
    expect(resolver.resolve('react-dom').path).toContain('/react-dom@18.3.1?')
    expect(resolver.versions).toMatchObject({ react: '18.3.1' })
  })

  test('a react-dom pin decides react, and any import form can carry it', () => {
    const resolver = appDependencies(app({
      'lazy.tsx': `const load = () => import('npm:react-dom@18.3.1/client')`,
      'bare.ts': `import { useState } from 'react@18.3.1'`,
      'rest.ts': `import 'npm:react@18.3.1'
export const untouched = { from: 'npm:react@17.0.2' }`,
      'note.ts': `// the guide suggests 'npm:react@16.8.0' outside an import
export const hint = 'npm:react@16.8.0'`,
    }))
    expect(resolver.versions).toMatchObject({ react: '18.3.1', 'react-dom': '18.3.1' })
    expect(resolver.resolve('react').path).toContain('/react@18.3.1?')
    expect(resolver.resolve('react-dom/client').path).toContain('/react-dom@18.3.1/client?')
  })

  test('pinning the React Theorem vendors keeps the offline fast path', () => {
    const resolver = appDependencies(app({
      'main.tsx': `import { useState } from 'npm:react@19.3.1'
import { createRoot } from 'react-dom/client'`,
    }))
    expect(resolver.resolve('react').kind).toBe('vendor')
    expect(resolver.resolve('react/jsx-runtime').kind).toBe('vendor')
    expect(resolver.resolve('react-dom/client').kind).toBe('vendor')
  })

  test('an App that names no React version keeps the vendored React', () => {
    const resolver = appDependencies(app({
      'main.tsx': `import { useState } from 'react'
import { createRoot } from 'react-dom/client'`,
      'data.json': '{"from": "npm:react@17.0.2"}',
      'style.css': `@import 'npm:react@16.8.0'`,
    }))
    expect(resolver.versions).toEqual({})
    expect(resolver.resolve('react').kind).toBe('vendor')
    expect(resolver.resolve('react-dom/client').kind).toBe('vendor')
  })

  test('two explicit React versions are refused and both are named', () => {
    const text = refusal({
      'a.tsx': `import { useState } from 'npm:react@18.3.1'`,
      'b.tsx': `import { useId } from 'npm:react@19.0.0'`,
    })
    expect(text).toContain('One App must use one React version')
    expect(text).toContain('react@18.3.1 (a.tsx)')
    expect(text).toContain('react@19.0.0 (b.tsx)')
  })

  test('react and react-dom pinned apart are refused', () => {
    const text = refusal({
      'main.tsx': `import { useState } from 'npm:react@18.3.1'
import { createRoot } from 'npm:react-dom@19.0.0/client'`,
    })
    expect(text).toContain('One App must use one React version')
    expect(text).toContain('react@18.3.1')
    expect(text).toContain('react-dom@19.0.0')
  })

  test('an explicit pin that disagrees with package.json is refused', () => {
    const text = refusal({
      'main.tsx': `import { useState } from 'npm:react@18.3.1'`,
      'package.json': '{"dependencies":{"react":"19.3.1","react-dom":"19.3.1"}}',
    })
    expect(text).toContain('One App must use one React version')
    expect(text).toContain('react@18.3.1 (main.tsx)')
    expect(text).toContain('react@19.3.1 (package.json)')
  })

  test('a package.json range the pin matches leaves one exact React', () => {
    const files = {
      'main.tsx': `import { useState } from 'npm:react@18.3.1'`,
      'package.json': '{"dependencies":{"react":"^18.3.1","react-dom":"~18.3.1"}}',
    }
    expect(refusal(files)).toBe('')
    const resolver = appDependencies(app(files))
    // Both keys carry the pin, so every React URL in the bundle is the same build.
    expect(resolver.versions).toMatchObject({ react: '18.3.1', 'react-dom': '18.3.1' })
    expect(resolver.resolve('react-dom/client').path).toContain('/react-dom@18.3.1/client?')
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

test('unversioned package self aliases use the pinned published declaration root', async () => {
  const resolver = new AppDependencies({ '@fixture/core': '1.2.3' })
  const url = resolver.resolve('@fixture/core').path
  const remote = modules({
    [url]: { source: 'export const label = x => String(x)', types: 'https://esm.sh/@fixture/core@1.2.3/X-args/dist/index.d.ts' },
    'https://esm.sh/@fixture/core@1.2.3/X-args/dist/index.d.ts': { source: 'import type { Count } from "https://esm.sh/@fixture/core/types/count"; export declare function label(value: Count): string;' },
    'https://esm.sh/@fixture/core@1.2.3/X-args/dist/types/count.d.ts': { source: 'export type Count = number;' },
  })
  const sources = { entry: 'main.ts', files: {
    'main.ts': 'import { label } from "@fixture/core"; const wrong: string = label("wrong");',
  } }
  const declarations = await dependencyDeclarations(sources, new AppDependencies(resolver.versions, remote.request))
  expect(declarations.problems).toEqual([])
  expect(remote.requested).toContain('https://esm.sh/@fixture/core@1.2.3/X-args/dist/types/count.d.ts')
  expect(remote.requested).not.toContain('https://esm.sh/@fixture/core/types/count')
  const result = await checkAppSources(sources, tsc, library, {}, declarations)
  expect(result.problems).toHaveLength(1)
  expect(result.problems[0]).toMatchObject({ file: 'main.ts', code: 'TS2345' })
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

test('a .wasm import is the module\'s bytes: bundled into the App and typed as Uint8Array', async () => {
  const header = '\0asm\x01\0\0\0'
  const remote = modules({ 'https://modules.example/engine.wasm': { source: header } })
  const sources = { entry: 'main.ts', files: { 'main.ts': [
    'import bytes from "https://modules.example/engine.wasm";',
    'const length: number = bytes.byteLength;',
    'const wrong: string = bytes;',
    'export { length, wrong }',
  ].join('\n') } }
  const bundle = await bundleAppSources(sources, esbuild, new AppDependencies({}, remote.request))
  // esbuild's binary loader embeds the bytes (base64) and decodes them at run time.
  expect(bundle.code).toContain(btoa(header))
  const declarations = await dependencyDeclarations(sources, new AppDependencies({}, remote.request))
  expect(declarations.problems).toEqual([])
  const result = await checkAppSources(sources, tsc, library, {}, declarations)
  expect(result.problems.map((p) => [p.file, p.line, p.code])).toEqual([['main.ts', 3, 'TS2322']])
  expect(result.problems[0]!.message).toContain('Uint8Array')
}, 120_000)

test('a ?worker import is that file bundled on its own, started from a blob URL', async () => {
  const sources = { entry: 'main.ts', files: {
    'main.ts': [
      'import url from "./work.ts?worker";',
      'const worker = new Worker(url);',
      'const wrong: number = url;',
      'export { worker, wrong }',
    ].join('\n'),
    'work.ts': 'import { double } from "./math"\nawait 0\nself.postMessage(double(21))\nexport const unused = 1',
    'math.ts': 'export const double = (n: number) => n * 2',
  } }
  const bundle = await bundleAppSources(sources, esbuild, new AppDependencies({}, modules({}).request))
  expect(bundle.code).toContain('URL.createObjectURL(new Blob(')
  // The worker's own module, with what it imports, is inside the blob as a
  // classic script: top-level await kept inside an async function, no export.
  const script = JSON.parse(/new Blob\(\[("(?:[^"\\]|\\.)*")\]/.exec(bundle.code)![1]!) as string
  expect(script).toMatch(/postMessage\(double\(21\)\)/)
  expect(script).toStartWith('(async () => {')
  expect(script).not.toMatch(/^export /m)
  expect(() => new Function(script)).not.toThrow()
  const declarations = await dependencyDeclarations(sources, new AppDependencies({}, modules({}).request))
  const result = await checkAppSources(sources, tsc, library, {}, declarations)
  expect(result.problems.map((p) => [p.file, p.line, p.code])).toEqual([['main.ts', 3, 'TS2322']])
  // A worker file that does not build is reported at its own line.
  const broken = { ...sources, files: { ...sources.files, 'work.ts': 'self.postMessage(1\nconst' } }
  const failure = await bundleAppSources(broken, esbuild, new AppDependencies({}, modules({}).request)).catch((error: unknown) => error)
  expect(failure).toBeInstanceOf(AppBuildError)
  expect((failure as AppBuildError).problems[0]).toMatchObject({ kind: 'build', file: 'work.ts' })
}, 120_000)

describe('a library Theorem ships', () => {
  const SPATIAL_APP = `import { mount, parts, type Part } from '@theorem/spatial'
const lamp: Part = {
  id: 'lamp',
  label: 'Lamp',
  form: (three) => new three.TorusKnotGeometry(0.4),
  ports: { power: 'in', light: 'out' },
  compute: ({ power }) => ({ light: power ? 1 : 0 }),
  show: (object, { values }) => { object.name = String(values.light) },
}
const model = mount(document.body, (m) => {
  m.part(parts.gate({ id: 'switch', kind: 'and' }))
  m.part(lamp)
  m.wire('switch.out', 'lamp.power')
  m.part({ id: 'bad', ports: { a: 'sideways' } })
}, { remember: 'model' })
model.open('lamp')`

  test('pins the packages it is built on unless the App names a version', () => {
    expect(appDependencies({ entry: 'main.ts', files: { 'main.ts': SPATIAL_APP } }).versions)
      .toEqual(APP_LIBRARIES['@theorem/spatial']!.dependencies)
    expect(appDependencies({ entry: 'main.ts', files: {
      'main.ts': SPATIAL_APP,
      'package.json': '{"dependencies":{"three":"0.188.0"}}',
    } }).versions).toMatchObject({ three: '0.188.0', elkjs: '0.12.1', '@floating-ui/core': '1.8.0' })
    expect(new AppDependencies().resolve('@theorem/spatial'))
      .toEqual({ kind: 'library', path: '@theorem/spatial' })
    expect(new AppDependencies().resolve('@theorem/annotate'))
      .toEqual({ kind: 'library', path: '@theorem/annotate' })
  })

  test('pins the versions Theorem builds and checks it with', () => {
    const installed = (name: string) =>
      (JSON.parse(readFileSync(new URL(`../../../node_modules/${name}/package.json`, import.meta.url), 'utf8')) as { version: string }).version
    for (const library of Object.values(APP_LIBRARIES))
      for (const [name, version] of Object.entries(library.dependencies))
        expect([name, installed(name)]).toEqual([name, version])
  })

  test('names the packages its declarations import', () => {
    for (const [name, library] of Object.entries(APP_LIBRARIES)) {
      const imported = new Set<string>()
      for (const text of Object.values(libraryDeclarations[name] ?? {}))
        for (const [, specifier] of text.matchAll(/(?:from|import\()\s*['"]([^'"]+)['"]/g))
          if (!specifier!.startsWith('.') && !Object.hasOwn(APP_LIBRARIES, specifier!)) imported.add(specifier!)
      expect([name, [...imported].sort()]).toEqual([name, [...library.types].sort()])
    }
  })

  test('bundles a library written in TSX with its stylesheets', async () => {
    const sources = { entry: 'main.tsx', files: { 'main.tsx': `import { anchorStore, AnnotationLayer, Annotation, Note } from '@theorem/annotate'
import { createRoot } from 'react-dom/client'
const anchors = anchorStore()
createRoot(document.body).render(<AnnotationLayer anchors={anchors}><Annotation anchor="a"><Note title="A" /></Annotation></AnnotationLayer>)` } }
    const remote = modules({})
    const resolver = new AppDependencies(appDependencies(sources).versions, async (input) => {
      const url = String(input)
      if (url.startsWith('https://esm.sh/')) return fetch(url)
      return remote.request(input)
    })
    const bundle = await bundleAppSources(sources, esbuild, resolver)
    expect(bundle.css).toContain('.tn-layer')
    expect(bundle.css).toContain('data-astryx-theme')
    // Which of these elements are stamped is seen at run time (scripts/e2e/spatial.mjs).
    expect(bundle.code).toContain('theorem-app:main.tsx')
  }, 120_000)

  test('registers every module a library\'s own files import', () => {
    const missing: Array<string> = []
    for (const [library, files] of Object.entries(librarySources))
      for (const [file, source] of Object.entries(files))
        for (const [, name] of source.matchAll(/(?:from|import)\s+'\.\/([^']+)'/g)) {
          const stem = name!.replace(/\?raw$/, '')
          const found = [stem, `${stem}.ts`, `${stem}.tsx`].some((candidate) => candidate in files)
          if (!found) missing.push(`${library}/${file} imports ./${name}`)
        }
    expect(missing).toEqual([])
  })

  test('bundles the runtime library with every module its entry exports', async () => {
    const sources = { entry: 'main.ts', files: { 'main.ts': `import { integerText, Operations, resultRef } from '@theorem/runtime'
document.body.textContent = [integerText(2n ** 64n), typeof Operations, typeof resultRef].join(' ')` } }
    const remote = modules({})
    const bundle = await bundleAppSources(sources, esbuild, new AppDependencies({}, remote.request))
    expect(bundle.code).toContain('theorem.operation')
    expect(remote.requested).toEqual([])
  }, 120_000)

  test('is checked against its declarations and the three.js it is pinned to', async () => {
    const pins = { three: '0.187.0', '@rerun-io/web-viewer': '0.35.0' }
    const resolver = new AppDependencies(pins)
    const threeUrl = resolver.resolve('three').path
    const rerunUrl = resolver.resolve('@rerun-io/web-viewer').path
    const rerunTypes = 'https://esm.sh/@rerun-io/web-viewer@0.35.0/index.d.ts'
    const remote = modules({
      // The timeline in the spatial library is checked against the viewer's own declarations.
      [rerunUrl]: { source: 'export {}', types: rerunTypes },
      [rerunTypes]: { source: readFileSync('node_modules/@rerun-io/web-viewer/index.d.ts', 'utf8') },
      [threeUrl]: { source: 'export {}', types: 'https://esm.sh/@types/three@0.187.0/index.d.ts' },
      'https://esm.sh/@types/three@0.187.0/index.d.ts': { source: `export declare class Object3D { name: string }
export declare class BufferGeometry { name: string }
export declare class Mesh extends Object3D { constructor(geometry?: BufferGeometry) }
export declare class TorusKnotGeometry extends BufferGeometry { constructor(radius?: number) }` },
    })
    const sources = { entry: 'main.ts', files: { 'main.ts': SPATIAL_APP } }
    const dependencies = await dependencyDeclarations(sources, new AppDependencies(pins, remote.request))
    expect(dependencies.problems).toEqual([])
    expect(remote.requested).toContain(threeUrl)
    expect(remote.requested).toContain(rerunUrl)
    const result = await checkAppSources(sources, tsc, library, {}, dependencies)
    expect(result.problems.map((p) => [p.file, p.line, p.code])).toEqual([['main.ts', 14, 'TS2322']])
  }, 120_000)
})
