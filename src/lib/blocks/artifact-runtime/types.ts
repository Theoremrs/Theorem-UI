// SOURCING: none: the references every surface of a durable artifact agrees
// on (docs/plans/durable-artifacts/README.md). They name what is shown and
// what was run; they are not a language for writing an artifact. An artifact
// with no engine is still an artifact: it has a source and a presentation and
// leaves the run fields out.
//
// Every count, index and time is written as decimal integer text, never a
// JavaScript number, so a 64-bit counter or a hardware cycle past 2^53
// crosses JSON exactly. `sha256:<hex>` digests are of canonical JSON
// (digest.ts) or of the bytes they name.

/** The version every reference below is written in. A reader refuses another. */
export const ARTIFACT_RUNTIME_SCHEMA = 'theorem.artifact-runtime/1'

/** `sha256:` and 64 lowercase hex digits. */
export type Digest = `sha256:${string}`

/** A non-negative integer as decimal text: `"0"`, `"18446744073709551615"`. */
export type IntegerText = string

/**
 * Where an artifact's source is, exactly. A document revision is Theorem's
 * own collaborative source; a commit is a repository's. Either is immutable
 * once named.
 */
export type ArtifactSourceRef =
  | {
      kind: 'document'
      documentId: string
      /** The document revision's position. */
      position: IntegerText
      /** The revision's content digest, as the document store reports it. */
      contentDigest: string
    }
  | {
      kind: 'commit'
      repository: string
      commit: string
      /** The artifact's folder within the repository, when it is not the root. */
      path?: string
    }

/** What a build was made from and what it made. A presentation build and an engine build are each one. */
export interface BuildRef {
  /** The build's identity: the digest of everything below but `outputs` and `receipt`. */
  id: Digest
  source: ArtifactSourceRef
  /** What was run: `theorem.app-bundle`, `emcc`, `cargo`, `verilator` or any other. */
  recipe: string
  toolchain: Record<string, string>
  flags?: Array<string>
  /** Lockfile digests by name, and resolved dependency versions by package. */
  locks?: Record<string, Digest>
  /** `browser-esm`, `wasm32-unknown-unknown`, `x86_64-linux-gnu`, … */
  target: string
  outputs: Record<string, Digest>
  /** Where the build's own record of itself is kept, when it is kept. */
  receipt?: Digest
}

/** What an engine adapter can actually do. An unclaimed capability is unsupported. */
export type EngineCapability =
  | 'reset'
  | 'step'
  | 'run-until'
  | 'inspect'
  | 'schedule-input'
  | 'checkpoint'
  | 'restore'
  | 'replay'

/** The executable that produced a run's observations, and how its state and observations are written. */
export interface EngineRef {
  /** `theorem.spatial-settle`, `chips.m6502`, `rapier3d`, … */
  kind: string
  version: string
  /** The digest of the executable itself, when there is one apart from the presentation. */
  executable?: Digest
  build?: BuildRef['id']
  adapter: { schema: string; version: string }
  observation: { schema: string; version: string }
  checkpoint?: { codec: string; version: string }
  capabilities: Array<EngineCapability>
}

/**
 * What a run's observations count in. An event index and a hardware cycle
 * are never the same domain: a teaching model's settle is a `settlement`,
 * not a clock cycle. `x-…` names a domain an adapter defines itself.
 */
export type TimeDomain =
  | 'event'
  | 'settlement'
  | 'hardware-cycle'
  | 'half-cycle'
  | 'instruction'
  | 'physical-time'
  | `x-${string}`

/**
 * How far a run can be reproduced: `deterministic` from its inputs alone,
 * `recorded` only from its saved observations, `nondeterministic` not at all.
 */
export type Reproducibility = 'deterministic' | 'recorded' | 'nondeterministic'

/** One execution, immutable once begun. A run edited in the past is a new run whose parent is this one. */
export interface RunRef {
  schema: typeof ARTIFACT_RUNTIME_SCHEMA
  id: string
  /** The source the run executed: its execution provenance, which a later presentation does not change. */
  source: ArtifactSourceRef
  build?: BuildRef['id']
  engine: EngineRef
  /** The machine or model configuration, by digest of its canonical JSON. */
  configuration?: Digest
  /** Program, memory images, assets and the input schedule, by name. */
  inputs?: Record<string, Digest>
  /** The run this one forked from, the observation it forked at and what changed. */
  parent?: {
    runId: string
    at: ObservationRef
    change: string
    checkpoint?: CheckpointRef
  }
  domains: Array<TimeDomain>
  reproducibility: Reproducibility
}

