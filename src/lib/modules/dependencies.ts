// SOURCING: lib/blocks/app-dependencies (AppDependencies, the one resolver
// Apps build with). A module's declared packages go through it unchanged, so a
// package resolves to the same vendored file or pinned CDN URL in a module as
// in an App (EXT-05). Nothing is fetched here; fetching stays in the resolver.
import { AppDependencies } from '@/lib/blocks/app-dependencies'

/** One declared package and what the shared resolver made of it. */
export interface ResolvedDependency {
  name: string
  /** The version or range the module file declared. */
  requested: string
  /** Where the resolver sends the import; absent when it refused. */
  resolved?: { kind: 'vendor' | 'url' | 'library'; path: string }
  /** The declared version names exactly one release, so the pin is durable. */
  exact: boolean
  /** The resolver's refusal, in its words. */
  error?: string
}

const EXACT = /^(?:npm:[^@]+@)?v?\d+\.\d+\.\d+(?:[-+][\w.]+)?$/

/** Resolves a module's `dependencies` map through the App resolver. */
export function resolveDependencies(
  declared: Record<string, string> | undefined,
): ResolvedDependency[] {
  if (!declared) return []
  const resolver = new AppDependencies({ ...declared })
  return Object.entries(declared).map(([name, requested]) => {
    const exact = EXACT.test(requested.trim())
    try {
      const { kind, path } = resolver.resolve(name)
      return { name, requested, resolved: { kind, path }, exact }
    } catch (error) {
      return {
        name,
        requested,
        exact,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  })
}
