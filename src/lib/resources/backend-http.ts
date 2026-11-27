// SOURCING: Theorem's native resource routes, `/api/resources/v1` (theorem-surface-contracts `resource_api.rs`, contract `theorem.resource-ref/1`; served by rustyred-thg-server `theorem_resources.rs`), called through lib/theorem/passthrough's theoremJson. The routes are read queries sent as POST bodies, so they carry no CSRF token or Idempotency-Key. This file only translates between this client's vocabulary and that wire; the owners behind the routes decide access and state.
import type { TheoremError } from '@theoremharness/sdk'
import { isNotServed, theoremJson } from '@/lib/theorem/passthrough'
import type { BackendRoutes } from './backend'
import type {
  ReferenceOccurrence,
  ReferencesPage,
  ReferencesRequest,
  ResolveResult,
  ResourceAction,
} from './provider'
import { RELATIONSHIP_KINDS } from './relationships'
import type { RelationshipKind } from './relationships'
import type { NotReady } from './state'
import type { ResourceIdentity, ResourceRef } from './types'

export const RESOURCES_ROUTE = '/api/resources/v1'

// ── The wire, as resource_api.rs serializes it ─────────────────────────────

type WireRef =
  | { kind: 'file'; workspaceId: string; path: string }
  | { kind: 'artifact'; artifactId: string; revision?: string }
  | { kind: 'message'; threadId: string; messageId: string }
  | { kind: 'run'; runId: string }
  | { kind: 'graph-object'; objectId: string; objectType?: string }
  | { kind: 'record'; objectType: string; objectId: string }
  | { kind: 'work-item'; itemId: string }
  | { kind: 'work-project'; projectId: string }
  | { kind: 'conversation'; threadId: string }
  | { kind: 'extension'; namespace: string; resourceType: string; id: string }

interface WireLocation {
  resource: WireRef
  range?: {
    start: { line: number; character: number }
    end: { line: number; character: number }
    unit: string
  }
  revision?: number | string
  anchor?: { kind: string; id: string }
}

type WireState =
  'available' | 'deleted' | 'not_found' | 'unsupported' | 'unavailable'

type WireOperation = 'resolve' | 'search' | 'preview' | 'references' | 'open'

interface WireResolved {
  reference: WireLocation
  state: WireState
  provider?: string
  display?: { label?: string; icon?: string; typeLabel?: string }
  currentRevision?: number | string
  operations: WireOperation[]
}

interface WireResolveResponse {
  contract: string
  results: Array<{ index: number; resolved?: WireResolved; state: WireState }>
}

type WireRelationship =
  | 'authored_mention'
  | 'authored_link'
  | 'authored_embed'
  | 'explicit_relation'
  | 'suggested'
  | 'accepted_association'
  | 'provenance'
  | 'operational_dependency'

interface WireOccurrence {
  occurrenceId: string
  source: WireLocation
  target: WireLocation
  relationship: WireRelationship
  relationType?: string
  label?: string
}

interface WireReferencesPage {
  contract: string
  groups: Array<{ peer: WireResolved; occurrences: WireOccurrence[] }>
  visiblePeerCount?: number
  nextCursor?: string
  coverage: Array<{
    provider: string
    state: 'complete' | 'partial' | 'failed' | 'unsupported'
    limitation?: string
  }>
}

// ── Identity ────────────────────────────────────────────────────────────────

const NAMESPACE = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/

/**
 * This client's identity on the wire, or none when the wire has no form for
 * it. A document is the `graph-object` the composer already sends for it; a
 * thread is a `conversation`. An extension kind `acme.crm.ticket` is the
 * provider namespace `acme.crm` and its type `ticket`; a kind whose prefix is
 * not itself a namespace (`acme.ticket`) has no wire form.
 */