/** One moment of one run, exactly. */
export interface ObservationRef {
  schema: typeof ARTIFACT_RUNTIME_SCHEMA
  runId: string
  /** The observation's place in the run's event sequence, from 0. */
  index: IntegerText
  /** What `time` counts. */
  domain: TimeDomain
  time: IntegerText
  /** The digest of the canonical state the observation shows (values, states and inputs). */
  stateDigest: Digest
  checkpoint?: CheckpointRef
}

/** A saved engine state complete enough to resume from, with what it is compatible with. */
export interface CheckpointRef {
  engine: Pick<EngineRef, 'kind' | 'version' | 'executable'>
  codec: { name: string; version: string }
  /** The digest of the whole state blob. */
  blob: Digest
  bytes: IntegerText
  runId: string
  index: IntegerText
  /** The digest of every input applied before it; a fork must replay from the same history. */
  inputHistory: Digest
  /** How the blob was checked after writing: restored and observed equal, or only hashed. */
  verified: 'restored' | 'hashed'
}

/** How a signal's value between two observations is read. */
export type Interpolation = 'hold' | 'linear' | 'none'

/** What a signal is, apart from any value it has. */
export interface SignalDescriptor {
  /** Stable across revisions of the presentation: `cpu/a`, `pin/rdy`, `adder.carry`. */
  id: string
  label?: string
  type: 'bits' | 'integer' | 'real' | 'text' | 'bool'
  /** For bits and integers. */
  width?: number
  signed?: boolean
  unit?: string
  interpolation: Interpolation
  /** When in the domain's step the value is read: `after-settle`, `phi2-fall`, … */
  phase?: string
  /** For a control signal: whether its logical assertion is high or low on the physical pin. */
  polarity?: { asserted: 'high' | 'low'; pin?: string; note?: string }
}

/**
 * A value as its type carries it exactly. `bits` is hex, most significant
 * digit first, padded to `width`; `unknown` and `highZ` are hex masks over the
 * same bits, given only by an engine that has those states.
 */
export type SignalValue =
  | {
      type: 'bits'
      width: number
      hex: string
      unknown?: string
      highZ?: string
    }
  | { type: 'integer'; text: IntegerText | `-${IntegerText}` }
  | { type: 'real'; value: number; unit?: string }
  | { type: 'text'; text: string }
  | { type: 'bool'; value: boolean }

/** Where the person is looking, kept apart from any engine state: changing it never changes a run. */
export interface ViewState {
  camera?: {
    position: [number, number, number]
    target: [number, number, number]
    zoom?: number
  }
  selected?: string
  /** The path of nested views opened, outermost first. */
  opened?: Array<string>
  pinned?: Array<string>
  inspector?: 'open' | 'closed'
  comparison?: Array<string>
  cursor?: ObservationRef
}

/**
 * What is on screen, bound together: the presentation actually rendered (which
 * may be an older build than the latest source, when a newer one failed), the
 * run it shows (which may be older still, when a presentation-only revision
 * reuses it), how that run is read, and the moment shown.
 */
export interface RuntimeBinding {
  schema: typeof ARTIFACT_RUNTIME_SCHEMA
  presentation: { source: ArtifactSourceRef; build?: BuildRef['id'] }
  /** Set when the artifact executes something. */
  run?: RunRef
  /** The observation schema and entity mapping the presentation reads the run through. */
  mapping?: { schema: string; version: string }
  observation?: ObservationRef
  /** When the latest source is not the one on screen: why, and which it is. */
  latest?: { source: ArtifactSourceRef; status: 'building' | 'failed' }
}

/** A choice made about an artifact, with what it was made from. */
export interface DecisionRecord {
  id: string
  /** What the feedback was about: an entity, a view, a run, a moment, a source. */
  target: {
    entity?: string
    view?: ViewState
    observation?: ObservationRef
    source?: ArtifactSourceRef
  }
  feedback?: string
  reproduction?: ObservationRef
  rationale: string
  evidence: Array<Digest | string>
  candidate?: ArtifactSourceRef
  evaluation?: Digest
  outcome: 'accepted' | 'rejected' | 'pending'
  /** Whether the change stays with this artifact or is proposed for a shared library. */
  scope: 'artifact' | 'library'
}

/** A fact a question may rely on: one value, read from the observation it names. */
export interface ObservedFact {
  entity: string
  key: string
  value: SignalValue
  observation: ObservationRef
}
