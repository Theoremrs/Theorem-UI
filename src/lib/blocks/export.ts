// SOURCING: esbuild-wasm (bundles the compiled tool, the sandbox runtime and
// the vendored modules it imports into one module, in the page), picomatch
// (the files the tool declared), the bridge's own decoder (CSV rows as a frame
// gets them), Web Crypto (the inline script's hash for the page's policy).
// The export is plan D9's standalone HTML: the tool, its declared files and
// state, and nothing else, under the same policy a block frame has.
import { decode, encode } from '@jridgewell/sourcemap-codec'
import type * as Esbuild from 'esbuild-wasm'
import picomatch from 'picomatch'
import type { WorkspaceClient } from '@/lib/workspace/types'
import { checkPath, decodeFile } from './bridge'
import type { StateCollections } from './bridge'
import { AppBuildError } from './app-source'
import type { AppProblem, AppSources } from './app-source'
import { appDependencies } from './app-dependencies'
import type { AppDependencies } from './app-dependencies'
import { compileCell } from './compile'
import type { CompiledCell } from './compile'
import { BLOCK_DOCUMENT_STYLE } from './document'
import { runtimeSources } from './runtime-sources'
import type { ExportedData } from './sandbox/standalone'
import { encodeRows } from './sandbox/standalone'
import { toBase64 } from './state'
import { importMap } from './vendor/manifest'
import { vendorModules } from './vendor/modules'
import { libraryModule } from './app-library-sources'
import { canonicalJson, digestBytes } from './artifact-runtime'

type Bundler = Pick<typeof Esbuild, 'build'>

export interface ExportOptions {
  /** The workspace's state, whose declared collections the export carries. */
  state: StateCollections
  /** esbuild; the page's wasm build unless given (tests pass Bun's). */
  esbuild?: () => Promise<Bundler>
  compile?: (source: string) => Promise<CompiledCell>
}

export interface ExportedTool {
  /** Where the page was written, `Exports/<name>.html`. */
  path: string
  bytes: number
}

/** The most file data one export carries. */
export const MAX_EXPORT_BYTES = 10 * 1024 * 1024

let browserBuild: Promise<Bundler> | null = null

/** esbuild-wasm in the page, its wasm served with the app's own assets. */
export function browserEsbuild(): Promise<Bundler> {
  browserBuild ??= (async () => {
    const [esbuild, wasm] = await Promise.all([
      import('esbuild-wasm'),
      import('esbuild-wasm/esbuild.wasm?url'),
    ])
    await esbuild.initialize({ wasmURL: wasm.default })
    return esbuild
  })()
  return browserBuild
}

const NAMESPACE = {
  entry: 'theorem',
  runtime: 'theorem-runtime',
  vendor: 'theorem-vendor',
  app: 'theorem-app',
  dependency: 'theorem-app-dependency',
  library: 'theorem-library',
  worker: 'theorem-app-worker',
  implementation: 'theorem-app-implementation',
}

/**
 * The digest of the modules a build read (esbuild's metafile inputs, as
 * `namespace:path`): an App file or library module by the SHA-256 of its text,
 * anything else by its path, which for a dependency is its exact pinned URL.
 */
export async function implementationDigest(
  files: Record<string, string>,
  inputs: Array<string>,
): Promise<`sha256:${string}`> {
  const encoder = new TextEncoder()
  const read: Record<string, string> = {}
  for (const input of inputs) {
    const colon = input.indexOf(':')
    const namespace = colon < 0 ? '' : input.slice(0, colon)
    const path = colon < 0 ? input : input.slice(colon + 1)
    if (
      (namespace === NAMESPACE.app || namespace === NAMESPACE.worker) &&
      Object.hasOwn(files, path)
    ) {
      read[input] = await digestBytes(encoder.encode(files[path]))
      continue
    }
    if (namespace === NAMESPACE.library) {
      const slash = path.lastIndexOf('/')
      const module = libraryModule(path.slice(0, slash), path.slice(slash + 1))
      if (module) {
        read[input] = await digestBytes(encoder.encode(module.source))
        continue
      }
    }
    read[input] = input
  }
  return digestBytes(encoder.encode(canonicalJson(read)))
}

