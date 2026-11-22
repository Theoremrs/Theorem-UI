// SOURCING: the platform's fetch, through this origin's Theorem proxy
// (src/server/theorem-proxy.ts adds the bearer), against the backend's typed
// Apps routes for durable artifacts (rustyred-thg-server
// theorem_apps_artifacts_api.rs; records in theorem-apps). Canonical JSON and
// digests are @theorem/runtime's, so the backend reads the same bytes. CSRF
// comes from the session bootstrap, as client.ts's mutate does.
import {
  ARTIFACT_RUNTIME_SCHEMA,
  canonicalJson,
  digestBytes,
} from '../blocks/artifact-runtime'
import type {
  CheckpointRef,
  Digest,
  IntegerText,
  ObservationRef,
  ResultRef,
  RunRef,
  SubjectRef,
} from '../blocks/artifact-runtime'

export const ARTIFACT_ROUTE = '/api/apps/v1/artifacts'

/** The most bytes one blob holds; the backend refuses more (MAX_ARTIFACT_BLOB_BYTES). */
export const MAX_BLOB_BYTES = 1024 * 1024
/** The most observations one chunk holds (MAX_CHUNK_OBSERVATIONS). */
export const MAX_CHUNK_OBSERVATIONS = 4096

/** One observation as a chunk records it: its place, its time and its state's digest. */
export interface ChunkObservation {
  index: IntegerText
  time: IntegerText
  stateDigest: Digest
}

/** A bounded run of observations, appended in order, naming its stored bytes. */
export interface TraceChunk {
  schema: typeof ARTIFACT_RUNTIME_SCHEMA
  runId: string
  sequence: IntegerText
  domain: string
  observations: Array<ChunkObservation>
  blob: Digest
  bytes: IntegerText
}

/** A run as another thread or App reads it back: the run, its chunks and its checkpoints. */
export interface RunRecords {
  run: RunRef
  chunks: Array<TraceChunk>
  checkpoints: Array<CheckpointRef>
}

/** What resolving a subject or an exact moment found; never the latest instead. */
export type DurableResolution =
  | { status: 'available'; [key: string]: unknown }
  | { status: 'unavailable'; reason: string; [key: string]: unknown }

/** The backend refused or failed a request; `code` is its own. */
export class ArtifactRefused extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'ArtifactRefused'
  }
}

/**
 * Whether asking again could get a different answer.
 *
 * A refusal the backend means literally — a 4xx other than a timeout or a
 * rate limit — says the request itself is wrong (malformed, out of order,
 * disagreeing with an immutable record), so repeating it only repeats the
 * bug. Everything else is an answer we did not get: the backend's own
 * transient status, or no status at all, because the transport failed before
 * a response existed. Those are worth retrying, and a write the store may
 * have accepted anyway is retried by re-sending, not by guessing.
 */
function retryable(error: unknown): boolean {
  if (!(error instanceof ArtifactRefused)) return true
  return error.status >= 500 || error.status === 408 || error.status === 429
}

type Request = (input: string, init: RequestInit) => Promise<Response>

export interface ArtifactStoreOptions {
  request?: Request
  /** The session's CSRF token; `fresh` asks for a new one after a 403. */
  csrf?: (fresh: boolean) => Promise<string>
}

async function sessionCsrf(fresh: boolean) {
  const { bootstrap } = await import('./client')
  return (await bootstrap(fresh)).csrfToken
}

/** Standard padded base64, as the backend reads bytes. */
export function base64Of(bytes: Uint8Array): string {
  let text = ''
  for (let start = 0; start < bytes.length; start += 0x8000)
    text += String.fromCharCode(...bytes.subarray(start, start + 0x8000))
  return btoa(text)
}

export function bytesOf(base64: string): Uint8Array {
  const text = atob(base64)
  const bytes = new Uint8Array(text.length)
  for (let index = 0; index < text.length; index++)
    bytes[index] = text.charCodeAt(index)
  return bytes
}

/**
 * The tenant's durable artifact records. Bytes are always written before the
 * record that names them; every record is immutable, so writing one again is
 * a no-op and different content under a stored identity is refused.
 */
