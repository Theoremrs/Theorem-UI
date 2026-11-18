// SOURCING: none: an artifact's authored operations, discoverable with their
// signatures, examples and recovery (the general-creation addendum, "Execution
// and recovery are capabilities"). There is no universal step function: an
// operation may solve a parameter set, run a batch, edit data, render or
// advance a simulation, and says what it can recover by. The host and the
// authoring agent list them and read their source; nothing branches on a name.
import { resultRef } from './context'
import type { ResultRef, Versioned } from './context'
import { canonicalJson, digestOf } from './digest'
import type { ArtifactSourceRef, BuildRef, Digest, Reproducibility } from './types'

/**
 * How an operation's results can be had again. `rerun`: run it again on the
 * same inputs (a reproducible batch or solve). `input-replay`: replay the
 * recorded inputs from a start. `checkpoint-restore`: restore a saved
 * complete state. `reopen`: read the stored result; it cannot be remade.
 * `x-…`: a recovery an adapter defines.
 */
export type Recovery =
  | 'rerun'
  | 'input-replay'
  | 'checkpoint-restore'
  | 'reopen'
  | `x-${string}`

/** What an operation says about itself: what the agent and the host discover. */
export interface OperationDescriptor {
  /** Stable within the artifact: `solve`, `book`, `slider.position`. */
  name: string
  /** Changes whenever the operation's meaning changes; results cache by it. */
  version: string
  summary: string
  /** The input and output, as JSON Schema or the authored representation's own description. */
  input: unknown
  output: unknown
  /** What the result means, when it has a named representation. */
  representation?: Versioned
  reproducibility: Reproducibility
  recovery: Array<Recovery>
  /** Worked examples: real inputs, and the output they produce when it is stated. */
  examples?: Array<{ input: unknown; output?: unknown; note?: string }>
  /** Other operations, libraries or data it reads. */
  dependencies?: Array<string>
  /** Where it is written, `solver.ts:12`; the host fills it from the source when it can. */
  source?: { file: string; line: number }
}

/** An operation: its descriptor and the code that runs it. */
export interface Operation<TInput = unknown, TOutput = unknown> extends OperationDescriptor {
  /** Refuses an input that is not this operation's, before it runs. */
  accepts?: (input: unknown) => input is TInput
  run: (input: TInput) => TOutput | Promise<TOutput>
}

/** One invocation's output, and the result reference it is stored under. */
export interface Invocation<TOutput = unknown> {
  output: TOutput
  result: ResultRef
  /** Whether the output came from an earlier invocation with the same key. */
  reused: boolean
}

const NAME = /^[A-Za-z][\w.-]{0,79}$/

/**
 * The operations an artifact defines, and their results by exact key: the
 * source and build they run in, the operation's name and version, and the
 * digest of the input. Anything else (a colormap, a camera) is not in the
 * key, so changing it reuses the result; changing any of those is a miss.
 */
export class Operations {
  private readonly defined = new Map<string, Operation>()
  private readonly results = new Map<string, Invocation>()

  constructor(
    private readonly runsIn: {
      source: ArtifactSourceRef
      build?: BuildRef['id']
    },
  ) {}

  define<TInput, TOutput>(operation: Operation<TInput, TOutput>): Operation<TInput, TOutput> {
    if (!NAME.test(operation.name))
      throw new Error(`"${operation.name}" is not an operation name`)
    if (this.defined.has(operation.name))
      throw new Error(`${operation.name} is already defined`)
    this.defined.set(operation.name, operation as Operation)
    return operation
  }

  /** Every operation's descriptor, by name; the code is not included. */
  list(): Array<OperationDescriptor> {
    return [...this.defined.values()]
      .map(describe)
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  describe(name: string): OperationDescriptor | undefined {
    const operation = this.defined.get(name)
    return operation && describe(operation)
  }

  /** The exact key an invocation's result is kept under. */
  async key(name: string, input: unknown): Promise<Digest> {
    const operation = this.defined.get(name)
    if (!operation) throw new Error(`No operation is named ${name}`)
    return digestOf({
      source: this.runsIn.source,
      build: this.runsIn.build ?? null,
      operation: { name, version: operation.version },
      input: await digestOf(input),
    })
  }

  /**
   * Runs an operation, or returns the result already made for the same exact
   * key when the operation is deterministic. The output must be JSON.
   */
  async invoke<TOutput = unknown>(name: string, input: unknown): Promise<Invocation<TOutput>> {
    const operation = this.defined.get(name)
    if (!operation) throw new Error(`No operation is named ${name}`)
    if (operation.accepts && !operation.accepts(input))
      throw new Error(`${name} does not accept this input`)
    const key = await this.key(name, input)
    const kept = this.results.get(key)
    if (kept && operation.reproducibility === 'deterministic')
      return { ...(kept as Invocation<TOutput>), reused: true }
    const output = (await operation.run(input)) as TOutput
    const json = canonicalJson(output)
    const result = await resultRef({
      content: await digestOf(output),
      bytes: String(new TextEncoder().encode(json).length),
      mediaType: 'application/json',
      ...(operation.representation && {
        representation: operation.representation,
      }),
      provenance: {
        kind: 'computed',
        source: this.runsIn.source,
        ...(this.runsIn.build && { build: this.runsIn.build }),
        operation: {
          name,
          version: operation.version,
          schema: 'theorem.operation',
        },
        inputs: { input: await digestOf(input) },
      },
      reproducibility: operation.reproducibility,
    })
    const invocation = { output, result, reused: false }
    this.results.set(key, invocation)
    return invocation
  }
}

function describe(operation: Operation): OperationDescriptor {
  const { run: _run, accepts: _accepts, ...descriptor } = operation
  return structuredClone(descriptor)
}
