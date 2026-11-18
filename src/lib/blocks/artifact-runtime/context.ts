// SOURCING: none: the general context layer of docs/plans/durable-artifacts
// (the general-creation addendum, section 5). A question, a piece of feedback
// or an evaluation is about a subject: a source revision, a result, or one
// moment of a run. None of these needs a run, a clock, a scene or a
// checkpoint; a run moment is one kind of subject, used by artifacts that
// execute over time. What a selection inside a subject means is the authored
// artifact's to say: the host carries it with its schema and version and
// never branches on it.
import { canonicalJson, digestOf, isDigest } from './digest'
import { readObservationRef, readSourceRef } from './session'
import { ARTIFACT_RUNTIME_SCHEMA } from './types'
import type {
  ArtifactSourceRef,
  BuildRef,
  Digest,
  IntegerText,
  ObservationRef,
  Reproducibility,
  RunRef,
} from './types'
import { isIntegerText } from './values'

/** A schema and its version, as an adapter, selector or representation declares itself. */
export interface Versioned {
  schema: string
  version: string
}

/**
 * How a result came to be. `computed`: made inside a project, from a source,
 * an optional build and inputs, by an optional operation; a run and moment
 * are optional execution details. `captured`: read from somewhere else (an
 * App's own data, an upload, a measurement, an external service's response).
 * What is known of its producer is kept, what is not is listed in
 * `unknowns`, and no build or reproducibility is invented for it. The
 * capturing adapter's build names the capture, not the producer.
 */
export type ResultProvenance =
  | {
      kind: 'computed'
      source: ArtifactSourceRef
      build?: BuildRef['id']
      operation?: Versioned & { name: string }
      inputs?: Record<string, Digest>
      execution?: { runId?: string; observation?: ObservationRef }
    }
  | {
      kind: 'captured'
      /** When it was captured: an RFC 3339 instant with its offset. */
      capturedAt: string
      /** What did the capturing: the App or adapter revision that read it. */
      capturer?: { source: ArtifactSourceRef; build?: BuildRef['id'] }
      /**
       * The system observed and the version of its data at capture, when it
       * has one (`reservations`, `"rev-412"`); an unversioned response leaves
       * `version` out and says so in `unknowns`.
       */
      from?: { system: string; version?: string; locator?: string }
      /** What is known of the producer, as the capture reported it. */
      producer?: Record<string, string>
      /** What is not known: `producer-build`, `data-version`, `instrument-calibration`, … */
      unknowns: Array<string>
    }

/**
 * One immutable output or piece of data, by the digest of its bytes (or of
 * its canonical JSON), with how it came to be. Its `id` is the digest of
 * everything else, so the same bytes from another provenance are another
 * result.
 */
export interface ResultRef {
  schema: typeof ARTIFACT_RUNTIME_SCHEMA
  id: Digest
  content: Digest
  bytes?: IntegerText
  /** `application/json`, `model/gltf-binary`, `text/csv`, `audio/wav`, … */
  mediaType: string
  /** What the bytes mean, as the authoring capability names it. */
  representation?: Versioned
  provenance: ResultProvenance
  /** `unknown` for a capture: nothing is claimed about reproducing it. */
  reproducibility: Reproducibility | 'unknown'
}

/** What a question, feedback or evaluation is about. */
export type SubjectRef =
  | { kind: 'source'; source: ArtifactSourceRef }
  | { kind: 'result'; result: ResultRef }
  /** One moment of a run, for an artifact that executes over time. */
  | { kind: 'moment'; observation: ObservationRef; run?: RunRef }

/**
 * A place inside a subject: a component, a mesh face, a cell, a data row, a
 * waveform interval, a passage. Its `value` is JSON the authored artifact
 * interprets under `schema`/`version`; the host carries it unread.
 */
export interface SelectionRef extends Versioned {
  value: unknown
  /** How a person would name it, for display only. */
  label?: string
}

/** The selector a host uses for a `[data-entity-id]` it saw clicked, when the App names none. */
export const ENTITY_SELECTOR: Versioned = {
  schema: 'theorem.entity-id',
  version: '1',
}

/**
 * What is on screen, bound together: the presentation actually rendered
 * (which may be older than the latest source, when a newer one failed), the
 * subject it shows (which may come from older source still, when a
 * presentation-only revision reuses it), where inside it, and how the
 * presentation reads it.
 */
