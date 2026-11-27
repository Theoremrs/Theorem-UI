// SOURCING: zustand (the registry is a store, so a provider a module registers later reaches pickers and chips already open), as lib/commands/registry and lib/contributions/registry are; the contribution registry's resolveHandler for the open handler; @theoremharness/sdk resourceKey through ./types. The facade is REF-02: resolve, search, preview, references and open are adapters over the owners a provider wraps, with unsupported answered explicitly, never filled from unrelated content.
import { create } from 'zustand'
import { resolveHandler } from '@/lib/contributions/registry'
import type { HandlerResolution } from '@/lib/contributions/registry'
import { assertProvider, ProviderError } from './provider'
import type {
  Operation,
  OpCtx,
  PreviewResult,
  ReferencesPage,
  ReferencesRequest,
  ResolveResult,
  ResourceProvider,
  SearchPage,
} from './provider'
import { isOfflineError, stateOfError } from './state'
import type { NotReady } from './state'
import { baseKind, identityKey, serveKeys } from './types'
import type { ResourceIdentity, ResourceRef } from './types'
import * as backend from './backend'

interface Store {
  providers: ReadonlyMap<string, ResourceProvider>
}
export const useResourceProviders = create<Store>()(() => ({
  providers: new Map(),
}))

/**
 * Adds a provider. An id another provider holds is refused, never seized,
 * and a provider whose declared support disagrees with what it supplies is
 * refused. Returns the function that removes exactly this registration.
 */
export function registerProvider(provider: ResourceProvider): () => void {
  assertProvider(provider)
  const { providers } = useResourceProviders.getState()
  if (providers.has(provider.id))
    throw new ProviderError(provider.id, 'another provider holds this id')
  const next = new Map(providers)
  next.set(provider.id, provider)
  useResourceProviders.setState({ providers: next })
  return () => {
    const current = useResourceProviders.getState().providers
    if (current.get(provider.id) !== provider) return
    const without = new Map(current)
    without.delete(provider.id)
    useResourceProviders.setState({ providers: without })
  }
}

export const listProviders = (): ResourceProvider[] => [
  ...useResourceProviders.getState().providers.values(),
]

/** The provider serving a resource, the narrowest key first. */
export function providerFor(
  resource: ResourceIdentity,
): ResourceProvider | undefined {
  const all = listProviders()
  for (const key of serveKeys(resource)) {
    const found = all.find((p) => p.serves.includes(key))
    if (found) return found
  }
  return undefined
}

export const supports = (
  provider: ResourceProvider | undefined,
  op: Operation,
): boolean => provider?.support[op] === true

/** The owner's canonical key, or the identity key when the owner supplies none. */
export function canonicalKey(resource: ResourceIdentity): string {
  return (
    providerFor(resource)?.canonicalize?.(resource) ?? identityKey(resource)
  )
}

/** Whether two references name one resource: by canonical identity, never by label. */
export const sameResource = (a: ResourceIdentity, b: ResourceIdentity) =>
  canonicalKey(a) === canonicalKey(b)

export type Unsupported = { state: 'unsupported'; operation: Operation }

const unsupported = (operation: Operation): Unsupported => ({
  state: 'unsupported',
  operation,
})