export function artifactStore(options: ArtifactStoreOptions = {}) {
  const request: Request =
    options.request ?? ((input, init) => window.fetch(input, init))
  const csrf = options.csrf ?? sessionCsrf

  async function answer<T>(response: Response): Promise<T> {
    const body = (await response.json().catch(() => null)) as
      (T & { code?: string; message?: string; error?: string }) | null
    if (!response.ok) {
      const code = body?.code ?? body?.error ?? `http_${response.status}`
      throw new ArtifactRefused(response.status, code, body?.message ?? code)
    }
    return body as T
  }

  const read = async <T>(path: string, query: Record<string, string>) =>
    answer<T>(
      await request(`${ARTIFACT_ROUTE}/${path}?${new URLSearchParams(query)}`, {
        method: 'GET',
      }),
    )

  /** A write with CSRF and one Idempotency-Key, sent again once with a fresh token after a 403. */
  async function write<T>(path: string, body: unknown): Promise<T> {
    const key = crypto.randomUUID()
    const send = async (fresh: boolean) =>
      request(`${ARTIFACT_ROUTE}/${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'X-CSRF-Token': await csrf(fresh),
          'Idempotency-Key': key,
        },
        body: JSON.stringify(body),
      })
    const first = await send(false)
    return answer<T>(first.status === 403 ? await send(true) : first)
  }

  /** A read-scope query sent as a POST body: a subject does not fit a URL. */
  const query = async <T>(path: string, body: unknown) =>
    answer<T>(
      await request(`${ARTIFACT_ROUTE}/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    )

  const store = {
    async putBlob(
      bytes: Uint8Array,
    ): Promise<{ digest: Digest; bytes: IntegerText }> {
      if (bytes.length === 0 || bytes.length > MAX_BLOB_BYTES)
        throw new ArtifactRefused(
          400,
          'artifact_blob_invalid',
          `A blob holds 1 to ${MAX_BLOB_BYTES} bytes.`,
        )
      return write('blobs', { base64: base64Of(bytes) })
    },
    async blob(digest: Digest): Promise<Uint8Array> {
      const found = await read<{ base64: string }>('blobs', { digest })
      const bytes = bytesOf(found.base64)
      if ((await digestBytes(bytes)) !== digest)
        throw new ArtifactRefused(
          502,
          'artifact_blob_mismatch',
          'The bytes read do not match their digest.',
        )
      return bytes
    },
    putRun: (run: RunRef): Promise<RunRef> => write('runs', run),
    /** The whole run: the backend answers it in bounded pages, read here in order. */
    async openRun(runId: string): Promise<RunRecords> {
      type Page = RunRecords & { next_sequence?: string }
      const first = await read<Page>('runs', { run_id: runId })
      const chunks = [...first.chunks]
      let next = first.next_sequence
      while (next !== undefined) {
        const page: Page = await read<Page>('runs', {
          run_id: runId,
          from_sequence: next,
        })
        chunks.push(...page.chunks)
        next = page.next_sequence
      }
      return { run: first.run, chunks, checkpoints: first.checkpoints }
    },
    /** Appends a chunk whose bytes are stored; `appended` is `already-present` for a retry. */
    appendChunk: (
      chunk: TraceChunk,
    ): Promise<{ appended: 'appended' | 'already-present' }> =>
      write('chunks', chunk),
    /** Records a result after storing the bytes it names. */
    async putResult(result: ResultRef, bytes: Uint8Array): Promise<ResultRef> {
      const stored = await store.putBlob(bytes)
      if (
        stored.digest !== result.content ||
        (result.bytes !== undefined && stored.bytes !== result.bytes)
      )
        throw new ArtifactRefused(
          400,
          'artifact_result_invalid',
          'The result does not name these bytes.',
        )
      return write('results', result)
    },
    result: (id: Digest): Promise<ResultRef> =>
      read('results', { result_id: id }),
    resolve: (subject: SubjectRef): Promise<DurableResolution> =>
      query('resolve', { subject }),
    resolveObservation: (
      observation: ObservationRef,
    ): Promise<DurableResolution> => query('resolve', { observation }),
  }
  return store
}

export type ArtifactStore = ReturnType<typeof artifactStore>

/**
 * An observation as it is written: its reference, and the state it is the
 * digest of, as that state's canonical JSON text (`theorem.canonical-json/1`).
 * With the state, the moment can be read back after the App that made it is
 * gone; the reference alone only recognizes it.
 */
export type RecordedObservation = ChunkObservation & { state?: string }

/**
 * A chunk's bytes: the canonical JSON of its observations, each with its
 * state embedded as the exact text whose SHA-256 is `stateDigest`. Keys are in
 * canonical order (`index`, `state`, `stateDigest`, `time`).
 */
export function chunkBytes(
  observations: Array<RecordedObservation>,
): Uint8Array {
  const entries = observations.map(
    ({ index, time, stateDigest, state }) =>
      `{"index":${canonicalJson(index)}${state === undefined ? '' : `,"state":${state}`},"stateDigest":${canonicalJson(stateDigest)},"time":${canonicalJson(time)}}`,
  )
  return new TextEncoder().encode(`[${entries.join(',')}]`)
}

/** A stored run read back: its record, every moment it holds in order, and its checkpoints. */
export interface ReopenedRun {
  run: RunRef
  /** Contiguous from index 0, each checked against its chunk and, when kept, its state's digest. */
  observations: Array<RecordedObservation & { domain: string }>
  checkpoints: Array<CheckpointRef>
}

/**
 * The observations one chunk's bytes hold, read positionally against the
 * references the chunk itself records (`chunkBytes` wrote them in this exact
 * form). Each state is returned as its exact canonical JSON text, so its
 * digest can be checked without re-encoding values JSON has no form for.
 * Anything that does not read back exactly is refused rather than repaired.
 */
async function observationsOf(
  chunk: TraceChunk,
  bytes: Uint8Array,
): Promise<Array<RecordedObservation>> {
  const text = new TextDecoder().decode(bytes)
  const refused = (why: string) =>
    new ArtifactRefused(
      502,
      'artifact_chunk_mismatch',
      `Chunk ${chunk.sequence} of run ${chunk.runId} ${why}.`,
    )
  if (!text.startsWith('[')) throw refused('is not a list of observations')
  let at = 1
  const read: Array<RecordedObservation> = []
  for (const [position, ref] of chunk.observations.entries()) {
    if (position > 0) {
      if (text[at] !== ',') throw refused('has observations out of place')
      at += 1
    }
    const head = `{"index":${canonicalJson(ref.index)}`
    if (!text.startsWith(head, at))
      throw refused(`does not hold observation ${ref.index} where it says`)
    at += head.length
    const tail = `,"stateDigest":${canonicalJson(ref.stateDigest)},"time":${canonicalJson(ref.time)}}`
    let state: string | undefined
    if (text.startsWith(',"state":', at)) {
      const start = at + ',"state":'.length
      const end = text.indexOf(tail, start)
      if (end < 0)
        throw refused(`does not hold observation ${ref.index} as it records it`)
      state = text.slice(start, end)
      if (
        (await digestBytes(new TextEncoder().encode(state))) !== ref.stateDigest
      )
        throw refused(
          `holds a state for observation ${ref.index} that is not the state its digest names`,
        )
      at = end
    }
    if (!text.startsWith(tail, at))
      throw refused(`does not hold observation ${ref.index} as it records it`)
    at += tail.length
    read.push({ ...ref, ...(state !== undefined && { state }) })
  }
  if (at !== text.length - 1 || !text.endsWith(']'))
    throw refused('holds more than the observations it records')
  return read
}

/**
 * Reads a stored run back as the moments it holds, for another thread, a
 * later session, or another App: the run record, then each chunk's bytes
 * (checked against their digest by `blob`) read against the chunk's own
 * references. The moments must continue from index 0 with no gap; a run that
 * does not is refused, never read as far as it happens to go.
 */
export async function reopenRun(
  store: ArtifactStore,
  runId: string,
): Promise<ReopenedRun> {
  const records = await store.openRun(runId)
  if (records.run.id !== runId)
    throw new ArtifactRefused(
      502,
      'artifact_run_mismatch',
      `The run read is ${records.run.id}, not ${runId}.`,
    )
  const observations: ReopenedRun['observations'] = []
  let next = 0n
  for (const [position, chunk] of records.chunks.entries()) {
    if (chunk.runId !== runId || BigInt(chunk.sequence) !== BigInt(position))
      throw new ArtifactRefused(
        502,
        'artifact_chunk_mismatch',
        `Chunk ${position} of run ${runId} is not in its place.`,
      )
    const bytes = await store.blob(chunk.blob)
    for (const observation of await observationsOf(chunk, bytes)) {
      if (BigInt(observation.index) !== next)
        throw new ArtifactRefused(
          502,
          'artifact_chunk_mismatch',
          `Run ${runId} continues at observation ${next}, not ${observation.index}.`,
        )
      observations.push({ ...observation, domain: chunk.domain })
      next += 1n
    }
  }
  return { run: records.run, observations, checkpoints: records.checkpoints }
}

const referenceOf = ({
  index,
  time,
  stateDigest,
}: RecordedObservation): ChunkObservation => ({
  index,
  time,
  stateDigest,
})

/**
 * Writes one run's observations in order: the run first, then chunks from
 * index 0 with no gaps, each chunk's bytes before the chunk. Writes are queued,
 * so callers may append without waiting.
 *
 * Repeating an observation the run already holds, with the same index, time and
 * state digest, is a no-op, so a caller may write the same observations again
 * after an uncertain response. A repeat that disagrees with what is held is
 * refused as `artifact_chunk_conflict` and does not stop the writer.
 *
 * A write that failed for a reason asking again could change — the transport
 * dropped the answer, the backend was overloaded — does not stop the writer
 * either, because the store may have taken the bytes while the answer was lost.
 * The writer's optimistic claim is rolled back to what is known stored (its
 * `through`), the batch's caller promise rejects, and the next append re-sends
 * from there: a chunk the store already took is a no-op against its immutable
 * record, so an ambiguous acknowledgement reconciles by replay rather than by
 * guesswork. A batch queued behind one that rolled back is refused the same
 * way, rather than writing from a claim no longer held. Only what a repeat
 * cannot improve stops the writer: a genuine gap (an index past the next one),
 * or a refusal that means it — malformed input, a bad digest, a permanent
 * store refusal. What is stored stays exact either way, and `through` says how
 * far it reaches.
 */
export class RunWriter {
  private next = 0n
  private sequence = 0n
  /** The writes in flight, always usable: a retryable failure is recovered in it. */
  private queue: Promise<void>
  private failure: Error | undefined
  /** Whether the store has answered for the run record itself. */
  private runAssured = false
  /**
   * What each observation the run holds was, at its index. Indexes are
   * contiguous from 0, so a repeat is recognized by position and answered with
   * the reference it repeats. An entry exists for every index below `next` and,
   * while a batch is being scanned, for every observation that batch accepts.
   */
  private readonly accepted: Array<ChunkObservation> = []

  constructor(
    private readonly store: ArtifactStore,
    readonly run: RunRef,
  ) {
    this.queue = this.store.putRun(this.run).then(
      () => {
        this.runAssured = true
      },
      (error: unknown) => {
        // Losing the run record's answer stores nothing, so there is nothing to
        // roll back; the next write asks for the run again, which the store
        // treats as a no-op if it did take it.
        if (!retryable(error)) this.stop(error)
      },
    )
  }

  /** The last index stored, or undefined before the first chunk. */
  through: bigint | undefined

  /** Why the writer stopped, if it has. */
  get stopped(): Error | undefined {
    return this.failure
  }

  private stop(error: unknown) {
    this.failure ??= error instanceof Error ? error : new Error(String(error))
  }

  /**
   * Drops every claim past what the store is known to hold, so the next append
   * re-sends from stored progress instead of from what a lost answer left us
   * believing. `through` and `sequence` are only ever advanced by a write the
   * store answered, so they are the progress this can trust.
   */
  private rollback() {
    const stored = this.storedNext
    this.next = stored
    this.accepted.length = Number(stored)
  }

  /** How far the store is known to hold, as the next index it wants. */
  private get storedNext(): bigint {
    return this.through === undefined ? 0n : this.through + 1n
  }

  /**
   * Queues the new observations in `observations`, skipping the ones the run
   * already holds. A batch of nothing but repeats writes nothing and settles
   * with the writes already queued; a batch that disagrees with what is held is
   * refused whole, leaving the run as it was. A batch whose write failed for a
   * reason asking again could change rejects its caller and rolls the writer
   * back to what is stored, so the caller may re-send the same observations;
   * one the store refused outright, and any genuine gap, stops the writer.
   */
  append(
    domain: string,
    observations: Array<RecordedObservation>,
  ): Promise<void> {
    if (this.failure) return Promise.reject(this.failure)
    if (observations.length === 0) return this.queue
    const before = this.accepted.length
    const fresh: Array<RecordedObservation> = []
    let expected = this.next
    for (const observation of observations) {
      const index = BigInt(observation.index)
      if (index === expected) {
        // Recorded as it is accepted, so a repeat later in this same batch is
        // recognized as the moment it repeats.
        this.accepted[Number(index)] = referenceOf(observation)
        fresh.push(observation)
        expected += 1n
        continue
      }
      if (index < expected) {
        const stored = this.accepted[Number(index)]!
        if (
          stored.time === observation.time &&
          stored.stateDigest === observation.stateDigest
        )
          continue
        this.accepted.length = before
        return Promise.reject(
          new ArtifactRefused(
            400,
            'artifact_chunk_conflict',
            `Observation ${observation.index} is already written as time ${stored.time} with state ${stored.stateDigest}, not time ${observation.time} with state ${observation.stateDigest}.`,
          ),
        )
      }
      this.stop(
        new ArtifactRefused(
          400,
          'artifact_chunk_out_of_order',
          `The run continues at observation ${expected}, not ${observation.index}.`,
        ),
      )
      this.accepted.length = before
      return Promise.reject(this.failure!)
    }
    this.next = expected
    if (fresh.length === 0) return this.queue
    const claimedEnd = expected
    const chunks: Array<Array<RecordedObservation>> = []
    for (let start = 0; start < fresh.length; start += MAX_CHUNK_OBSERVATIONS)
      chunks.push(fresh.slice(start, start + MAX_CHUNK_OBSERVATIONS))
    const batch = this.queue.then(async () => {
      if (this.failure) throw this.failure
      try {
        // Another batch's retryable failure can roll this one's claims back
        // while it waits its turn, so what this batch scanned may no longer be
        // what the writer holds: either the run does not reach far enough to
        // follow it, or the claim past it was dropped. Writing either would
        // offer the store an index it does not follow, and its refusal for that
        // is permanent. Refuse it here instead, as the lost answer it sits
        // behind, so the caller re-sends from what is held.
        if (
          this.next < claimedEnd ||
          BigInt(fresh[0]!.index) !== this.storedNext
        )
          throw new Error(
            `The run is held ${
              this.through === undefined
                ? 'nowhere yet'
                : `through observation ${this.through}`
            }, so these observations were queued behind a lost answer; re-send from observation ${this.storedNext}.`,
          )
        // A state is written only as what its digest names.
        for (const { index, state, stateDigest } of fresh)
          if (
            state !== undefined &&
            (await digestBytes(new TextEncoder().encode(state))) !== stateDigest
          )
            throw new ArtifactRefused(
              400,
              'artifact_state_mismatch',
              `The state given for observation ${index} is not the state its digest names.`,
            )
        // The run record's own answer may have been lost before any chunk.
        if (!this.runAssured) {
          await this.store.putRun(this.run)
          this.runAssured = true
        }
        for (const part of chunks) await this.writeChunk(domain, part)
      } catch (error) {
        if (retryable(error)) this.rollback()
        else this.stop(error)
        throw error
      }
    })
    // The queue carries on recovered; only the caller of this batch sees the
    // failure. A rejected chain left here would refuse everything queued behind
    // it instead of letting them reconcile against stored progress.
    this.queue = batch.catch(() => undefined)
    return batch
  }

  /** Waits for every queued write; rejects if the writer stopped. */
  async settled(): Promise<void> {
    await this.queue
    if (this.failure) throw this.failure
  }

  private async writeChunk(
    domain: string,
    observations: Array<RecordedObservation>,
  ) {
    const bytes = chunkBytes(observations)
    if (bytes.length > MAX_BLOB_BYTES) {
      if (observations.length === 1)
        throw new ArtifactRefused(
          400,
          'artifact_blob_invalid',
          `Observation ${observations[0]!.index}'s state is larger than one blob (${MAX_BLOB_BYTES} bytes).`,
        )
      // Halve until it fits; a single observation is far below the bound.
      const half = Math.ceil(observations.length / 2)
      await this.writeChunk(domain, observations.slice(0, half))
      await this.writeChunk(domain, observations.slice(half))
      return
    }
    const blob = await this.store.putBlob(bytes)
    await this.store.appendChunk({
      schema: ARTIFACT_RUNTIME_SCHEMA,
      runId: this.run.id,
      sequence: String(this.sequence),
      domain,
      observations: observations.map(referenceOf),
      blob: blob.digest,
      bytes: blob.bytes,
    })
    this.sequence += 1n
    this.through = BigInt(observations.at(-1)!.index)
  }
}
