// App source is ordinary TypeScript. The vendored block modules are an offline
// fast path, not a list of the packages an App may use. Other browser modules
// are fetched while building and are included in the same sandboxed bundle.
import type { Loader } from 'esbuild-wasm'
import type { AppSources } from './app-source'
import { appLibrary, libraryDependencies } from './app-libraries'
import { APP_DEPENDENCY_EXTERNALS, appDependencyURL, usesDefaultDependencyBuild } from './app-dependency-urls'
import { importMap, vendorSources } from './vendor/manifest'

const CDN = 'https://esm.sh/'
const imports: Record<string, string> = { ...importMap.imports }
const vendorUrls = new Map(
  Object.entries(vendorSources).map(([path, source]) => [source.url, path]),
)

interface PackageImport {
  name: string
  version?: string
  path: string
}

function packageImport(specifier: string): PackageImport {
  const value = specifier.replace(/^npm:/, '')
  const match = /^(@[\w.-]+\/[\w.-]+|[\w.-]+)(?:@([^/]+))?(\/[^?#]*)?$/.exec(value)
  if (!match)
    throw new Error(
      `Cannot resolve "${specifier}". Use an npm package, a relative App file, or an HTTPS module URL. Node-only modules cannot run in an App.`,
    )
  return { name: match[1]!, version: match[2], path: match[3] ?? '' }
}

const defaultReact = packageImport(imports.react!.slice('/vendor/'.length)).version!
const defaultReactDOM = packageImport(imports['react-dom/client']!.slice('/vendor/'.length)).version!
// ReactDOM's root is already a vendored transitive dependency of /client.
// React component kits often import createPortal from this entry directly.
const reactDOM = `/vendor/react-dom@${defaultReactDOM}/es2022/react-dom.mjs`
if (Object.hasOwn(vendorSources, reactDOM)) imports['react-dom'] = reactDOM

function declaredDependencies(sources: AppSources): Record<string, string> {
  const source = sources.files['package.json']
  if (!source) return {}
  let value: unknown
  try {
    value = JSON.parse(source)
  } catch {
    throw new Error('package.json is not valid JSON')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('package.json must contain a JSON object')
  const dependencies = (value as { dependencies?: unknown }).dependencies
  if (dependencies === undefined) return {}
  if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies))
    throw new Error('package.json dependencies must be an object of package names and versions')
  for (const [name, version] of Object.entries(dependencies)) {
    if (typeof version !== 'string' || !version.trim())
      throw new Error(`package.json dependency "${name}" needs a version`)
  }
  return dependencies as Record<string, string>
}

/** Only a script's quotes are an import. A CSS or JSON module that happens to
 * hold `"npm:react@..."` text is not the App asking for that version. */
const SCRIPT_FILE = /\.(?:[cm]?[jt]sx?)$/

/** A quoted specifier in `from`, `import` or dynamic `import()` position. A
 * template literal holds no durable pin, so it is deliberately not read. */
const IMPORTED = /(?:^|[^\w$.])(?:from|import)\s*\(?\s*['"]([^'"\n]+)['"]/g

const REACT_PACKAGES = ['react', 'react-dom'] as const

/** One version of one React package, with every place the App asked for it. */
interface ReactChoice {
  name: string
  version: string
  /** Source files that imported it; `package.json` for a declared dependency. */
  files: Array<string>
}

/** The React versions the App's own import specifiers name. Only a specifier
 * carrying an explicit version is a choice; a bare `react` leaves the App's
 * React to package.json and Theorem's vendor. */
function importedReact(files: Record<string, string>): Array<ReactChoice> {
  const choices: Array<ReactChoice> = []
  for (const [file, source] of Object.entries(files)) {
    if (!SCRIPT_FILE.test(file)) continue
    for (const [, specifier] of source.matchAll(IMPORTED)) {
      let parsed: PackageImport
      try {
        parsed = packageImport(specifier!)
      } catch {
        // Not a package specifier: the bundler reports it at the import itself.
        // This scan only wants a React version.
        continue
      }
      if (!parsed.version || (parsed.name !== 'react' && parsed.name !== 'react-dom'))
        continue
      const found = choices.find(
        (choice) => choice.name === parsed.name && choice.version === parsed.version,
      )
      if (found) found.files.push(file)
      else choices.push({ name: parsed.name, version: parsed.version, files: [file] })
    }
  }
  return choices
}

/** The exact React version a package.json dependency names, or undefined when
 * it names none Theorem can pin a build to: a dist-tag or bare range (`*`,
 * `latest`), or an alias to another package (`npm:preact-compat@19`). */
function namedReactVersion(value: string): string | undefined {
  const trimmed = value.trim()
  const range = /^(?:\^|~|>=|=|v)?(\d[\w.+-]*)$/.exec(trimmed)
  if (range) return range[1]
  if (!trimmed.startsWith('npm:')) return undefined
  try {
    const aliased = packageImport(trimmed)
    const namesReact = aliased.name === 'react' || aliased.name === 'react-dom'
    return aliased.path || !namesReact ? undefined : aliased.version
  } catch {
    return undefined
  }
}

/** One App asks for one React version: the same text, or a range whose exact
 * version is the one the App imported. */
function sameReactVersion(a: string, b: string): boolean {
  if (a === b) return true
  const exact = namedReactVersion(a)
  return exact !== undefined && exact === namedReactVersion(b)
}

/** Where an App asked for a version, so a refusal can point at the file. */
const asking = (choice: ReactChoice) => {
  const files = [...new Set(choice.files)]
  const shown = files.length > 3
    ? `${files.slice(0, 3).join(', ')}, +${files.length - 3} more`
    : files.join(', ')
  return `${choice.name}@${choice.version} (${shown})`
}

/**
 * The App's one React version, for every React package it names. An explicit
 * version in an import specifier is a choice like a package.json one, and must
 * reach react-dom and the JSX runtime too: two copies of React cannot render
 * one tree, so a pin that only decided `react` would leave the App with the
 * vendored renderer beside its own hooks. A conflict is refused rather than
 * settled by whichever file happened to be scanned first.
 *
 * An App that names no version in an import gets nothing here, so package.json
 * and Theorem's vendored React keep behaving exactly as they did.
 */
function reactVersions(
  files: Record<string, string>,
  declared: Record<string, string>,
): Record<string, string> {
  const imported = importedReact(files)
  if (!imported.length) return {}
  // The version the App wrote in its own import wins over a package.json range,
  // and is what every React package in the bundle is built from.
  const version = imported[0]!.version
  const choices = [...imported]
  for (const name of REACT_PACKAGES) {
    const value = declared[name]
    if (value !== undefined) choices.push({ name, version: value, files: ['package.json'] })
  }
  if (!choices.every((choice) => sameReactVersion(choice.version, version)))
    throw new Error(
      `One App must use one React version. This App asks for ${choices.map(asking).join(', ')}. Use one version of react and react-dom, in package.json or in every import specifier.`,
    )
  const shared: Record<string, string> = {}
  for (const name of REACT_PACKAGES)
    if (imported.some((choice) => choice.name === name) || Object.hasOwn(declared, name))
      shared[name] = version
  return shared
}

export type AppDependency =
  | { kind: 'vendor'; path: string; specifier?: string }
  | { kind: 'url'; path: string }
  /** A library Theorem ships (app-libraries.ts), built from its own sources. */
  | { kind: 'library'; path: string }

export interface AppModule {
  /** The final URL, after redirects; relative imports are resolved from here. */
  url: string
  source: string
  loader: Loader
  /** Fonts/images imported by CSS are embedded in the compiled stylesheet; a .wasm import is these bytes. */
  bytes?: Uint8Array
  /** The declarations advertised by the very response used for the build. */
  types?: string
}

export type AppDependencyFetch = (url: string, init?: RequestInit) => Promise<Response>

const loaderFor = (url: string, contentType: string | null): Loader => {
  const extension = new URL(url).pathname.split('.').pop()
  if (extension === 'tsx' || extension === 'jsx' || extension === 'ts') return extension
  if (extension === 'json' || contentType?.includes('application/json')) return 'json'
  if (extension === 'css' || contentType?.includes('text/css')) return 'css'
  if (
    /^(?:woff2?|ttf|otf|eot|svg|png|jpe?g|gif|webp|avif|ico)$/.test(extension ?? '') ||
    /^(?:image|font)\//.test(contentType ?? '')
  ) return 'dataurl'
  // WebAssembly is handed to the App as bytes (a Uint8Array), for a module
  // that cannot find its own .wasm once bundled: `Module({ wasmBinary })`.
  if (extension === 'wasm' || contentType?.includes('application/wasm')) return 'binary'
  return 'js'
}

/**
 * One resolver is shared by build and type check. Successful responses are
 * immutable for its lifetime; failed requests are evicted so Retry can work.
 * Exact package.json versions / versioned URLs are the durable pins. A cache
 * is deliberately not represented as a lockfile or a cross-device pin.
 */
export class AppDependencies {
  private readonly modules = new Map<string, Promise<AppModule>>()
  private readonly managed = new Set<string>()

  constructor(
    readonly versions: Record<string, string> = {},
    private readonly request: AppDependencyFetch = (url, init) => fetch(url, init),
  ) {}

  resolve(specifier: string, importer?: string): AppDependency {
    if (Object.hasOwn(vendorSources, specifier))
      return { kind: 'vendor', path: specifier }
    if (importer && /^(?:\.{0,2}\/)/.test(specifier))
      return this.remote(new URL(specifier, importer).href, importer)
    if (/^https:\/\//.test(specifier)) return this.remote(specifier, importer)
    if (appLibrary(specifier)) return { kind: 'library', path: specifier }
    const parsed = packageImport(specifier)
    const peerVersion = parsed.name === 'react'
      ? this.versions.react ?? this.versions['react-dom'] ?? defaultReact
      : parsed.name === 'react-dom'
        ? this.versions['react-dom'] ?? this.versions.react ?? defaultReactDOM
        : undefined
    const declared = Object.hasOwn(this.versions, parsed.name) ? this.versions[parsed.name] : undefined
    const version = parsed.version ?? declared ?? peerVersion
    const bare = parsed.name + parsed.path
    const vendored = Object.hasOwn(imports, bare) ? imports[bare] : undefined
    const vendorVersion = vendored
      ? packageImport(vendored.slice('/vendor/'.length)).version
      : undefined
    if (vendored && (!version || version === vendorVersion))
      return { kind: 'vendor', path: vendored, specifier: bare }
    const target = version?.startsWith('npm:')
      ? packageImport(version)
      : { ...parsed, version }
    const path = target.name + (target.version ? `@${target.version}` : '') +
      (version?.startsWith('npm:') ? target.path + parsed.path : target.path)
    const url = new URL(path, CDN)
    url.searchParams.set('target', 'es2022')
    // All npm builds use the App's chosen React, including its JSX runtime.
    url.searchParams.set('external', APP_DEPENDENCY_EXTERNALS)
    this.managed.add(url.href)
    return { kind: 'url', path: url.href }
  }

  private remote(value: string, importer?: string): AppDependency {
    // A user-supplied HTTPS graph owns its build choices. Only npm wrappers
    // built by this resolver pass the App's React policy to their children.
    const managed = importer !== undefined && this.managed.has(importer)
    const url = new URL(managed ? appDependencyURL(value) : value)
    if (url.protocol !== 'https:')
      throw new Error(`App dependency "${value}" must use HTTPS`)
    if (managed && url.origin === 'https://esm.sh') this.managed.add(url.href)
    const vendored = vendorUrls.get(url.href)
    return vendored ? { kind: 'vendor', path: vendored } : { kind: 'url', path: url.href }
  }

  load(url: string): Promise<AppModule> {
    if (!url.startsWith('https://'))
      return Promise.reject(new Error(`App dependency "${url}" must use HTTPS`))
    if (usesDefaultDependencyBuild(url)) this.managed.add(url)
    const existing = this.modules.get(url)
    if (existing) return existing
    const pending = this.download(url)
    this.modules.set(url, pending)
    pending.catch(() => this.modules.delete(url))
    return pending
  }

  private async download(url: string): Promise<AppModule> {
    let response: Response
    try {
      response = await this.request(url, {
        credentials: 'omit',
        signal: AbortSignal.timeout(30_000),
      })
    } catch (error) {
      throw new Error(
        `Could not fetch App dependency ${url}: ${error instanceof Error ? error.message : String(error)}. Check connectivity and that this module allows browser cross-origin requests.`,
      )
    }
    if (!response.ok)
      throw new Error(
        `Could not fetch App dependency ${url}: HTTP ${response.status}. Check the package name, version and exported subpath.`,
      )
    const finalUrl = response.url || url
    if (!finalUrl.startsWith('https://'))
      throw new Error(`App dependency redirected to a non-HTTPS URL: ${finalUrl}`)
    if (this.managed.has(url)) this.managed.add(finalUrl)
    const contentType = response.headers.get('content-type')
    if (contentType?.includes('text/html'))
      throw new Error(`App dependency ${finalUrl} returned HTML instead of a module`)
    const types = response.headers.get('x-typescript-types')
    const loader = loaderFor(finalUrl, contentType)
    const binary = loader === 'dataurl' || loader === 'binary'
    const module: AppModule = {
      url: finalUrl,
      source: binary ? '' : await response.text(),
      loader,
      ...(binary ? { bytes: new Uint8Array(await response.arrayBuffer()) } : {}),
      ...(types ? { types: new URL(types, finalUrl).href } : {}),
    }
    this.modules.set(finalUrl, Promise.resolve(module))
    return module
  }
}

const sessions = new Map<string, AppDependencies>()

/** Build and check obtain the same responses, even when they run concurrently. */
export function appDependencies(sources: AppSources): AppDependencies {
  const declared = declaredDependencies(sources)
  const versions = {
    ...libraryDependencies(sources.files),
    ...declared,
    ...reactVersions(sources.files, declared),
  }
  const key = JSON.stringify(Object.entries(versions).sort(([a], [b]) => a.localeCompare(b)))
  let resolver = sessions.get(key)
  if (!resolver) {
    resolver = new AppDependencies(versions)
    sessions.set(key, resolver)
  }
  return resolver
}
