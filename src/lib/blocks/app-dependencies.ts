// App source is ordinary TypeScript. The vendored block modules are an offline
// fast path, not a list of the packages an App may use. Other browser modules
// are fetched while building and are included in the same sandboxed bundle.
import type { Loader } from 'esbuild-wasm'
import type { AppSources } from './app-source'
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

export type AppDependency =
  | { kind: 'vendor'; path: string; specifier?: string }
  | { kind: 'url'; path: string }

export interface AppModule {
  /** The final URL, after redirects; relative imports are resolved from here. */
  url: string
  source: string
  loader: Loader
  /** Fonts/images imported by CSS are embedded in the compiled stylesheet. */
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

  constructor(
    readonly versions: Record<string, string> = {},
    private readonly request: AppDependencyFetch = (url, init) => fetch(url, init),
  ) {}

  resolve(specifier: string, importer?: string): AppDependency {
    if (Object.hasOwn(vendorSources, specifier))
      return { kind: 'vendor', path: specifier }
    if (importer && /^(?:\.{0,2}\/)/.test(specifier))
      return this.remote(new URL(specifier, importer).href)
    if (/^https:\/\//.test(specifier)) return this.remote(specifier)
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
    url.searchParams.set('external', 'react,react-dom')
    return { kind: 'url', path: url.href }
  }

  private remote(value: string): AppDependency {
    const url = new URL(value)
    if (url.protocol !== 'https:')
      throw new Error(`App dependency "${value}" must use HTTPS`)
    const vendored = vendorUrls.get(url.href)
    return vendored ? { kind: 'vendor', path: vendored } : { kind: 'url', path: url.href }
  }

  load(url: string): Promise<AppModule> {
    if (!url.startsWith('https://'))
      return Promise.reject(new Error(`App dependency "${url}" must use HTTPS`))
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
    const contentType = response.headers.get('content-type')
    if (contentType?.includes('text/html'))
      throw new Error(`App dependency ${finalUrl} returned HTML instead of a module`)
    const types = response.headers.get('x-typescript-types')
    const loader = loaderFor(finalUrl, contentType)
    const module: AppModule = {
      url: finalUrl,
      source: loader === 'dataurl' ? '' : await response.text(),
      loader,
      ...(loader === 'dataurl' ? { bytes: new Uint8Array(await response.arrayBuffer()) } : {}),
      ...(types ? { types: new URL(types, finalUrl).href } : {}),
    }
    this.modules.set(finalUrl, Promise.resolve(module))
    return module
  }
}

const sessions = new Map<string, AppDependencies>()

/** Build and check obtain the same responses, even when they run concurrently. */
export function appDependencies(sources: AppSources): AppDependencies {
  const versions = declaredDependencies(sources)
  const key = JSON.stringify(Object.entries(versions).sort(([a], [b]) => a.localeCompare(b)))
  let resolver = sessions.get(key)
  if (!resolver) {
    resolver = new AppDependencies(versions)
    sessions.set(key, resolver)
  }
  return resolver
}
