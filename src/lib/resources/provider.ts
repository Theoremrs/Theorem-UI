// SOURCING: none. The provider contract is the spec's REF-03: identity validation, resolution, search coverage, preview, opening, reference participation, supported revisions and change notification, each declared and each explicitly unsupported when absent.
import type { RelationshipKind } from './relationships'
import type { NotReady, Tombstone } from './state'
import type { ResourceIdentity, ResourceRef } from './types'

export const OPERATIONS = [
  'resolve',
  'search',
  'preview',
  'references',
  'open',
  'revisions',
  'changes',
] as const
export type Operation = (typeof OPERATIONS)[number]

/** An action a surface may offer for a resolved resource. Offering it is not authorizing it. */
export type ResourceAction = 'open' | 'preview' | 'references' | 'copy-link'

/** What an owner says about one resource it let the caller see. */
export interface ResourceMeta {
  title: string
  /** The kind in words: "Company", "Work item", "Thread". */
  typeLabel: string
  subtitle?: string
  icon?: string
  /** The owner's revision of what was read. */
  revision?: number | string
  updatedAtMs?: number
  actions: ResourceAction[]
}

export type ResolveResult =
  | { state: 'ready'; meta: ResourceMeta }
  | { state: NotReady; tombstone?: Tombstone }

/** A field a preview shows; the value is the owner's, unread by the facade. */
export interface PreviewField {
  key: string
  label: string
  value: unknown
}

export interface PreviewData {
  title: string
  typeLabel: string
  excerpt?: string
  fields?: PreviewField[]
  /** What a context-specific preview renderer may enrich with (a record and its type, a run's progress). */
  detail?: unknown
}

export type PreviewResult =
  | { state: 'ready'; preview: PreviewData }
  | { state: NotReady; tombstone?: Tombstone }

export interface OpCtx {
  signal?: AbortSignal
}

export interface SearchRequest {
  query: string
  limit?: number
  /** The opaque cursor this provider last returned. */
  cursor?: string
  /** A provider-defined narrowing, such as a record type. */
  scope?: Record<string, string>
}

export interface SearchHit {
  ref: ResourceRef
  title: string
  typeLabel: string
  snippet?: string
}

export interface SearchPage {
  hits: SearchHit[]
  /** Present while the owner has more; opaque to everything but the provider. */
  next?: string
  /** The owner bounded or scanned a part of what it holds: more may exist than this search could reach. */
  truncated?: boolean
  /** The owner's own count of what it holds for the query, when it can say. */
  total?: number
}

export interface ReferencesRequest {
  direction: 'incoming' | 'outgoing'
  /** Only these meanings; none selected asks for every meaning the owner has. */
  relationships?: readonly RelationshipKind[]
  cursor?: string
  limit?: number
}

/** One authored or recorded occurrence of a connection. */
export interface ReferenceOccurrence {
  /** Stable for the occurrence, or the owner's anchor for it. */
  id: string
  /** Where it is written: grouped by this identity, never its title. */
  source: ResourceRef
  target: ResourceRef
  relationship: RelationshipKind
  /** Where opening this occurrence goes: the message, the block, the field. */
  destination: ResourceRef
  sourceRevision?: number | string
  snippet?: string
}

export interface ReferencesPage {
  occurrences: ReferenceOccurrence[]
  next?: string
  /** What the count counts: sources or occurrences the caller may see. */
  total?: { count: number; unit: 'sources' | 'occurrences'; exact: boolean }
}

/** How a provider says what it can do. Every flag is checked against the functions it supplies. */
export type Support = Partial<Record<Operation, true>>

export interface ResourceProvider {
  /** Namespaced and stable: `theorem.records`, `acme.tickets`. */
  id: string
  label: string
  /** The kinds it serves: `file`, `record`, `record:company`, `acme.ticket`. */
  serves: readonly string[]
  support: Support
  /** Whether `resource` is a well-formed identity for this provider, before any call. */
  validate?: (resource: ResourceIdentity) => boolean
  /**
   * The owner's canonical identity key when ids can differ for one resource
   * (a record, its document projection and a file placement). Absent, the
   * identity key is used. Equality is never inferred from labels.
   */
  canonicalize?: (resource: ResourceIdentity) => string | undefined
  resolve?: (ref: ResourceRef, ctx: OpCtx) => Promise<ResolveResult>
  search?: (request: SearchRequest, ctx: OpCtx) => Promise<SearchPage>
  preview?: (ref: ResourceRef, ctx: OpCtx) => Promise<PreviewResult>
  references?: (
    ref: ResourceRef,
    request: ReferencesRequest,
    ctx: OpCtx,
  ) => Promise<ReferencesPage>
  /** Calls `onChange` when the owner reports the resource changed or gone. Returns the unsubscribe. */
  subscribe?: (ref: ResourceRef, onChange: () => void) => () => void
  /** Whether it can read a pinned revision. */
  revisions?: { pinned: true }
}

const FUNCTION_OF: Partial<Record<Operation, keyof ResourceProvider>> = {
  resolve: 'resolve',
  search: 'search',
  preview: 'preview',
  references: 'references',
  changes: 'subscribe',
}

export class ProviderError extends Error {
  constructor(
    readonly id: string,
    detail: string,
  ) {
    super(`resource provider ${id}: ${detail}`)
    this.name = 'ProviderError'
  }
}

/** Refuses a provider whose declared support and supplied functions disagree. */
export function assertProvider(provider: ResourceProvider): void {
  const { id } = provider
  if (!/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/.test(id))
    throw new ProviderError(id, 'ids are dot-separated lowercase segments')
  if (provider.serves.length === 0)
    throw new ProviderError(id, 'it serves no kind')
  for (const op of OPERATIONS) {
    const fn = FUNCTION_OF[op]
    const declared = provider.support[op] === true
    if (fn && declared !== (typeof provider[fn] === 'function'))
      throw new ProviderError(
        id,
        declared
          ? `declares ${op} but supplies no function for it`
          : `supplies a function for ${op} it does not declare`,
      )
  }
  if (provider.support.revisions && !provider.revisions)
    throw new ProviderError(id, 'declares revisions without saying which')
}
