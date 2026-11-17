// Fetch declarations for the exact module responses the App builder used.
// TypeScript's preprocessor only reads import references here; tsrs remains
// the compiler that checks the App. No dependency is silently declared `any`.
import type { FileReference } from 'typescript'
import type { AppProblem, AppSources } from './app-source'
import { appDependencies } from './app-dependencies'
import type { AppDependencies } from './app-dependencies'

export interface DependencyDeclarations {
  files: Record<string, string>
  paths: Record<string, Array<string>>
  problems: Array<AppProblem>
}

const typed: Record<string, string> = {
  react: '/node_modules/@types/react/index.d.ts',
  'react-dom': '/node_modules/@types/react-dom/index.d.ts',
  'react/jsx-runtime': '/node_modules/@types/react/jsx-runtime.d.ts',
  'react-dom/client': '/node_modules/@types/react-dom/client.d.ts',
}

function place(source: string, ref: FileReference) {
  const before = source.slice(0, ref.pos)
  const lines = before.split('\n')
  return { line: lines.length, column: lines.at(-1)!.length + 1 }
}

/** A URL has one virtual declaration filename, including its query string. */
const virtualPath = (url: string) =>
  `/app/dependencies/${encodeURIComponent(url)}.d.ts`

const local = (specifier: string) => /^(?:\.{1,2}\/|\/)/.test(specifier)

/** esm.sh can leave a package's own source aliases as unversioned URLs. */
function npmURL(value: string) {
  const url = new URL(value)
  if (url.origin !== 'https://esm.sh') return undefined
  const match = /^\/(@[^/@]+\/[^/@]+|[^/@]+)(?:@([^/]+))?(?:\/(.*))?$/.exec(url.pathname)
  return match ? { name: match[1]!, version: match[2], path: match[3] ?? '' } : undefined
}

/**
 * Local type errors still report normally when a dependency has no types.
 * Missing or broken declarations are separate actionable diagnostics; the
 * JavaScript build and live frame do not wait for a successful type check.
 */