/** Runs an owner call; its failure is a state, never an unhandled rejection or a stale ready. */
async function guarded<T extends { state: string }>(
  run: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T | { state: NotReady }> {
  try {
    return await run()
  } catch (error) {
    if (signal?.aborted) throw error
    return { state: stateOfError(error) }
  }
}

// Resolve

export async function resolve(
  ref: ResourceRef,
  ctx: OpCtx = {},
): Promise<ResolveResult | Unsupported> {
  const provider = providerFor(ref.resource)
  if (provider?.validate && !provider.validate(ref.resource))
    return { state: 'unavailable' }
  if (supports(provider, 'resolve'))
    return guarded(() => provider!.resolve!(ref, ctx), ctx.signal)
  // The backend's Resolve route, where one is served, answers for kinds no
  // provider here can.
  return guarded(() => backend.resolve(ref, ctx), ctx.signal) as Promise<
    ResolveResult | Unsupported
  >
}

export async function preview(
  ref: ResourceRef,
  ctx: OpCtx = {},
): Promise<PreviewResult | Unsupported> {
  const provider = providerFor(ref.resource)
  if (!supports(provider, 'preview')) return unsupported('preview')
  return guarded(() => provider!.preview!(ref, ctx), ctx.signal)
}

// Search

export type GroupStatus = 'ok' | 'failed' | 'unsupported' | 'offline'

/** One provider's part of a search, with the cursor that continues it. */
export interface SearchGroup {
  providerId: string
  label: string
  status: GroupStatus
  page?: SearchPage
  /** Why the group failed, for a retry notice; never a result. */
  error?: string
}

/** Whether a group's results are everything its owner holds for the query. */
export const groupComplete = (group: SearchGroup) =>
  group.status === 'ok' && !group.page?.next && !group.page?.truncated

export type Coverage = 'complete' | 'partial' | 'failed'

/**
 * Complete only when every selected provider answered and none has more or
 * was bounded. Anything else is partial; no provider answering is failed.
 * Never merges bounded lists and calls the result complete (REF-04).
 */
export function coverageOf(groups: readonly SearchGroup[]): Coverage {
  if (groups.length === 0) return 'complete'
  if (groups.every((g) => g.status !== 'ok')) return 'failed'
  return groups.every(groupComplete) ? 'complete' : 'partial'
}

export interface SearchOptions {
  query: string
  /** Searches only these providers; default: every provider that supports search. */
  providerIds?: readonly string[]
  limit?: number
  /** Each provider's own continuation, by provider id. */
  cursors?: Readonly<Record<string, string | undefined>>
  scope?: Record<string, Record<string, string>>
  signal?: AbortSignal
}

export interface SearchResult {
  query: string
  groups: SearchGroup[]
  coverage: Coverage
}

/**
 * Searches the selected providers, each on its own, with its own cursor and
 * its own failure. Groups keep provider order; their hits are never merged
 * into one ranking. A cancelled search rejects with its AbortError.
 */
export async function search(options: SearchOptions): Promise<SearchResult> {
  const { query, signal } = options
  const all = listProviders()
  const selected = options.providerIds
    ? options.providerIds.map(
        (id) =>
          all.find((p) => p.id === id) ??
          ({ id, label: id, missing: true } as const),
      )
    : all.filter((p) => supports(p, 'search'))
  const groups = await Promise.all(
    selected.map(async (provider): Promise<SearchGroup> => {
      if ('missing' in provider || !supports(provider, 'search'))
        return {
          providerId: provider.id,
          label: provider.label,
          status: 'unsupported',
        }
      try {
        const page = await provider.search!(
          {
            query,
            limit: options.limit,
            cursor: options.cursors?.[provider.id],
            scope: options.scope?.[provider.id],
          },
          { signal },
        )
        return {
          providerId: provider.id,
          label: provider.label,
          status: 'ok',
          page,
        }
      } catch (error) {
        if (signal?.aborted) throw error
        return {
          providerId: provider.id,
          label: provider.label,
          status: isOfflineError(error) ? 'offline' : 'failed',
          error: error instanceof Error ? error.message : 'Search failed.',
        }
      }
    }),
  )
  if (signal?.aborted)
    throw signal.reason ?? new DOMException('Aborted', 'AbortError')
  return { query, groups, coverage: coverageOf(groups) }
}

/**
 * Continues one group from its own cursor and returns the group with the new
 * page appended. A failure returns the earlier group unchanged with an error,
 * so a failed later page keeps what was shown.
 */
export async function searchMore(
  group: SearchGroup,
  options: Omit<SearchOptions, 'providerIds' | 'cursors'>,
): Promise<SearchGroup> {
  const cursor = group.page?.next
  if (!cursor) return group
  const { groups } = await search({
    ...options,
    providerIds: [group.providerId],
    cursors: { [group.providerId]: cursor },
  })
  const more = groups[0]!
  if (more.status !== 'ok' || !more.page)
    return {
      ...group,
      error: more.error ?? 'The next page could not be loaded.',
    }
  return {
    ...group,
    error: undefined,
    page: {
      ...more.page,
      hits: [...(group.page?.hits ?? []), ...more.page.hits],
    },
  }
}

// References

/**
 * Occurrences of references to or from a resource, one page. A failure
 * rejects: a failed query is never an empty page. Where no provider
 * participates the backend adapter answers, and with no route, unsupported.
 */
export async function references(
  ref: ResourceRef,
  request: ReferencesRequest,
  ctx: OpCtx = {},
): Promise<ReferencesPage | Unsupported> {
  const provider = providerFor(ref.resource)
  if (supports(provider, 'references'))
    return provider!.references!(ref, request, ctx)
  const answer = await backend.references(ref, request, ctx)
  return 'occurrences' in answer ? answer : unsupported('references')
}

// Open

export type OpenIntent = 'open' | 'beside' | 'replace'

export interface OpenRequest {
  ref: ResourceRef
  intent: OpenIntent
  /** The handler the person's preferences and the default order chose. */
  handlerId?: string
  resolution?: HandlerResolution
}

/** The shell's way to show a resource; the default navigates by route. */
export type OpenHost = (request: OpenRequest) => void | Promise<void>

let openHost: OpenHost | undefined
const hostStack: OpenHost[] = []

/**
 * Registers the host's opener (the dock). The latest registration serves;
 * removing it brings the earlier one back, and with none the default opener
 * navigates by route.
 */
export function registerOpenHost(host: OpenHost): () => void {
  hostStack.push(host)
  openHost = host
  return () => {
    const at = hostStack.lastIndexOf(host)
    if (at >= 0) hostStack.splice(at, 1)
    openHost = hostStack.at(-1)
  }
}

let defaultOpener: OpenHost = () => {}
/** Set by ./open: navigates by existing routes when no host is registered. */
export const setDefaultOpener = (opener: OpenHost) => {
  defaultOpener = opener
}

export type OpenResult =
  | { opened: true; handlerId?: string }
  | { opened: false; state: NotReady | 'unsupported' }

/**
 * Opens a resource: the destination's access is rechecked by resolving first
 * (a provider that cannot resolve leaves the check to the destination), the
 * handler is chosen in EXT-03's order, and the host shows it. Opening changes
 * presentation only.
 */
export async function open(
  ref: ResourceRef,
  intent: OpenIntent = 'open',
  options: { explicit?: string; ctx?: OpCtx } = {},
): Promise<OpenResult> {
  const provider = providerFor(ref.resource)
  if (!provider || !supports(provider, 'open'))
    return { opened: false, state: 'unsupported' }
  if (supports(provider, 'resolve')) {
    const answer = await resolve(ref, options.ctx)
    if (answer.state !== 'ready')
      return { opened: false, state: answer.state as NotReady }
  }
  const key = identityKey(ref.resource)
  let resolution: HandlerResolution | undefined
  for (const serves of serveKeys(ref.resource)) {
    const found = resolveHandler('open-handler', serves, {
      explicit: options.explicit,
      resourceKey: key,
    })
    if (found.handler) {
      resolution = found
      break
    }
  }
  const request: OpenRequest = {
    ref,
    intent,
    handlerId: resolution?.handler?.id,
    resolution,
  }
  try {
    await (openHost ?? defaultOpener)(request)
  } catch {
    // The host had nowhere to show it: say so, rather than claim it opened.
    return { opened: false, state: 'unavailable' }
  }
  return { opened: true, handlerId: request.handlerId }
}

export { baseKind }
