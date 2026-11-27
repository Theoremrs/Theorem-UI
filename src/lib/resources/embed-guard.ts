// SOURCING: none. LINK-06's nested-embed handling: a cycle, a depth limit and a shared budget, each answered with a reason the embed shows as a collapsed card with a route to the original.

export const EMBED_MAX_DEPTH = 3
export const EMBED_MAX_COUNT = 24

export interface EmbedPath {
  depth: number
  /** Canonical keys of the embeds this one sits inside, outermost first. */
  ancestors: readonly string[]
  /** Shared by every embed rendered under one root. */
  budget: { used: number; max: number }
  maxDepth: number
}

export const rootEmbedPath = (
  options: { maxDepth?: number; maxCount?: number } = {},
): EmbedPath => ({
  depth: 0,
  ancestors: [],
  budget: { used: 0, max: options.maxCount ?? EMBED_MAX_COUNT },
  maxDepth: options.maxDepth ?? EMBED_MAX_DEPTH,
})

export type EmbedCollapse = 'cycle' | 'depth' | 'budget'

export type EmbedEntry =
  { ok: true; path: EmbedPath } | { ok: false; reason: EmbedCollapse }

/** Whether the embed of `key` may render inside `path`, and the path its own embeds see. */
export function enterEmbed(path: EmbedPath, key: string): EmbedEntry {
  if (path.ancestors.includes(key)) return { ok: false, reason: 'cycle' }
  if (path.depth >= path.maxDepth) return { ok: false, reason: 'depth' }
  if (path.budget.used >= path.budget.max)
    return { ok: false, reason: 'budget' }
  path.budget.used += 1
  return {
    ok: true,
    path: {
      ...path,
      depth: path.depth + 1,
      ancestors: [...path.ancestors, key],
    },
  }
}

export const COLLAPSE_LABEL: Record<EmbedCollapse, string> = {
  cycle: 'This embeds itself, so it is shown as a link.',
  depth: 'Embedded too deeply to show here.',
  budget: 'Too many embeds on this page to show them all.',
}