/** A bare import, through the import map, to the vendored file that serves it. */
function vendored(path: string): Esbuild.OnResolveResult {
  const imports: Record<string, string> = importMap.imports
  const served = Object.hasOwn(imports, path) ? imports[path]! : path
  if (Object.hasOwn(vendorModules, served))
    return { path: served, namespace: NAMESPACE.vendor }
  return {
    errors: [{ text: `"${path}" is not in the blocks' import map` }],
  }
}

/**
 * Resolves the entry and the compiled cell from memory, `./name` to the
 * sandbox runtime's sources and bare names through the import map to the
 * vendored files: the same modules a block frame loads, and no others.
 */
function exportPlugin(entry: string, cell: string): Esbuild.Plugin {
  return {
    name: 'theorem-export',
    setup(build) {
      build.onResolve({ filter: /^theorem:(entry|cell)$/ }, ({ path }) => ({
        path: path.slice('theorem:'.length),
        namespace: NAMESPACE.entry,
      }))
      build.onResolve({ filter: /^\.\/[\w-]+$/ }, ({ path, namespace }) =>
        namespace === NAMESPACE.vendor
          ? undefined
          : { path: path.slice(2), namespace: NAMESPACE.runtime },
      )
      build.onResolve({ filter: /.*/ }, ({ path }) => vendored(path))
      build.onLoad(
        { filter: /.*/, namespace: NAMESPACE.entry },
        ({ path }) => ({
          contents: path === 'entry' ? entry : cell,
          loader: 'js',
        }),
      )
      build.onLoad(
        { filter: /.*/, namespace: NAMESPACE.runtime },
        ({ path }) =>
          Object.hasOwn(runtimeSources, path)
            ? { contents: runtimeSources[path], loader: 'ts' }
            : {
                errors: [
                  { text: `The sandbox runtime has no module "${path}"` },
                ],
              },
      )
      build.onLoad(
        { filter: /.*/, namespace: NAMESPACE.vendor },
        ({ path }) => ({
          contents: vendorModules[path],
          loader: 'js',
        }),
      )
    },
  }
}

/**
 * esbuild already writes `</script` as `<\/script`. `<!--` would put the
 * HTML parser in its escaped script state, where a later `<script` keeps the
 * closing tag from ending the element; `\x21` is `!` in a string, template
 * or regular expression alike.
 */
const inlineSafe = (code: string) => code.replaceAll('<!--', '<\\x21--')

const escapeHtml = (text: string) =>
  text.replace(
    /[&<>"]/g,
    (char) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char]!,
  )

/** The data an export carries: the declared files and state, as they are. */
async function exportedData(
  client: WorkspaceClient,
  name: string,
  cell: CompiledCell,
  state: StateCollections,
): Promise<ExportedData> {
  const { read, state: collections } = cell.capabilities
  const mayRead = read.length ? picomatch(read, { dot: false }) : () => false
  // What the bridge would serve: inside the folder, nothing hidden, declared.
  const readable = (path: string) => {
    try {
      return mayRead(checkPath(path))
    } catch {
      return false
    }
  }
  const declared = (await client.tree()).filter(
    (entry) => entry.kind === 'file' && readable(entry.path),
  )
  const total = declared.reduce((sum, entry) => sum + entry.size, 0)
  if (total > MAX_EXPORT_BYTES)
    throw new Error(
      `The files ${name} reads come to ${Math.round(total / 1024 / 1024)} MB; an export carries at most ${MAX_EXPORT_BYTES / 1024 / 1024} MB`,
    )
  const files: ExportedData['files'] = {}
  for (const entry of declared) {
    const { bytes } = await client.read(entry.path)
    files[entry.path] = {
      base64: toBase64(bytes),
      csv: /\.csv$/i.test(entry.path)
        ? encodeRows(decodeFile(bytes, 'csv'))
        : null,
    }
  }
  const lists: ExportedData['lists'] = {}
  for (const glob of read) {
    const matches = picomatch(glob, { dot: false })
    lists[glob] = declared
      .filter((entry) => matches(entry.path))
      .map(({ path, size, mtimeMs }) => ({ path, size, mtimeMs }))
  }
  return {
    name,
    files,
    lists,
    state: Object.fromEntries(
      collections.map((collection) => [collection, state.snapshot(collection)]),
    ),
  }
}

