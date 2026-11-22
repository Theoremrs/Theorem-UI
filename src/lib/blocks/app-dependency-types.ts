// Fetch declarations for the exact module responses the App builder used.
// TypeScript's preprocessor only reads import references here; tsrs remains
// the compiler that checks the App. No dependency is silently declared `any`.
import type { FileReference } from 'typescript'
import type { AppProblem, AppSources } from './app-source'
import { appDependencies } from './app-dependencies'
import type { AppDependencies } from './app-dependencies'
import { appLibrary } from './app-libraries'
import { esmPackageURL as npmURL, usesDefaultDependencyBuild } from './app-dependency-urls'

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

interface DeclarationReference {
  url: string
  /** Only npm-managed edges inherit the App's default build policy. */
  managed: boolean
}

const referenceKey = ({ url, managed }: DeclarationReference) =>
  JSON.stringify([url, managed])

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
  const scheduled = new Map<string, { reference: DeclarationReference; work: Promise<void> }>()
  const packageTypes = new Map<string, { entry: string; directory: string }>()
  const declarationBuilds = new Map<string, string>()
  const rootDeclarations = new Map<string, DeclarationReference>()
  const declarations = new Map<string, {
    reference: DeclarationReference
    source: string
    replacements: Array<{ start: number; end: number; target: DeclarationReference }>
  }>()
  const failures = new Map<string, { reference: DeclarationReference; message: string }>()
  const packageKey = (identity: string, managed: boolean) => JSON.stringify([identity, managed])

  function rememberTypes(request: string, types: string) {
    const imported = npmURL(request)
    const declared = npmURL(types)
    if (imported && declared?.version && imported.name === declared.name) {
      const identity = `${declared.name}@${declared.version}`
      const managed = usesDefaultDependencyBuild(request)
      if (!imported.path)
        packageTypes.set(packageKey(identity, managed), {
          entry: types,
          directory: new URL('./', types).href,
        })
      // Use the CDN's advertised prefix, not a guessed encoding of its build
      // arguments. Other explicit build variants retain their own identity.
      const prefix = declared.path.split('/')[0]
      if (managed && prefix?.startsWith('X-'))
        declarationBuilds.set(identity, prefix)
    }
  }

  function canonicalDeclaration(reference: DeclarationReference): DeclarationReference {
    const { url: value, managed } = reference
    const parsed = npmURL(value)
    if (!parsed?.version) return reference
    const identity = `${parsed.name}@${parsed.version}`
    const prefix = declarationBuilds.get(identity)
    if (!prefix) return reference
    if (parsed.path.startsWith('X-')) {
      // An explicit URL selecting the same build is still the same module.
      // Its child edges must agree with the npm visit of that exact URL.
      return parsed.path.startsWith(`${prefix}/`)
        ? { url: value, managed: true }
        : reference
    }
    if (!managed) return reference
    const url = new URL(value)
    url.pathname = `/${identity}/${prefix}/${parsed.path}`
    return { url: url.href, managed }
  }

  async function declarationTarget(
    reference: DeclarationReference,
    importer?: string,
  ): Promise<DeclarationReference> {
    reference = canonicalDeclaration(reference)
    const { url: value, managed } = reference
    const self = npmURL(value)
    const owner = importer && npmURL(importer)
    const root = owner && packageTypes.get(packageKey(`${owner.name}@${owner.version}`, managed))
    if (self && !self.version && owner && root && self.name === owner.name) {
      // Resolve a package's own alias within its version and build policy.
      // Explicit HTTPS trees must not inherit a different npm root's types.
      return declarationTarget({
        url: self.path ? new URL(self.path, root.directory).href : root.entry,
        managed,
      })
    }
    const url = new URL(value)
    if (/\.d\.[cm]?ts$/.test(url.pathname)) return reference
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
        if (/\.d\.[cm]?ts(?:\?|$)/.test(module.url)) return { url: candidate, managed }
        if (module.types) return { url: module.types, managed }
      } catch {
        // A declaration's extensionless import uses TypeScript's usual file
        // and directory candidates; one missing candidate is not an error.
      }
    }
    throw new Error(`No declarations found for ${value}; tried ${candidates.join(', ')}`)
  }

  // Each file schedules its children without awaiting them: declarations can
  // contain cycles. The queue is drained below after every root is scheduled.
  function schedule(reference: DeclarationReference): void {
    reference = canonicalDeclaration(reference)
    const { url, managed } = reference
    const key = referenceKey(reference)
    if (scheduled.has(key)) return
    const work = (async () => {
      const module = await dependencies.load(url)
      if (module.loader !== 'ts' && !/\.d\.[cm]?ts(?:\?|$)/.test(module.url))
        throw new Error(`The declaration URL ${module.url} did not return a TypeScript declaration`)
      const refs = preProcessFile(module.source, true, true)
      const replacements: Array<{ start: number; end: number; target: DeclarationReference }> = []
      for (const ref of [...refs.importedFiles, ...refs.referencedFiles, ...refs.typeReferenceDirectives]) {
        const specifier = ref.fileName
        // The local React declarations describe the vendored React instance.
        if (Object.hasOwn(typed, specifier) && dependencies.resolve(specifier).kind === 'vendor') continue
        let target: DeclarationReference
        if (local(specifier) || specifier.startsWith('https://')) {
          target = await declarationTarget({ url: new URL(specifier, module.url).href, managed }, module.url)
        } else {
          const resolved = dependencies.resolve(specifier)
          if (resolved.kind === 'vendor') continue
          const dependency = await dependencies.load(resolved.path)
          if (!dependency.types)
            throw new Error(`No declarations advertised by "${specifier}", imported by ${module.url}`)
          rememberTypes(resolved.path, dependency.types)
          target = { url: dependency.types, managed: usesDefaultDependencyBuild(resolved.path) }
        }
        const start = module.source.indexOf(specifier, ref.pos)
        if (start < ref.pos || start > ref.end)
          throw new Error(`Could not locate declaration import "${specifier}" in ${module.url}`)
        schedule(target)
        replacements.push({ start, end: start + specifier.length, target })
      }
      declarations.set(key, { reference, source: module.source, replacements })
    })()
    scheduled.set(key, { reference, work })
    // A child may fail before the queue reaches it. The error is still read
    // below, but it must not become an unhandled rejection in the meantime.
    work.catch(() => {})
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
      // A library's declarations are in the check library; the packages they
      // import are fetched as if the App imported them itself.
      const library = appLibrary(ref.fileName)
      for (const specifier of library ? library.types : [ref.fileName]) {
        const uses = roots.get(specifier) ?? []
        uses.push({ file, source, ref })
        roots.set(specifier, uses)
      }
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
      if (module.loader === 'css' || module.loader === 'dataurl' || module.loader === 'binary' || module.loader === 'json') {
        const path = module.loader === 'json'
          ? `/app/dependencies/${encodeURIComponent(module.url)}.json`
          : virtualPath(module.url)
        result.paths[specifier] = [path]
        result.files[path] = module.loader === 'json' ? module.source
          : module.loader === 'css' ? 'export {};'
            : module.loader === 'binary' ? 'declare const bytes: Uint8Array; export default bytes;'
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
      rootDeclarations.set(specifier, { url: module.types, managed: usesDefaultDependencyBuild(resolved.path) })
    } catch (error) {
      report(specifier, error instanceof Error ? error.message : String(error), 'APP_DEPENDENCY_RESOLVE')
    }
  }))

  // All root headers must be known before visiting children. Otherwise a fast
  // transitive import can create a second class identity before the direct
  // import's canonical declaration build has arrived.
  for (const types of rootDeclarations.values()) schedule(types)

  const read = new Set<string>()
  for (;;) {
    const pending = [...scheduled].filter(([key]) => !read.has(key))
    if (!pending.length) {
      // A transitive header can arrive after an unqualified URL was read.
      // Revisit its managed tree before assigning any virtual filenames.
      for (const { reference } of scheduled.values()) schedule(reference)
      if (read.size === scheduled.size) break
      continue
    }
    await Promise.all(pending.map(async ([key, { reference, work }]) => {
      read.add(key)
      try {
        await work
      } catch (error) {
        failures.set(key, {
          reference,
          message: `Could not load App dependency types: ${error instanceof Error ? error.message : String(error)}`,
        })
      }
    }))
  }

  for (const [specifier, reference] of rootDeclarations)
    result.paths[specifier] = [virtualPath(canonicalDeclaration(reference).url)]
  const emitted = new Map<string, boolean>()
  for (const [key, declaration] of declarations) {
    const reference = canonicalDeclaration(declaration.reference)
    if (key !== referenceKey(reference)) continue
    // A converged URL is one module, just as it is in the runtime bundler.
    // Prefer its managed visit deterministically if both policies reach it.
    if (emitted.get(reference.url) === true && !reference.managed) continue
    let source = declaration.source
    for (const { start, end, target } of declaration.replacements.sort((a, b) => b.start - a.start))
      source = source.slice(0, start) + virtualPath(canonicalDeclaration(target).url) + source.slice(end)
    result.files[virtualPath(reference.url)] = source
    emitted.set(reference.url, reference.managed)
  }
  for (const { reference, message } of failures.values())
    if (!declarations.has(referenceKey(canonicalDeclaration(reference))))
      result.problems.push({ kind: 'type', code: 'APP_DEPENDENCY_TYPES', message })
  return result
}
