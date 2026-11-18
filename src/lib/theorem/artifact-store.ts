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
    openRun: (runId: string): Promise<RunRecords> =>
      read('runs', { run_id: runId }),
    /** Appends a chunk whose bytes are stored; `appended` is `already-present` for a retry. */
    appendChunk: (
      chunk: TraceChunk,
    ): Promise<{ appended: 'appended' | 'already-present' }> =>
      write('chunks', chunk),
    /** Records a result after storing the bytes it names. */
    async putResult(result: ResultRef, bytes: Uint8Array): Promise<ResultRef> {
      const stored = await store.putBlob(bytes)
      if (stored.digest !== result.content || stored.bytes !== result.bytes)
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

/** A chunk's observations as its bytes: their canonical JSON. */
export const chunkBytes = (observations: Array<ChunkObservation>) =>
  new TextEncoder().encode(canonicalJson(observations))

/**
 * Writes one run's observations in order: the run first, then chunks from
 * index 0 with no gaps, each chunk's bytes before the chunk. Writes are queued,
 * so callers may append without waiting. An observation out of order, or a
 * failed write, stops the writer: what is stored stays exact, and `through`
 * says how far it reaches.
 */
export class RunWriter {
  private next = 0n
  private sequence = 0n
  private queue: Promise<void>
  private failure: Error | undefined

  constructor(
    private readonly store: ArtifactStore,
    readonly run: RunRef,
  ) {
    this.queue = store.putRun(run).then(() => undefined)
    this.queue.catch((error: unknown) => this.stop(error))
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

  /** Queues observations that continue the run exactly where it was left. */
  append(domain: string, observations: Array<ChunkObservation>): Promise<void> {
    if (this.failure) return Promise.reject(this.failure)
    if (observations.length === 0) return this.queue
    let expected = this.next
    for (const observation of observations) {
      if (BigInt(observation.index) !== expected) {
        this.stop(
          new ArtifactRefused(
            400,
            'artifact_chunk_out_of_order',
            `The run continues at observation ${expected}, not ${observation.index}.`,
          ),
        )
        return Promise.reject(this.failure!)
      }
      expected += 1n
    }
    this.next = expected
    const chunks: Array<Array<ChunkObservation>> = []
    for (
      let start = 0;
      start < observations.length;
      start += MAX_CHUNK_OBSERVATIONS
    )
      chunks.push(observations.slice(start, start + MAX_CHUNK_OBSERVATIONS))
    this.queue = this.queue.then(async () => {
      if (this.failure) throw this.failure
      for (const part of chunks) await this.writeChunk(domain, part)
    })
    this.queue.catch((error: unknown) => this.stop(error))
    return this.queue
  }

  /** Waits for every queued write; rejects if the writer stopped. */
  async settled(): Promise<void> {
    await this.queue
    if (this.failure) throw this.failure
  }

  private async writeChunk(
    domain: string,
    observations: Array<ChunkObservation>,
  ) {
    const bytes = chunkBytes(observations)
    if (bytes.length > MAX_BLOB_BYTES) {
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
      observations,
      blob: blob.digest,
      bytes: blob.bytes,
    })
    this.sequence += 1n
    this.through = BigInt(observations.at(-1)!.index)
  }
}