/** The tool, its runtime and its data as one module. */
async function bundle(
  cell: CompiledCell,
  data: ExportedData,
  esbuild: Bundler,
): Promise<string> {
  const entry = [
    `import * as cell from 'theorem:cell'`,
    `import { startStandalone } from './standalone'`,
    `void startStandalone(cell, ${JSON.stringify(data)})`,
  ].join('\n')
  return bundleScript(entry, cell.code, esbuild)
}

/** The existing App bridge bundled for a hosted document's opaque frame. */
export async function bundleAppBridge(esbuild?: Bundler): Promise<string> {
  return bundleScript(
    "import './app-bridge'",
    '',
    esbuild ?? (await browserEsbuild()),
    'iife',
  )
}

/**
 * The Observable notebook runtime for a hosted notebook's frame, with every
 * module in the import map bundled in: a cell's `import("d3")` reaches the
 * same vendored build a block's would, and nothing else.
 */
export async function bundleNotebookRuntime(
  esbuild?: Bundler,
): Promise<string> {
  const modules = Object.keys(importMap.imports)
    .map((specifier) => {
      const name = JSON.stringify(specifier)
      return `${name}: () => import(${name})`
    })
    .join(',\n')
  const entry = [
    `import { start } from './notebook'`,
    `const modules = {\n${modules}\n}`,
    `window.__theoremNotebook = {`,
    `  start: (cells, options) => start(cells, options, modules),`,
    `}`,
  ].join('\n')
  return bundleScript(entry, '', esbuild ?? (await browserEsbuild()), 'iife')
}

const LOADERS: Record<string, Esbuild.Loader> = {
  tsx: 'tsx',
  ts: 'ts',
  jsx: 'jsx',
  js: 'js',
  css: 'css',
  json: 'json',
}
const RESOLVED = ['', '.tsx', '.ts', '.jsx', '.js', '/index.tsx', '/index.ts']

/** `./Table` from `components/App.tsx` is `components/Table`, or null outside the App. */
function joinSource(importer: string, path: string): string | null {
  const parts = importer.split('/').slice(0, -1)
  for (const part of path.split('/')) {
    if (part === '.' || part === '') continue
    if (part === '..') {
      if (!parts.length) return null
      parts.pop()
    } else parts.push(part)
  }
  return parts.join('/')
}

/** The attribute a built App's elements carry: the file, line and column that wrote them. */
export const SOURCE_ATTRIBUTE = 'data-theorem-source'

/** Where esbuild is told an App's JSX runtime is; the plugin answers with JSX_RUNTIME. */
const JSX_SOURCE = 'theorem-app-jsx'

/**
 * The JSX runtime an App is built with: React's, with each element the App's
 * own files write that becomes a DOM node stamped with where it was written.
 * A library's elements are not stamped: the place to change is the App line
 * that used the library. esbuild passes that place to `jsxDEV`, so nothing is
 * parsed and nothing is written into the App's own source.
 */
const JSX_RUNTIME = `import { Fragment, jsx, jsxs } from 'react/jsx-runtime'
export { Fragment }
export function jsxDEV(type, props, key, isStatic, source) {
  const stamped =
    typeof type === 'string' && source && String(source.fileName).startsWith('${NAMESPACE.app}:') &&
    props['${SOURCE_ATTRIBUTE}'] === undefined
      ? {
          ...props,
          '${SOURCE_ATTRIBUTE}':
            String(source.fileName).replace(/^${NAMESPACE.app}:/, '') +
            ':' + source.lineNumber + ':' + source.columnNumber,
        }
      : props
  return (isStatic ? jsxs : jsx)(type, stamped, key)
}
`

