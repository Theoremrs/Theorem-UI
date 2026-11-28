// SOURCING: @theoremharness/sdk reference vocabulary (TheoremResource, TheoremLocation, TheoremRange, resourceKey) which every surface already uses to name what it shows; the record reference the composer sends (components/crm/reference). Kinds the SDK does not list yet are typed here as extensions of that vocabulary, not a second one (REF-01).
import type { TheoremRange, TheoremResource } from '@theoremharness/sdk'
import { resourceKey as sdkResourceKey } from '@theoremharness/sdk'
import type { RecordResource } from '@/components/crm/reference'

export type { RecordResource }

/** A document the Index holds (a note, a shared document), by its document id. */
export type DocumentResource = { kind: 'document'; documentId: string }
/** A Work item, by the tracker's item id. */
export type WorkItemResource = { kind: 'work-item'; itemId: string }
/** A Work project, by the tracker's project id. */
export type WorkProjectResource = { kind: 'work-project'; projectId: string }
/** A conversation, by its thread id; one message of it is a `message`. */
export type ThreadResource = { kind: 'thread'; threadId: string }
/**
 * A resource of a kind a module or integration registered, such as
 * `acme.ticket`. The kind is namespaced; its provider owns the id.
 */
export type ExtensionResource = {
  kind: 'extension'
  extensionKind: string
  id: string
}

/** What the SDK already names, plus what this workspace needs beyond it. */
export type ResourceIdentity =
  | TheoremResource
  | RecordResource
  | DocumentResource
  | WorkItemResource
  | WorkProjectResource
  | ThreadResource
  | ExtensionResource

/** The SDK's kinds, which `sdkResourceKey` keys. */
const SDK_KINDS: ReadonlySet<string> = new Set([
  'file',
  'artifact',
  'message',
  'run',
  'graph-object',
])

export const EXTENSION_KIND = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/

/** Whether `kind` is a namespaced extension kind (`acme.ticket`). */
export const isExtensionKind = (kind: string) => EXTENSION_KIND.test(kind)

/**
 * The provider key a resource is served under: its kind, or its namespaced
 * extension kind. `serveKeys` adds the narrower key a record's type gives.
 */
export const baseKind = (resource: ResourceIdentity): string =>
  resource.kind === 'extension' ? resource.extensionKind : resource.kind

/** Narrowest to widest: `record:company` before `record`. */
export const serveKeys = (resource: ResourceIdentity): string[] =>
  resource.kind === 'record'
    ? [`record:${resource.objectType}`, 'record']
    : [baseKind(resource)]

/** Live follows current state; pinned names a retained owner revision. */
export type RevisionMode =
  { mode: 'live' } | { mode: 'pinned'; revision: number | string }

/** A sub-resource inside the resource: an owner-defined place, or a range. */
export type ResourceSubLocation = {
  range?: TheoremRange
  /** A heading, block, field key or other anchor the owner defines. */
  anchor?: string
  /** A message inside a thread or a comment inside an item. */
  messageId?: string
}

/** Where a reference came from, as far as the owning contract records it. */
export type ResourceProvenance = {
  /** The source occurrence (a link or mention) this reference was read from. */
  occurrenceId?: string
  captureId?: string
  receiptId?: string
  /** An artifact's lineage, nearest first. */
  lineage?: string[]
  /** The thread an artifact or run was produced in, which is where it opens. */
  threadId?: string
}

/**
 * What a surface may show before it has asked the owner. Never authoritative:
 * access and state come from `resolve`, and a hint is dropped, not kept, when
 * the owner answers that the resource is unavailable.
 */
export type DisplayHint = { label?: string; icon?: string; type?: string }

/**
 * One reference: an identity the SDK or an owner names, plus how it is read
 * (live or pinned), where inside it, what to call it until the owner
 * answers, and where it came from.
 */
export interface ResourceRef {
  resource: ResourceIdentity
  location?: ResourceSubLocation
  revision?: RevisionMode
  hint?: DisplayHint
  provenance?: ResourceProvenance
}

export const live = (
  resource: ResourceIdentity,
  hint?: DisplayHint,
): ResourceRef => ({
  resource,
  revision: { mode: 'live' },
  ...(hint && { hint }),
})

/** A stable identity key. Never built from a label or a URL path. */
export function identityKey(resource: ResourceIdentity): string {
  if (SDK_KINDS.has(resource.kind))
    return sdkResourceKey(resource as TheoremResource)
  switch (resource.kind) {
    case 'record':
      return `record:${resource.objectType}/${resource.objectId}`
    case 'document':
      return `document:${resource.documentId}`
    case 'work-item':
      return `work-item:${resource.itemId}`
    case 'work-project':
      return `work-project:${resource.projectId}`
    case 'thread':
      return `thread:${resource.threadId}`
    case 'extension':
      return `${resource.extensionKind}:${resource.id}`
    default:
      return JSON.stringify(resource)
  }
}

/**
 * The key of one occurrence of a reference: identity, the revision it is
 * pinned at (live is its own), and the place inside it.
 */
export function refKey(ref: ResourceRef): string {
  const revision =
    ref.revision?.mode === 'pinned' ? `@${ref.revision.revision}` : ''
  const { range, anchor, messageId } = ref.location ?? {}
  const at = [
    messageId && `m=${messageId}`,
    anchor && `a=${anchor}`,
    range &&
      `r=${range.start.line}:${range.start.character}-${range.end.line}:${range.end.character}`,
  ]
    .filter(Boolean)
    .join(';')
  return `${identityKey(ref.resource)}${revision}${at ? `#${at}` : ''}`
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const text = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0

/** Whether a value read from storage or another surface is a resource this vocabulary names. */
export function isResourceIdentity(value: unknown): value is ResourceIdentity {
  if (!isObject(value) || !text(value.kind)) return false
  switch (value.kind) {
    case 'file':
      return text(value.workspaceId) && text(value.path)
    case 'artifact':
      return text(value.artifactId)
    case 'message':
      return text(value.threadId) && text(value.messageId)
    case 'run':
      return text(value.runId)
    case 'graph-object':
      return text(value.objectId)
    case 'record':
      return text(value.objectType) && text(value.objectId)
    case 'document':
      return text(value.documentId)
    case 'work-item':
      return text(value.itemId)
    case 'work-project':
      return text(value.projectId)
    case 'thread':
      return text(value.threadId)
    case 'extension':
      return isExtensionKind(String(value.extensionKind)) && text(value.id)
    default:
      return false
  }
}

/** Whether `text` has the shape of a kind this client has no provider for yet. */
export const hasUnknownKind = (value: unknown): boolean =>
  isObject(value) && text(value.kind) && !isResourceIdentity(value)
