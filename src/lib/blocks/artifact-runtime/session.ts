// SOURCING: none: the mounted artifact's one selected context (the runtime
// binding of types.ts), and the observations kept for this browser session
// so a question can name an exact moment before the durable run store holds
// it. A kept observation says it lives only as long as the session; when it is
// gone, resolving it says so. It never resolves to the latest state instead.
import { isDigest } from './digest'
import { ARTIFACT_RUNTIME_SCHEMA } from './types'
import type { ArtifactSourceRef, ObservationRef, RuntimeBinding } from './types'
import { isIntegerText } from './values'

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

/** An observation reference read from JSON, or undefined when it is not one of this schema. */
export function readObservationRef(value: unknown): ObservationRef | undefined {
  const ref = record(value)
  if (!ref || ref.schema !== ARTIFACT_RUNTIME_SCHEMA) return undefined
  const { runId, index, domain, time, stateDigest } = ref
  if (typeof runId !== 'string' || !runId) return undefined
  if (!isIntegerText(index) || !isIntegerText(time)) return undefined
  if (typeof domain !== 'string' || !domain) return undefined
  if (!isDigest(stateDigest)) return undefined
  return ref as unknown as ObservationRef
}

/** A source reference read from JSON, or undefined. */
export function readSourceRef(value: unknown): ArtifactSourceRef | undefined {
  const ref = record(value)
  if (ref?.kind === 'document')
    return typeof ref.documentId === 'string' &&
      isIntegerText(ref.position) &&
      typeof ref.contentDigest === 'string'
      ? (ref as unknown as ArtifactSourceRef)
      : undefined
  if (ref?.kind === 'commit')
    return typeof ref.repository === 'string' && typeof ref.commit === 'string'
      ? (ref as unknown as ArtifactSourceRef)
      : undefined
  return undefined
}

/** Whether two source references name the same revision. */
export function sameSource(
  a: ArtifactSourceRef | undefined,
  b: ArtifactSourceRef | undefined,
): boolean {
  if (!a || !b || a.kind !== b.kind) return false
  if (a.kind === 'document' && b.kind === 'document')
    return (
      a.documentId === b.documentId &&
      a.position === b.position &&
      a.contentDigest === b.contentDigest
    )
  if (a.kind === 'commit' && b.kind === 'commit')
    return (
      a.repository === b.repository &&
      a.commit === b.commit &&
      (a.path ?? '') === (b.path ?? '')
    )
  return false
}

/** Whether two observation references name the same moment of the same run. */
export const sameObservation = (
  a: ObservationRef | undefined,
  b: ObservationRef | undefined,
): boolean =>
  Boolean(
    a &&
    b &&
    a.runId === b.runId &&
    a.index === b.index &&
    a.stateDigest === b.stateDigest,
  )

/** What resolving an observation found. */
export type Resolved<T> =
  | {
      status: 'available'
      ref: ObservationRef
      value: T
      lifetime: 'session' | 'durable'
    }
  | {
      status: 'unavailable'
      ref: ObservationRef
      reason: 'not-kept' | 'evicted' | 'digest-mismatch'
    }

const keyOf = (ref: ObservationRef) => `${ref.runId}\u0000${ref.index}`

/**
 * Observations kept for this session, at most `limit`, oldest dropped first.
 * A dropped observation resolves as `evicted`, not as whatever is newest.
 */
export class SessionObservations<T> {
  private readonly kept = new Map<string, { ref: ObservationRef; value: T }>()
  private readonly evicted = new Set<string>()

  constructor(private readonly limit = 5000) {}

  keep(ref: ObservationRef, value: T): void {
    const key = keyOf(ref)
    this.kept.delete(key)
    this.evicted.delete(key)
    this.kept.set(key, { ref, value })
    while (this.kept.size > this.limit) {
      const oldest = this.kept.keys().next().value!
      this.kept.delete(oldest)
      this.evicted.add(oldest)
    }
  }

  resolve(ref: ObservationRef): Resolved<T> {
    const key = keyOf(ref)
    const kept = this.kept.get(key)
    if (!kept)
      return {
        status: 'unavailable',
        ref,
        reason: this.evicted.has(key) ? 'evicted' : 'not-kept',
      }
    if (kept.ref.stateDigest !== ref.stateDigest)
      return { status: 'unavailable', ref, reason: 'digest-mismatch' }
    return { status: 'available', ref, value: kept.value, lifetime: 'session' }
  }

  get size(): number {
    return this.kept.size
  }
}

/**
 * The binding of what is on screen. A question or a piece of feedback takes
 * `capture()` when it is made and keeps that copy, so a later selection or a
 * newer build never changes what it was about.
 */
export class RuntimeSession {
  private binding: RuntimeBinding | undefined
  private readonly listeners = new Set<() => void>()

  get current(): RuntimeBinding | undefined {
    return this.binding
  }

  set(binding: RuntimeBinding | undefined): void {
    // A binding written by plain JavaScript, or by another version, is refused.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (binding && binding.schema !== ARTIFACT_RUNTIME_SCHEMA)
      throw new Error(
        `A runtime binding of ${String(binding.schema)} is not ${ARTIFACT_RUNTIME_SCHEMA}`,
      )
    this.binding = binding
    for (const listener of this.listeners) listener()
  }

  /** Moves the shown moment, keeping the rest of the binding. */
  observe(observation: ObservationRef | undefined): void {
    if (!this.binding) return
    this.set({ ...this.binding, observation })
  }

  capture(): RuntimeBinding | undefined {
    return this.binding && structuredClone(this.binding)
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => void this.listeners.delete(listener)
  }
}