export async function dependencyDeclarations(
  sources: AppSources,
  dependencies: AppDependencies = appDependencies(sources),
): Promise<DependencyDeclarations> {
  const { preProcessFile } = await import('typescript')
  const result: DependencyDeclarations = { files: {}, paths: {}, problems: [] }
  const scheduled = new Map<string, Promise<void>>()
  const packageTypes = new Map<string, { entry: string; directory: string }>()

  function rememberTypes(request: string, types: string) {
    const imported = npmURL(request)
    const declared = npmURL(types)
    if (imported && !imported.path && declared?.version && imported.name === declared.name)
      packageTypes.set(`${declared.name}@${declared.version}`, {
        entry: types,
        directory: new URL('./', types).href,
      })
  }

  async function declarationTarget(value: string, importer?: string): Promise<string> {
    const self = npmURL(value)
    const owner = importer && npmURL(importer)
    const root = owner && packageTypes.get(`${owner.name}@${owner.version}`)
    if (self && !self.version && owner && root && self.name === owner.name) {
      // Resolve the package's own alias against its advertised declaration
      // root, retaining that package's version and CDN build arguments. For
      // example, pkg/types/foo inside pkg@1/dist/index.d.ts means that
      // published types tree, never the latest unversioned pkg on the CDN.
      return self.path
        ? declarationTarget(new URL(self.path, root.directory).href)
        : root.entry
    }
    const url = new URL(value)
    if (/\.d\.[cm]?ts$/.test(url.pathname)) return value
    const withPath = (path: string) => {
      const candidate = new URL(url)
      candidate.pathname = path
      return candidate.href
    }
    const candidates = /\.mjs$/.test(url.pathname)
      ? [withPath(url.pathname.replace(/\.mjs$/, '.d.mts')), withPath(url.pathname.replace(/\.mjs$/, '.d.ts'))]
      : /\.cjs$/.test(url.pathname)
        ? [withPath(url.pathname.replace(/\.cjs$/, '.d.cts')), withPath(url.pathname.replace(/\.cjs$/, '.d.ts'))]
        : /\.js$/.test(url.pathname)
          ? [withPath(url.pathname.replace(/\.js$/, '.d.ts'))]
          : [withPath(url.pathname + '.d.ts'), withPath(url.pathname.replace(/\/$/, '') + '/index.d.ts')]
    for (const candidate of [...candidates, value]) {
      try {
        const module = await dependencies.load(candidate)
        if (/\.d\.[cm]?ts(?:\?|$)/.test(module.url)) return candidate
        if (module.types) return module.types
      } catch {
        // A declaration's extensionless import uses TypeScript's usual file
        // and directory candidates; one missing candidate is not an error.
      }
    }
    throw new Error(`No declarations found for ${value}; tried ${candidates.join(', ')}`)
  }

  // Each file schedules its children without awaiting them: declarations can
  // contain cycles. The queue is drained below after every root is scheduled.
  function schedule(url: string): string {
    const path = virtualPath(url)
    if (scheduled.has(url)) return path
    const work = (async () => {
      const module = await dependencies.load(url)
      if (module.loader !== 'ts' && !/\.d\.[cm]?ts(?:\?|$)/.test(module.url))
        throw new Error(`The declaration URL ${module.url} did not return a TypeScript declaration`)
      const refs = preProcessFile(module.source, true, true)
      const replacements: Array<{ start: number; end: number; value: string }> = []
      for (const ref of [...refs.importedFiles, ...refs.referencedFiles, ...refs.typeReferenceDirectives]) {
        const specifier = ref.fileName
        // The local React declarations describe the vendored React instance.
        if (Object.hasOwn(typed, specifier) && dependencies.resolve(specifier).kind === 'vendor') continue
        let target: string
        if (local(specifier) || specifier.startsWith('https://')) {
          target = await declarationTarget(new URL(specifier, module.url).href, module.url)
        } else {
          const resolved = dependencies.resolve(specifier)
          if (resolved.kind === 'vendor') continue
          const dependency = await dependencies.load(resolved.path)
          if (!dependency.types)
            throw new Error(`No declarations advertised by "${specifier}", imported by ${module.url}`)
          rememberTypes(resolved.path, dependency.types)
          target = dependency.types
        }
        const start = module.source.indexOf(specifier, ref.pos)
        if (start < ref.pos || start > ref.end)
          throw new Error(`Could not locate declaration import "${specifier}" in ${module.url}`)
        replacements.push({ start, end: start + specifier.length, value: schedule(target) })
      }
      let source = module.source
      for (const { start, end, value } of replacements.sort((a, b) => b.start - a.start))
        source = source.slice(0, start) + value + source.slice(end)
      result.files[path] = source
    })()
    scheduled.set(url, work)
    // A child may fail before the queue reaches it. The error is still read
    // below, but it must not become an unhandled rejection in the meantime.
    work.catch(() => {})
    return path
  }

  const roots = new Map<string, Array<{ file: string; source: string; ref: FileReference }>>()
  const localDeclarations = new Set<string>()
  for (const [file, source] of Object.entries(sources.files)) {
    if (!/\.[cm]?[jt]sx?$/.test(file)) continue
    const refs = preProcessFile(source, true, true)
    for (const module of refs.ambientExternalModules ?? []) localDeclarations.add(module)
    const imports = [...refs.importedFiles]
    if (/\.[jt]sx$/.test(file))
      imports.push({ fileName: 'react/jsx-runtime', pos: 0, end: 0 })
    for (const ref of imports) {
      if (local(ref.fileName)) continue
      const uses = roots.get(ref.fileName) ?? []
      uses.push({ file, source, ref })
      roots.set(ref.fileName, uses)
    }
  }

  const report = (specifier: string, message: string, code: string) => {
    for (const use of roots.get(specifier) ?? [])
      result.problems.push({
        kind: 'type', code, file: use.file,
        ...place(use.source, use.ref), message,
      })
  }

  await Promise.all([...roots.keys()].map(async (specifier) => {
    try {
      const resolved = dependencies.resolve(specifier)
      if (resolved.kind === 'vendor') {
        // Versioned imports of a vendored package need the same declaration
        // alias as its ordinary bare spelling.
        if (resolved.specifier && specifier !== resolved.specifier)
          result.paths[specifier] = [
            Object.hasOwn(typed, resolved.specifier)
              ? typed[resolved.specifier]!
              : `/app/dependencies/vendor-${encodeURIComponent(specifier)}.d.ts`,
          ]
        if (resolved.specifier && !Object.hasOwn(typed, resolved.specifier) && specifier !== resolved.specifier)
          result.files[result.paths[specifier]![0]!] = `declare module ${JSON.stringify(specifier)};`
        return
      }
      const module = await dependencies.load(resolved.path)
      if (localDeclarations.has(specifier)) return
      if (module.loader === 'css' || module.loader === 'dataurl' || module.loader === 'json') {
        const path = module.loader === 'json'
          ? `/app/dependencies/${encodeURIComponent(module.url)}.json`
          : virtualPath(module.url)
        result.paths[specifier] = [path]
        result.files[path] = module.loader === 'json' ? module.source
          : module.loader === 'css' ? 'export {};'
            : 'declare const url: string; export default url;'
        return
      }
      if (!module.types) {
        report(specifier,
          `"${specifier}" resolves and can run, but ${module.url} does not advertise declarations. Its API cannot be type-checked. Add a local .d.ts declaration or use a module with types.`,
          'APP_DEPENDENCY_TYPES')
        // Do not manufacture an ambient any module. The checker also keeps
        // its own missing-declaration diagnostic until the author supplies one.
        return
      }
      rememberTypes(resolved.path, module.types)
      result.paths[specifier] = [schedule(module.types)]
    } catch (error) {
      report(specifier, error instanceof Error ? error.message : String(error), 'APP_DEPENDENCY_RESOLVE')
    }
  }))

  const read = new Set<string>()
  while (read.size < scheduled.size) {
    const pending = [...scheduled].filter(([url]) => !read.has(url))
    await Promise.all(pending.map(async ([url, promise]) => {
      read.add(url)
      try {
        await promise
      } catch (error) {
        const message = `Could not load App dependency types: ${error instanceof Error ? error.message : String(error)}`
        result.problems.push({ kind: 'type', code: 'APP_DEPENDENCY_TYPES', message })
      }
    }))
  }
  return result
}