/**
 * Resolves the App's files and browser-compatible npm/HTTPS dependencies.
 * Vendored modules remain an offline fast path, not an import ceiling.
 */
function appPlugin({ files, entry }: AppSources, dependencies: AppDependencies): Esbuild.Plugin {
  return {
    name: 'theorem-app',
    setup(build) {
      build.onResolve({ filter: /^theorem:app$/ }, () => ({
        path: entry,
        namespace: NAMESPACE.app,
      }))
      build.onResolve(
        { filter: new RegExp(`^${JSX_SOURCE}/jsx-dev-runtime$`) },
        () => ({ path: 'jsx-dev-runtime', namespace: NAMESPACE.entry }),
      )
      build.onLoad({ filter: /.*/, namespace: NAMESPACE.entry }, () => ({
        contents: JSX_RUNTIME,
        loader: 'js',
      }))
      const appFile = (importer: string, path: string, namespace: string) => {
        const base = joinSource(importer, path)
        const found =
          base === null
            ? undefined
            : RESOLVED.map((suffix) => base + suffix).find((candidate) =>
                Object.hasOwn(files, candidate),
              )
        return found
          ? { path: found, namespace }
          : { errors: [{ text: `No file "${path}" in this App` }] }
      }
      // `import digest from './solver.ts?implementation'`: the SHA-256 of what
      // that file runs, so an operation's key follows its code and not a name
      // someone remembered to bump (artifact-runtime Operation.implementation).
      // It is the canonical JSON of every module the file's own build reads,
      // each App file and library module by the digest of its text and each
      // pinned dependency by its exact URL, so a change to anything it
      // imports, at any depth, is a new implementation and a change elsewhere
      // in the App is not.
      build.onResolve(
        { filter: /^\.\.?\/.*\?implementation$/, namespace: NAMESPACE.app },
        ({ path, importer }) =>
          appFile(importer, path.slice(0, -'?implementation'.length), NAMESPACE.implementation),
      )
      // `import url from './work.ts?worker'`, as in Vite: that file is bundled
      // on its own and handed over as a blob URL for `new Worker(url)`. A
      // module worker from a blob does not start in the App's sandboxed frame
      // (its origin is opaque), so it is a classic script: the bundle runs in
      // an async function, which keeps top-level await, and a failure in it is
      // thrown again so it reaches the worker's `onerror`.
      build.onResolve(
        { filter: /^\.\.?\/.*\?worker$/, namespace: NAMESPACE.app },
        ({ path, importer }) => appFile(importer, path.slice(0, -'?worker'.length), NAMESPACE.worker),
      )
      build.onResolve(
        { filter: /^\.\.?\//, namespace: NAMESPACE.app },
        ({ path, importer }) => appFile(importer, path, NAMESPACE.app),
      )
      build.onLoad({ filter: /.*/, namespace: NAMESPACE.implementation }, async ({ path }) => {
        try {
          const result = await build.esbuild.build({
            ...build.initialOptions,
            outfile: 'implementation.js',
            sourcemap: false,
            metafile: true,
            // The same build an App of only this file would be, from `theorem:app`.
            plugins: [appPlugin({ files, entry: path }, dependencies)],
          })
          return { contents: `export default ${JSON.stringify(await implementationDigest(files, Object.keys(result.metafile.inputs)))}`, loader: 'js' }
        } catch (error) {
          const errors = (error as Partial<Esbuild.BuildFailure>).errors
          if (!errors?.length) throw error
          return { errors }
        }
      })
      build.onLoad({ filter: /.*/, namespace: NAMESPACE.worker }, async ({ path }) => {
        try {
          const result = await build.esbuild.build({
            ...build.initialOptions,
            outfile: 'worker.js',
            sourcemap: false,
            define: { 'import.meta.url': 'self.location.href' },
            plugins: [appPlugin({ files, entry: path }, dependencies)],
          })
          const code = (result.outputFiles?.find((file) => file.path.endsWith('worker.js'))?.text ?? '')
            // What the worker file exports has no one to go to.
            .replace(/\nexport \{[^}]*\};\s*$/, '\n')
          const script = `(async () => {\n${code}\n})().catch((error) => setTimeout(() => { throw error }))\n`
          return {
            contents: `export default URL.createObjectURL(new Blob([${JSON.stringify(script)}], { type: 'text/javascript' }))`,
            loader: 'js',
          }
        } catch (error) {
          const errors = (error as Partial<Esbuild.BuildFailure>).errors
          if (!errors?.length) throw error
          return { errors }
        }
      })
      // A library's own modules, `./name` beside the one importing them.
      build.onResolve(
        { filter: /^\.\/[\w-]+(?:\.\w+)?$/, namespace: NAMESPACE.library },
        ({ path, importer }) => ({
          path: `${importer.slice(0, importer.lastIndexOf('/'))}/${path.slice(2)}`,
          namespace: NAMESPACE.library,
        }),
      )
      build.onResolve({ filter: /.*/ }, async ({ path, importer, namespace, kind }) => {
        if (kind === 'url-token' && /^(?:data:|#)/.test(path))
          return { path, external: true }
        try {
          const resolved = dependencies.resolve(
            path,
            namespace === NAMESPACE.dependency ? importer : undefined,
          )
          if (resolved.kind === 'vendor')
            return { path: resolved.path, namespace: NAMESPACE.vendor }
          if (resolved.kind === 'library')
            return { path: `${resolved.path}/index`, namespace: NAMESPACE.library }
          // Follow redirects before choosing the namespace path, so a remote
          // module's relative imports use its final URL, not its request URL.
          const module = await dependencies.load(resolved.path)
          return { path: module.url, namespace: NAMESPACE.dependency }
        } catch (error) {
          return { errors: [{ text: error instanceof Error ? error.message : String(error) }] }
        }
      })
      build.onLoad({ filter: /.*/, namespace: NAMESPACE.app }, ({ path }) => ({
        contents: files[path],
        loader: LOADERS[path.slice(path.lastIndexOf('.') + 1)] ?? 'js',
      }))
      build.onLoad(
        { filter: /.*/, namespace: NAMESPACE.vendor },
        ({ path }) => ({ contents: vendorModules[path], loader: 'js' }),
      )
      build.onLoad({ filter: /.*/, namespace: NAMESPACE.library }, ({ path }) => {
        const slash = path.lastIndexOf('/')
        const module = libraryModule(path.slice(0, slash), path.slice(slash + 1))
        return module === undefined
          ? { errors: [{ text: `No module "${path}"` }] }
          : { contents: module.source, loader: LOADERS[module.file.slice(module.file.lastIndexOf('.') + 1)] ?? 'ts' }
      })
      build.onLoad(
        { filter: /.*/, namespace: NAMESPACE.dependency },
        async ({ path }) => {
          const module = await dependencies.load(path)
          return { contents: module.bytes ?? module.source, loader: module.loader }
        },
      )
    },
  }
}

/** An App's files as one module, the styles they import, and where each line came from. */
export interface AppBundle {
  code: string
  css: string
  /**
   * A source map of the App's own files only, by their paths: a position in
   * a module the App imports maps to nothing.
   */
  map: string
}

interface RawMap {
  version: number
  sources: Array<string>
  names: Array<string>
  mappings: string
}

/** The bundle's map with only the App's files in it, named as the App names them. */
function appMap(text: string): string {
  const raw = JSON.parse(text) as RawMap
  const renumbered = new Map<number, number>()
  const sources: Array<string> = []
  raw.sources.forEach((source, index) => {
    const path = fromApp(source)
    if (path === undefined) return
    renumbered.set(index, sources.length)
    sources.push(path)
  })
  const mappings = decode(raw.mappings).map((line) =>
    line.flatMap((segment) => {
      const source =
        segment.length > 1 ? renumbered.get(segment[1]!) : undefined
      if (source === undefined) return []
      // Names are dropped with the rest: a position is all a frame needs.
      return [
        [segment[0], source, segment[2]!, segment[3]!] as [
          number,
          number,
          number,
          number,
        ],
      ]
    }),
  )
  return JSON.stringify({
    version: raw.version,
    sources,
    names: [],
    mappings: encode(mappings),
  })
}

const fromApp = (file: string) =>
  file.startsWith(`${NAMESPACE.app}:`)
    ? file.slice(NAMESPACE.app.length + 1)
    : undefined

/**
 * Builds a TypeScript App: its files and the modules they import, as one
 * module for the App's frame. Types are erased, not checked; app-check.ts
 * checks them. A file that does not build is an AppBuildError naming it.
 */
export async function bundleAppSources(
  sources: AppSources,
  esbuild?: Bundler,
  dependencies?: AppDependencies,
): Promise<AppBundle> {
  let result: Esbuild.BuildResult
  try {
    result = await (esbuild ?? (await browserEsbuild())).build({
      entryPoints: ['theorem:app'],
      outfile: 'app.js',
      bundle: true,
      write: false,
      format: 'esm',
      target: 'es2022',
      jsx: 'automatic',
      // The development transform passes each element's place in its file.
      jsxDev: true,
      jsxImportSource: JSX_SOURCE,
      sourcemap: 'external',
      // Positions are all a stack frame needs; the text would double the map.
      sourcesContent: false,
      legalComments: 'none',
      logLevel: 'silent',
      plugins: [appPlugin(sources, dependencies ?? appDependencies(sources))],
    })
  } catch (error) {
    const messages = (error as Partial<Esbuild.BuildFailure>).errors
    if (!messages?.length) throw error
    throw new AppBuildError(
      messages.map(({ text, location }): AppProblem => ({
        kind: 'build',
        message: text,
        file: location ? (fromApp(location.file) ?? location.file) : undefined,
        line: location?.line,
        column: location ? location.column + 1 : undefined,
      })),
    )
  }
  const output = (suffix: string) =>
    result.outputFiles?.find((file) => file.path.endsWith(suffix))?.text
  const code = output('app.js')
  const map = output('app.js.map')
  if (code === undefined || map === undefined)
    throw new Error('esbuild wrote nothing')
  return {
    code: inlineSafe(code),
    css: output('app.css') ?? '',
    map: appMap(map),
  }
}

async function bundleScript(
  entry: string,
  cell: string,
  esbuild: Bundler,
  format: 'esm' | 'iife' = 'esm',
): Promise<string> {
  const result = await esbuild.build({
    entryPoints: ['theorem:entry'],
    bundle: true,
    write: false,
    format,
    target: 'es2022',
    minify: true,
    legalComments: 'none',
    logLevel: 'silent',
    plugins: [exportPlugin(entry, cell)],
  })
  const output = result.outputFiles[0]
  if (!output) throw new Error('esbuild wrote nothing')
  return inlineSafe(output.text)
}

/** The page: one inline module, the whole tool. */
function exportDocument(name: string, script: string): string {
  return `<!doctype html>
<html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(name)}</title>
<style>${BLOCK_DOCUMENT_STYLE}</style>
</head><body><div id="root"></div>
<script type="module">${script}</script>
</body></html>
`
}

/**
 * Exports a tool file as one HTML page that runs anywhere: the compiled tool,
 * the sandbox runtime, React and the files and state it declared, inline.
 * Writes `Exports/<name>.html` beside the folder's other files.
 */
export async function exportTool(
  client: WorkspaceClient,
  path: string,
  options: ExportOptions,
): Promise<ExportedTool> {
  const name = (path.split('/').pop() ?? path).replace(/\.[^.]+$/, '')
  const { text } = await client.readText(path)
  const cell = await (options.compile ?? compileCell)(text)
  if (cell.declarationErrors.length)
    throw new Error(
      `${path} has declaration problems: ${cell.declarationErrors.join('; ')}`,
    )
  const data = await exportedData(client, name, cell, options.state)
  const script = await bundle(
    cell,
    data,
    await (options.esbuild ?? browserEsbuild)(),
  )
  const html = exportDocument(name, script)
  const out = `Exports/${name}.html`
  await client.write(out, html)
  return { path: out, bytes: new TextEncoder().encode(html).length }
}
