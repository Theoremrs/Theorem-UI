// SOURCING: src/lib/blocks/app-dependencies.ts (AppDependencies, the one
// resolver App build and type check share) and ./digest. No second resolver:
// every import specifier goes through `AppDependencies.resolve`, and a
// remote module's bytes are fetched through its own `load` and digested, so a
// release names exactly what it was built from.
import type { AppDependencies } from '@/lib/blocks/app-dependencies'
import { appDependencies } from '@/lib/blocks/app-dependencies'
import type { AppSources } from '@/lib/blocks/app-source'
import { sha256 } from './digest'
import type { Diagnostic, ResolvedDependency } from './types'

const IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])([^'"\n]+)\1/g

/** The bare and https specifiers the source files import; the App's own relative files are not. */
export function importedSpecifiers(files: Record<string, string>): string[] {
  const found = new Set<string>()
  for (const [path, text] of Object.entries(files)) {
    if (!/\.(?:tsx?|jsx?)$/.test(path)) continue
    for (const match of text.matchAll(IMPORT)) {
      const specifier = match[2]!
      if (/^\.{0,2}\//.test(specifier)) continue
      found.add(specifier)
    }
  }
  return [...found].sort()
}

export class DependencyError extends Error {
  constructor(readonly diagnostics: Diagnostic[]) {
    super(diagnostics.map((d) => d.message).join('; '))
    this.name = 'DependencyError'
  }
}

/**
 * Resolves an App's imports to exact versions or URLs and digests the bytes of
 * each remote module. A specifier that cannot be resolved or fetched is an
 * error naming it: a release is never recorded with a dependency it did not read.
 */
export async function resolveAppDependencies(
  sources: AppSources,
  resolver: AppDependencies = appDependencies(sources),
): Promise<ResolvedDependency[]> {
  const out: ResolvedDependency[] = []
  const problems: Diagnostic[] = []
  for (const specifier of importedSpecifiers(sources.files)) {
    try {
      const resolved = resolver.resolve(specifier)
      if (resolved.kind !== 'url') {
        out.push({ specifier, kind: resolved.kind, resolved: resolved.path })
        continue
      }
      const module = await resolver.load(resolved.path)
      out.push({
        specifier,
        kind: 'url',
        resolved: module.url,
        contentDigest: await sha256(
          module.bytes ? [...module.bytes].join(',') : module.source,
        ),
      })
    } catch (error) {
      problems.push({
        stage: 'resolve',
        severity: 'error',
        message: `${specifier}: ${error instanceof Error ? error.message : String(error)}`,
        hint: 'Check the package name and version, and that you are online.',
      })
    }
  }
  if (problems.length) throw new DependencyError(problems)
  return out
}