export function toWireRef(resource: ResourceIdentity): WireRef | undefined {
  switch (resource.kind) {
    case 'file':
      return {
        kind: 'file',
        workspaceId: resource.workspaceId,
        path: resource.path,
      }
    case 'artifact':
      return {
        kind: 'artifact',
        artifactId: resource.artifactId,
        ...(resource.revision !== undefined && { revision: resource.revision }),
      }
    case 'message':
      return {
        kind: 'message',
        threadId: resource.threadId,
        messageId: resource.messageId,
      }
    case 'run':
      return { kind: 'run', runId: resource.runId }
    case 'graph-object':
      return {
        kind: 'graph-object',
        objectId: resource.objectId,
        ...(resource.objectType !== undefined && {
          objectType: resource.objectType,
        }),
      }
    case 'record':
      return {
        kind: 'record',
        objectType: resource.objectType,
        objectId: resource.objectId,
      }
    case 'document':
      return { kind: 'graph-object', objectId: resource.documentId }
    case 'work-item':
      return { kind: 'work-item', itemId: resource.itemId }
    case 'work-project':
      return { kind: 'work-project', projectId: resource.projectId }
    case 'thread':
      return { kind: 'conversation', threadId: resource.threadId }
    case 'extension': {
      const cut = resource.extensionKind.lastIndexOf('.')
      const namespace = resource.extensionKind.slice(0, cut)
      if (!NAMESPACE.test(namespace)) return undefined
      return {
        kind: 'extension',
        namespace,
        resourceType: resource.extensionKind.slice(cut + 1),
        id: resource.id,
      }
    }
    default:
      return undefined
  }
}

/** The wire's identity in this client's vocabulary; the inverse of `toWireRef`. */
export function fromWireRef(ref: WireRef): ResourceIdentity {
  switch (ref.kind) {
    case 'conversation':
      return { kind: 'thread', threadId: ref.threadId }
    case 'extension':
      return {
        kind: 'extension',
        extensionKind: `${ref.namespace}.${ref.resourceType}`,
        id: ref.id,
      }
    default:
      return ref
  }
}

function toWireLocation(ref: ResourceRef): WireLocation | undefined {
  // A message inside a thread is the message's own identity on the wire.
  const resource =
    ref.resource.kind === 'thread' && ref.location?.messageId
      ? toWireRef({
          kind: 'message',
          threadId: ref.resource.threadId,
          messageId: ref.location.messageId,
        })
      : toWireRef(ref.resource)
  if (!resource) return undefined
  return {
    resource,
    ...(ref.location?.range && { range: ref.location.range }),
    ...(ref.revision?.mode === 'pinned' && {
      revision: ref.revision.revision,
    }),
  }
}

function fromWireLocation(location: WireLocation, label?: string): ResourceRef {
  return {
    resource: fromWireRef(location.resource),
    revision:
      location.revision === undefined
        ? { mode: 'live' }
        : { mode: 'pinned', revision: location.revision },
    ...((location.range || location.anchor) && {
      location: {
        ...(location.range && {
          range: location.range as NonNullable<
            NonNullable<ResourceRef['location']>['range']
          >,
        }),
        ...(location.anchor && { anchor: location.anchor.id }),
      },
    }),
    ...(label && { hint: { label } }),
  }
}

// ── States, operations and relationships ───────────────────────────────────

/**
 * The public state in this client's terms. The wire's `not_found` already
 * folds missing and forbidden together, which is what `unavailable` means
 * here; the wire's `unavailable` (an outage) is unavailable too.
 */
export function stateFromWire(state: WireState): 'ready' | NotReady {
  switch (state) {
    case 'available':
      return 'ready'
    case 'deleted':
      return 'deleted'
    case 'unsupported':
      return 'unsupported'
    default:
      return 'unavailable'
  }
}

const ACTION_OF: Partial<Record<WireOperation, ResourceAction>> = {
  open: 'open',
  preview: 'preview',
  references: 'references',
}

const TO_WIRE_RELATIONSHIP: Record<RelationshipKind, WireRelationship> = {
  'authored-mention': 'authored_mention',
  'authored-link': 'authored_link',
  embed: 'authored_embed',
  'explicit-relation': 'explicit_relation',
  suggested: 'suggested',
  'accepted-association': 'accepted_association',
  citation: 'provenance',
  'operational-dependency': 'operational_dependency',
}

const FROM_WIRE_RELATIONSHIP = Object.fromEntries(
  Object.entries(TO_WIRE_RELATIONSHIP).map(([kind, wire]) => [wire, kind]),
) as Record<WireRelationship, RelationshipKind>

export const relationshipToWire = (kind: RelationshipKind) =>
  TO_WIRE_RELATIONSHIP[kind]
export const relationshipFromWire = (
  wire: string,
): RelationshipKind | undefined =>
  FROM_WIRE_RELATIONSHIP[wire as WireRelationship]

// ── Answers ────────────────────────────────────────────────────────────────

