// SOURCING: none yet. This is the one adapter where Theorem's Resolve, Search and References routes plug in when the backend serves them (REF-02). Until a route exists each operation answers `unsupported`, so nothing is fabricated and nothing falls back to unrelated content.
import type {
  OpCtx,
  ReferencesPage,
  ReferencesRequest,
  ResolveResult,
  SearchPage,
  SearchRequest,
} from './provider'
import type { ResourceRef } from './types'

const unsupported = (operation: 'resolve' | 'search' | 'references') =>
  ({ state: 'unsupported', operation }) as const

/**
 * The routes this adapter calls, replaced by `installBackend` when the
 * backend serves them. Each takes the same request the provider functions do
 * and answers what they answer.
 */
export interface BackendRoutes {
  resolve?(ref: ResourceRef, ctx: OpCtx): Promise<ResolveResult>
  search?(request: SearchRequest, ctx: OpCtx): Promise<SearchPage>
  references?(
    ref: ResourceRef,
    request: ReferencesRequest,
    ctx: OpCtx,
  ): Promise<ReferencesPage>
}

let routes: BackendRoutes = {}

/** Plugs in the served routes; returns a function that takes them out. */
export function installBackend(next: BackendRoutes): () => void {
  routes = next
  return () => {
    if (routes === next) routes = {}
  }
}

export const resolve = async (ref: ResourceRef, ctx: OpCtx) =>
  routes.resolve ? routes.resolve(ref, ctx) : unsupported('resolve')

/** Cross-owner search stays grouped per provider; this serves a provider that has none of its own. */
export const search = async (request: SearchRequest, ctx: OpCtx) =>
  routes.search ? routes.search(request, ctx) : unsupported('search')

export const references = async (
  ref: ResourceRef,
  request: ReferencesRequest,
  ctx: OpCtx,
) =>
  routes.references
    ? routes.references(ref, request, ctx)
    : unsupported('references')