export interface ContextBinding {
  schema: typeof ARTIFACT_RUNTIME_SCHEMA
  presentation: { source: ArtifactSourceRef; build?: BuildRef['id'] }
  subject?: SubjectRef
  selection?: SelectionRef
  /** The interpretation the presentation reads the subject through. */
  mapping?: Versioned
  /** When the latest source is not the one on screen: why, and which it is. */
  latest?: { source: ArtifactSourceRef; status: 'building' | 'failed' }
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

const text = (value: unknown, limit = 400): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= limit

const readVersioned = (value: unknown): Versioned | undefined => {
  const ref = record(value)
  return ref && text(ref.schema, 200) && text(ref.version, 100)
    ? { schema: ref.schema, version: ref.version }
    : undefined
}

/** The parts of a result its id is the digest of. */
const identified = (result: Omit<ResultRef, 'id'> | ResultRef) => {
  const { id: _id, ...rest } = result as ResultRef
  return rest
}

/**
 * A result reference with its id computed. A capture is never given a
 * reproducibility other than `unknown`; a computed result without a stated
 * one is `recorded`.
 */
export async function resultRef(
  result: Omit<ResultRef, 'id' | 'schema' | 'reproducibility'> & {
    reproducibility?: ResultRef['reproducibility']
  },
): Promise<ResultRef> {
  const reproducibility =
    result.provenance.kind === 'captured'
      ? 'unknown'
      : (result.reproducibility ?? 'recorded')
  const body = {
    ...result,
    schema: ARTIFACT_RUNTIME_SCHEMA,
    reproducibility,
  } satisfies Omit<ResultRef, 'id'>
  return { ...body, id: await digestOf(body) }
}

/** Whether a result's id is the digest of the rest of it. */
export async function resultIdHolds(result: ResultRef): Promise<boolean> {
  return (await digestOf(identified(result))) === result.id
}

function readProvenance(value: unknown): ResultProvenance | undefined {
  const ref = record(value)
  if (ref?.kind === 'computed')
    return readSourceRef(ref.source)
      ? (ref as unknown as ResultProvenance)
      : undefined
  if (ref?.kind === 'captured')
    return text(ref.capturedAt, 64) &&
      Array.isArray(ref.unknowns) &&
      ref.unknowns.every((item) => text(item, 200)) &&
      !('build' in ref) &&
      !('source' in ref)
      ? (ref as unknown as ResultProvenance)
      : undefined
  return undefined
}

/** A result reference read from JSON, or undefined. The id is not recomputed; resultIdHolds does. */
export function readResultRef(value: unknown): ResultRef | undefined {
  const ref = record(value)
  if (!ref || ref.schema !== ARTIFACT_RUNTIME_SCHEMA) return undefined
  if (!isDigest(ref.id) || !isDigest(ref.content)) return undefined
  if (ref.bytes !== undefined && !isIntegerText(ref.bytes)) return undefined
  if (!text(ref.mediaType, 200)) return undefined
  if (ref.representation !== undefined && !readVersioned(ref.representation))
    return undefined
  const provenance = readProvenance(ref.provenance)
  if (!provenance) return undefined
  const reproducible = ['deterministic', 'recorded', 'nondeterministic', 'unknown']
  if (!reproducible.includes(String(ref.reproducibility))) return undefined
  if (provenance.kind === 'captured' && ref.reproducibility !== 'unknown')
    return undefined
  return ref as unknown as ResultRef
}

/** A subject read from JSON, or undefined. */
export function readSubjectRef(value: unknown): SubjectRef | undefined {
  const ref = record(value)
  if (ref?.kind === 'source') {
    const source = readSourceRef(ref.source)
    return source && { kind: 'source', source }
  }
  if (ref?.kind === 'result') {
    const result = readResultRef(ref.result)
    return result && { kind: 'result', result }
  }
  if (ref?.kind === 'moment') {
    const observation = readObservationRef(ref.observation)
    if (!observation) return undefined
    const run = record(ref.run)
    return run && run.id === observation.runId
      ? { kind: 'moment', observation, run: run as unknown as RunRef }
      : { kind: 'moment', observation }
  }
  return undefined
}

/** A selection read from JSON, or undefined. Its value must be JSON of at most 2 KB. */
export function readSelectionRef(value: unknown): SelectionRef | undefined {
  const ref = record(value)
  const versioned = readVersioned(ref)
  if (!ref || !versioned || !('value' in ref)) return undefined
  let json: string
  try {
    json = canonicalJson(ref.value)
  } catch {
    return undefined
  }
  if (new TextEncoder().encode(json).length > 2048) return undefined
  return {
    ...versioned,
    value: ref.value,
    ...(text(ref.label, 200) && { label: ref.label }),
  }
}

/** Whether two subjects name the same thing exactly. */
export function sameSubject(
  a: SubjectRef | undefined,
  b: SubjectRef | undefined,
): boolean {
  if (!a || !b || a.kind !== b.kind) return false
  if (a.kind === 'source' && b.kind === 'source')
    return canonicalJson(a.source) === canonicalJson(b.source)
  if (a.kind === 'result' && b.kind === 'result')
    return a.result.id === b.result.id
  if (a.kind === 'moment' && b.kind === 'moment')
    return (
      a.observation.runId === b.observation.runId &&
      a.observation.index === b.observation.index &&
      a.observation.stateDigest === b.observation.stateDigest
    )
  return false
}

/** A short name for a subject, for a person to read. */
export function subjectLabel(subject: SubjectRef): string {
  if (subject.kind === 'source')
    return subject.source.kind === 'document'
      ? `revision ${subject.source.position}`
      : `commit ${subject.source.commit.slice(0, 12)}`
  if (subject.kind === 'result') {
    const from = subject.result.provenance
    return from.kind === 'captured' && from.from
      ? `${from.from.system}${from.from.version ? ` at ${from.from.version}` : ''}, captured ${from.capturedAt}`
      : `result ${subject.result.content.slice(7, 19)}`
  }
  return `${subject.observation.domain} ${subject.observation.time} of ${subject.observation.runId}`
}

/** A context binding read from JSON, or undefined. */
export function readContextBinding(value: unknown): ContextBinding | undefined {
  const ref = record(value)
  if (!ref || ref.schema !== ARTIFACT_RUNTIME_SCHEMA) return undefined
  const presentation = record(ref.presentation)
  const source = readSourceRef(presentation?.source)
  if (!source) return undefined
  const subject = ref.subject === undefined ? undefined : readSubjectRef(ref.subject)
  if (ref.subject !== undefined && !subject) return undefined
  const selection =
    ref.selection === undefined ? undefined : readSelectionRef(ref.selection)
  if (ref.selection !== undefined && !selection) return undefined
  const mapping = ref.mapping === undefined ? undefined : readVersioned(ref.mapping)
  if (ref.mapping !== undefined && !mapping) return undefined
  return ref as unknown as ContextBinding
}

/**
 * The binding of what is on screen. A question or a piece of feedback takes
 * `capture()` when it is made and keeps that copy, so a later selection, a
 * newer build or newer data never changes what it was about.
 */
export class ContextSession {
  private binding: ContextBinding | undefined
  private readonly listeners = new Set<() => void>()

  get current(): ContextBinding | undefined {
    return this.binding
  }

  set(binding: ContextBinding | undefined): void {
    // A binding written by plain JavaScript, or by another version, is refused.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (binding && binding.schema !== ARTIFACT_RUNTIME_SCHEMA)
      throw new Error(
        `A context binding of ${String(binding.schema)} is not ${ARTIFACT_RUNTIME_SCHEMA}`,
      )
    this.binding = binding
    for (const listener of this.listeners) listener()
  }

  /** Moves to another subject (and drops the selection, which was inside the old one). */
  focus(subject: SubjectRef | undefined, selection?: SelectionRef): void {
    if (!this.binding) return
    const { selection: _old, subject: _subject, ...rest } = this.binding
    this.set({
      ...rest,
      ...(subject && { subject }),
      ...(selection && { selection }),
    })
  }

  select(selection: SelectionRef | undefined): void {
    if (!this.binding) return
    const { selection: _old, ...rest } = this.binding
    this.set({ ...rest, ...(selection && { selection }) })
  }

  capture(): ContextBinding | undefined {
    return this.binding && structuredClone(this.binding)
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => void this.listeners.delete(listener)
  }
}