export function resolveFromWire(
  result: WireResolveResponse['results'][number] | undefined,
): ResolveResult {
  if (!result) return { state: 'unavailable' }
  const state = stateFromWire(result.resolved?.state ?? result.state)
  const resolved = result.resolved
  if (state !== 'ready' || !resolved) {
    return { state: state === 'ready' ? 'unavailable' : state }
  }
  const typeLabel =
    resolved.display?.typeLabel ?? resolved.reference.resource.kind
  return {
    state: 'ready',
    meta: {
      // Labels are hints; a resource the owner gave none for is named by its kind.
      title: resolved.display?.label ?? typeLabel,
      typeLabel,
      ...(resolved.display?.icon && { icon: resolved.display.icon }),
      ...(resolved.currentRevision !== undefined && {
        revision: resolved.currentRevision,
      }),
      actions: resolved.operations.flatMap((op) => ACTION_OF[op] ?? []),
    },
  }
}

/**
 * One page of occurrences. A page whose every provider failed is a failure,
 * never an empty page; one where some failed or were partial says its count
 * is not exact. Every occurrence opens at its source, where it is written.
 */
export function referencesFromWire(
  page: WireReferencesPage,
): ReferencesPage | { state: 'unsupported'; operation: 'references' } {
  const read = page.coverage.filter((c) => c.state !== 'unsupported')
  if (page.coverage.length > 0 && read.length === 0 && !page.groups.length)
    return { state: 'unsupported', operation: 'references' }
  if (
    read.length > 0 &&
    read.every((c) => c.state === 'failed') &&
    !page.groups.length
  )
    throw new Error(
      read.map((c) => c.limitation ?? `${c.provider} failed`).join('; '),
    )
  const exact = read.every((c) => c.state === 'complete')
  const occurrences: ReferenceOccurrence[] = []
  for (const group of page.groups) {
    const peerLabel = group.peer.display?.label
    for (const occurrence of group.occurrences) {
      const relationship = relationshipFromWire(occurrence.relationship)
      if (!relationship) continue
      const source = fromWireLocation(occurrence.source, peerLabel)
      occurrences.push({
        id: occurrence.occurrenceId,
        source,
        target: fromWireLocation(occurrence.target),
        relationship,
        destination: source,
        ...(occurrence.source.revision !== undefined && {
          sourceRevision: occurrence.source.revision,
        }),
        ...(occurrence.label && { snippet: occurrence.label }),
      })
    }
  }
  return {
    occurrences,
    ...(page.nextCursor && { next: page.nextCursor }),
    ...(page.visiblePeerCount !== undefined && {
      total: { count: page.visiblePeerCount, unit: 'sources', exact },
    }),
  }
}

// ── Routes ──────────────────────────────────────────────────────────────────

/** A Theorem that predates the routes answers 404/405 without a resource code. */
const routeMissing = (error: unknown) =>
  isNotServed(error) &&
  !String(
    ((error as TheoremError).body as { code?: unknown } | undefined)?.code ??
      '',
  ).startsWith('resource_')

type Post = <T>(operation: string, body: unknown) => Promise<T>

const post: Post = (operation, body) =>
  theoremJson(`${RESOURCES_ROUTE}/${operation}`, { method: 'POST', body })

/**
 * Resolve and References against the served routes. Search stays with each
 * provider's own search (the registry groups those per provider). `send` is
 * the transport, replaced in tests.
 */
export function httpBackend(send: Post = post): BackendRoutes {
  return {
    async resolve(ref) {
      const location = toWireLocation(ref)
      if (!location) return { state: 'unsupported' }
      try {
        const answer = await send<WireResolveResponse>('resolve', {
          references: [location],
        })
        return resolveFromWire(answer.results.find((r) => r.index === 0))
      } catch (error) {
        if (routeMissing(error)) return { state: 'unsupported' }
        throw error
      }
    },
    async references(ref, request: ReferencesRequest) {
      const resource = toWireRef(ref.resource)
      if (!resource) return UNSUPPORTED
      // None selected asks for every meaning, suggestions included; the
      // route leaves suggestions out unless they are named.
      const relationships = (
        request.relationships?.length
          ? request.relationships
          : RELATIONSHIP_KINDS
      ).map(relationshipToWire)
      try {
        const page = await send<WireReferencesPage>('references', {
          resource,
          direction: request.direction,
          relationships,
          ...(request.limit !== undefined && { limit: request.limit }),
          ...(request.cursor && { cursor: request.cursor }),
        })
        return referencesFromWire(page)
      } catch (error) {
        if (routeMissing(error)) return UNSUPPORTED
        throw error
      }
    },
  }
}

const UNSUPPORTED = { state: 'unsupported', operation: 'references' } as const
