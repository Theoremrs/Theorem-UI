// SOURCING: bun:test over artifact-store.ts, against a fake of the backend's
// artifact routes that keeps their rules: bytes before records, chunks in
// order from index 0, immutable records, CSRF on writes. Transport faults are
// injected over that fake with `faulty` below, which also models the store's
// chunk-append contract the bare fake lacks: a retry of a stored chunk is
// `already-present`, and different content under a stored identity is refused.
import { expect, test } from 'bun:test'
import {
  ARTIFACT_RUNTIME_SCHEMA,
  canonicalJson,
  digestBytes,
  resultRef,
} from '../blocks/artifact-runtime'
import type { RunRef } from '../blocks/artifact-runtime'
import {
  ArtifactRefused,
  RunWriter,
  base64Of,
  bytesOf,
  chunkBytes,
} from './artifact-store'
import type { ArtifactStore, ChunkObservation, TraceChunk } from './artifact-store'
import { backend } from '../../../test/blocks/artifact-backend'

const run: RunRef = {
  schema: ARTIFACT_RUNTIME_SCHEMA,
  id: 'spatial-heat:1',
  source: {
    kind: 'document',
    documentId: 'heat',
    position: '3',
    contentDigest: 'c3',
  },
  engine: {
    kind: 'theorem.spatial-settle',
    version: '1',
    adapter: { schema: 'theorem.spatial-trace', version: '1' },
    observation: { schema: 'theorem.spatial-frame', version: '1' },
    capabilities: ['step', 'inspect', 'replay'],
  },
  domains: ['settlement'],
  reproducibility: 'recorded',
}

const observations = (from: number, count: number): Array<ChunkObservation> =>
  Array.from({ length: count }, (_, offset) => ({
    index: String(from + offset),
    time: String(from + offset),
    stateDigest: `sha256:${(from + offset).toString(16).padStart(64, '0')}`,
  }))

type Fake = ReturnType<typeof backend>

/**
 * The fake store plus two things the real backend keeps and the bare fake
 * does not model: chunk appends are idempotent by sequence (a retry of a
 * stored chunk answers `already-present`, per artifact-store.ts's own
 * appendChunk contract), and a different chunk under a stored identity is
 * refused as `apps_immutable_conflict`. With that, a lost acknowledgement
 * reconciles against stored progress exactly as it does in production.
 */
function replayable(fake: Fake): ArtifactStore {
  return {
    ...fake.store,
    appendChunk: async (chunk: TraceChunk) => {
      const held = fake.chunks.find(
        (stored) =>
          stored.runId === chunk.runId &&
          stored.sequence === chunk.sequence,
      )
      if (held === undefined) return fake.store.appendChunk(chunk)
      if (
        held.blob !== chunk.blob ||
        JSON.stringify(held.observations) !== JSON.stringify(chunk.observations)
      )
        throw new ArtifactRefused(
          409,
          'apps_immutable_conflict',
          `Sequence ${chunk.sequence} of ${chunk.runId} is stored as a different chunk.`,
        )
      return { appended: 'already-present' as const }
    },
  }
}

/** A store over the fake whose chunk writes fail however `fault` says. */
function faulty(
  fake: Fake,
  fault: (
    chunk: TraceChunk,
    send: ArtifactStore['appendChunk'],
  ) => ReturnType<ArtifactStore['appendChunk']>,
): ArtifactStore {
  const replay = replayable(fake)
  return { ...replay, appendChunk: (chunk) => fault(chunk, replay.appendChunk) }
}

test('a run is written first, then each chunk after its bytes, in order from index 0', async () => {
  const fake = backend()
  const writer = new RunWriter(fake.store, run)
  void writer.append('settlement', observations(0, 3))
  void writer.append('settlement', observations(3, 2))
  await writer.settled()
  expect(fake.log).toEqual([
    'POST runs',
    'POST blobs',
    'POST chunks',
    'POST blobs',
    'POST chunks',
  ])
  expect(fake.chunks.map((chunk) => chunk.sequence)).toEqual(['0', '1'])
  expect(writer.through).toBe(4n)
  // The chunk's bytes are its observations' canonical JSON, under their digest.
  const first = fake.chunks[0]!
  expect(fake.blobs.get(first.blob)).toEqual(chunkBytes(first.observations))
  expect(await digestBytes(chunkBytes(first.observations))).toBe(first.blob)
})

test('a run read back from bounded pages is the whole run, in order', async () => {
  const fake = backend({ pageChunks: 2 })
  const writer = new RunWriter(fake.store, run)
  for (let start = 0; start < 5; start++)
    void writer.append('settlement', observations(start * 2, 2))
  await writer.settled()
  const opened = await fake.store.openRun(run.id)
  expect(opened.run).toEqual(run)
  expect(opened.chunks.map((chunk) => chunk.sequence)).toEqual([
    '0',
    '1',
    '2',
    '3',
    '4',
  ])
  expect(fake.log.filter((entry) => entry === 'GET runs')).toHaveLength(3)
})

test('a run larger than one chunk is split, never truncated', async () => {
  const fake = backend()
  const writer = new RunWriter(fake.store, run)
  await writer.append('settlement', observations(0, 4096 + 10))
  expect(fake.chunks.map((chunk) => chunk.observations.length)).toEqual([
    4096, 10,
  ])
  expect(writer.through).toBe(4105n)
})

test('observations that skip ahead stop the writer instead of leaving a gap', async () => {
  const fake = backend()
  const writer = new RunWriter(fake.store, run)
  await writer.append('settlement', observations(0, 2))
  const skipped = writer.append('settlement', observations(5, 1))
  await expect(skipped).rejects.toMatchObject({
    code: 'artifact_chunk_out_of_order',
  })
  await expect(
    writer.append('settlement', observations(2, 1)),
  ).rejects.toBeInstanceOf(ArtifactRefused)
  expect(fake.chunks).toHaveLength(1)
  expect(writer.through).toBe(1n)
})

test('an identical repeat of an observation already written writes nothing and the run continues', async () => {
  const fake = backend()
  const writer = new RunWriter(fake.store, run)
  await writer.append('settlement', observations(0, 2))
  // The bridge promises that writing the same observations again is safe: an
  // uncertain response is retried, not lost.
  await writer.append('settlement', observations(0, 2))
  await writer.append('settlement', observations(2, 1))
  expect(fake.log).toEqual([
    'POST runs',
    'POST blobs',
    'POST chunks',
    'POST blobs',
    'POST chunks',
  ])
  expect(fake.chunks.map((chunk) => chunk.observations)).toEqual([
    observations(0, 2),
    observations(2, 1),
  ])
  expect(writer.through).toBe(2n)
  expect(writer.stopped).toBeUndefined()
})

test('a batch that overlaps what is stored writes only the new observations', async () => {
  const fake = backend()
  const writer = new RunWriter(fake.store, run)
  await writer.append('settlement', observations(0, 2))
  await writer.append('settlement', observations(1, 3))
  expect(fake.chunks.map((chunk) => chunk.observations)).toEqual([
    observations(0, 2),
    observations(2, 2),
  ])
  expect(writer.through).toBe(3n)
  expect(writer.stopped).toBeUndefined()
})

test('a repeat that disagrees with what is stored is refused without stopping the run', async () => {
  const fake = backend()
  const writer = new RunWriter(fake.store, run)
  await writer.append('settlement', observations(0, 2))
  // Same index, another time.
  const resampled = observations(1, 1).map((observation) => ({
    ...observation,
    time: '9',
  }))
  await expect(writer.append('settlement', resampled)).rejects.toMatchObject({
    status: 400,
    code: 'artifact_chunk_conflict',
    message: expect.stringContaining('Observation 1'),
  })
  // Same index and time, another state.
  await expect(
    writer.append('settlement', [
      { index: '0', time: '0', stateDigest: `sha256:${'f'.repeat(64)}` },
    ]),
  ).rejects.toMatchObject({ code: 'artifact_chunk_conflict' })
  expect(writer.stopped).toBeUndefined()
  await writer.append('settlement', observations(2, 1))
  expect(fake.chunks.map((chunk) => chunk.observations)).toEqual([
    observations(0, 2),
    observations(2, 1),
  ])
  expect(writer.through).toBe(2n)
})

test('an acknowledgment lost after the store accepted a chunk replays against stored progress, and the run lives', async () => {
  const fake = backend()
  let loseAck = true
  const store = faulty(fake, async (chunk, send) => {
    const stored = await send(chunk) // the store accepts it...
    if (loseAck) {
      loseAck = false
      throw new TypeError('the response never arrived') // ...the answer is lost
    }
    return stored
  })
  const writer = new RunWriter(store, run)
  await expect(writer.append('settlement', observations(0, 2))).rejects.toBeInstanceOf(TypeError)
  // The writer is not poisoned by a lost answer.
  expect(writer.stopped).toBeUndefined()
  expect(writer.through).toBeUndefined()
  // Retrying the same observations is a no-op at the store, not a second copy.
  await writer.append('settlement', observations(0, 2))
  await writer.append('settlement', observations(2, 1))
  expect(fake.chunks.map((chunk) => chunk.sequence)).toEqual(['0', '1'])
  expect(fake.chunks.map((chunk) => chunk.observations)).toEqual([
    observations(0, 2),
    observations(2, 1),
  ])
  expect(writer.through).toBe(2n)
  expect(writer.stopped).toBeUndefined()
  // A changed duplicate is still refused explicitly, without touching history.
  await expect(
    writer.append('settlement', [
      { index: '0', time: '0', stateDigest: `sha256:${'f'.repeat(64)}` },
    ]),
  ).rejects.toMatchObject({ code: 'artifact_chunk_conflict' })
  expect(fake.chunks.map((chunk) => chunk.observations)).toEqual([
    observations(0, 2),
    observations(2, 1),
  ])
  expect(writer.stopped).toBeUndefined()
})

test('a 503 loses only its batch: stored progress stands and the next append continues the run', async () => {
  const fake = backend()
  let down = true
  const store = faulty(fake, (chunk, send) =>
    down
      ? Promise.reject(new ArtifactRefused(503, 'http_503', 'the gateway is down'))
      : send(chunk),
  )
  const writer = new RunWriter(store, run)
  await writer.append('settlement', observations(0, 2))
  await expect(writer.append('settlement', observations(2, 2))).rejects.toMatchObject({
    status: 503,
  })
  expect(writer.stopped).toBeUndefined()
  expect(writer.through).toBe(1n) // what was stored is what is claimed
  down = false
  await writer.append('settlement', observations(2, 2))
  expect(fake.chunks.map((chunk) => chunk.observations)).toEqual([
    observations(0, 2),
    observations(2, 2),
  ])
  expect(fake.chunks.map((chunk) => chunk.sequence)).toEqual(['0', '1'])
  expect(writer.through).toBe(3n)
  expect(writer.stopped).toBeUndefined()
})

test('a batch queued behind a rolled-back write rejects instead of storing out of order or dying silently', async () => {
  const fake = backend()
  let down = true
  const store = faulty(fake, (chunk, send) =>
    down
      ? Promise.reject(new ArtifactRefused(503, 'http_503', 'the gateway is down'))
      : send(chunk),
  )
  const writer = new RunWriter(store, run)
  // Two batches queued without waiting: the first loses its answer before
  // anything is stored, which rolls the optimistic claim back under the second.
  const first = writer.append('settlement', observations(0, 2))
  const second = writer.append('settlement', observations(2, 2))
  await expect(first).rejects.toMatchObject({ status: 503 })
  down = false
  await expect(second).rejects.toThrow(/queued behind/)
  expect(fake.chunks).toHaveLength(0)
  expect(writer.stopped).toBeUndefined()
  expect(writer.through).toBeUndefined()
  // The App re-sends from stored progress, as one whole batch.
  await writer.append('settlement', observations(0, 4))
  expect(fake.chunks.map((chunk) => chunk.observations)).toEqual([
    observations(0, 4),
  ])
  expect(writer.through).toBe(3n)
  expect(writer.stopped).toBeUndefined()
})

test('a permanent refusal still stops the writer, keeping what is stored', async () => {
  const fake = backend()
  let poison = false
  const store = faulty(fake, (chunk, send) =>
    poison
      ? Promise.reject(
          new ArtifactRefused(400, 'artifact_chunk_invalid', 'the store refuses this chunk'),
        )
      : send(chunk),
  )
  const writer = new RunWriter(store, run)
  await writer.append('settlement', observations(0, 2))
  poison = true
  await expect(writer.append('settlement', observations(2, 1))).rejects.toMatchObject({
    status: 400,
    code: 'artifact_chunk_invalid',
  })
  expect(writer.stopped).toMatchObject({ code: 'artifact_chunk_invalid' })
  poison = false
  // A stopped writer stays stopped: its observations were refused, not lost.
  await expect(writer.append('settlement', observations(2, 1))).rejects.toBe(
    writer.stopped,
  )
  expect(fake.chunks.map((chunk) => chunk.observations)).toEqual([
    observations(0, 2),
  ])
  expect(writer.through).toBe(1n)
})

test('a run record that only lost its answer is re-ensured before the next chunk', async () => {
  const fake = backend()
  let attempts = 0
  const store: ArtifactStore = {
    ...fake.store,
    putRun: (given) =>
      ++attempts === 1
        ? Promise.reject(new TypeError('the response never arrived'))
        : fake.store.putRun(given),
  }
  const writer = new RunWriter(store, run)
  await writer.append('settlement', observations(0, 1))
  expect(writer.stopped).toBeUndefined()
  expect(writer.through).toBe(0n)
  expect(fake.log.filter((entry) => entry === 'POST runs')).toHaveLength(2)
  expect(fake.chunks.map((chunk) => chunk.observations)).toEqual([
    observations(0, 1),
  ])
})

test('a stale CSRF token is replaced once and the write keeps its idempotency key', async () => {
  const fake = backend({ staleToken: true })
  const stored = await fake.store.putBlob(new TextEncoder().encode('hello'))
  expect(stored.bytes).toBe('5')
  expect(await fake.store.blob(stored.digest)).toEqual(
    new TextEncoder().encode('hello'),
  )
})

test('a result is recorded only after its bytes, and must name them', async () => {
  const fake = backend()
  const bytes = new TextEncoder().encode('slot,guest\n18:00,Ada\n')
  const result = await resultRef({
    content: await digestBytes(bytes),
    bytes: String(bytes.length),
    mediaType: 'text/csv',
    provenance: {
      kind: 'captured',
      capturedAt: '2026-11-18T20:00:00Z',
      unknowns: ['producer-build'],
    },
  })
  expect(await fake.store.putResult(result, bytes)).toEqual(result)
  expect(fake.log).toEqual(['POST blobs', 'POST results'])
  const other = new TextEncoder().encode('something else')
  await expect(fake.store.putResult(result, other)).rejects.toMatchObject({
    code: 'artifact_result_invalid',
  })
})

test('a result that does not state its size is still recorded', async () => {
  const fake = backend()
  const bytes = new TextEncoder().encode('no size given')
  const result = await resultRef({
    content: await digestBytes(bytes),
    mediaType: 'text/plain',
    provenance: {
      kind: 'captured',
      capturedAt: '2026-11-18T20:00:00Z',
      unknowns: ['producer-build'],
    },
  })
  expect(await fake.store.putResult(result, bytes)).toEqual(result)
  await expect(
    fake.store.putResult(result, new TextEncoder().encode('other')),
  ).rejects.toMatchObject({ code: 'artifact_result_invalid' })
})

test('bytes round-trip through base64 at the size bound', () => {
  const bytes = new Uint8Array(1024 * 1024).map((_, index) => index % 251)
  expect(bytesOf(base64Of(bytes))).toEqual(bytes)
})

test('a moment is written with its state, and a state its digest does not name is refused', async () => {
  const fake = backend()
  const writer = new RunWriter(fake.store, run)
  const state = canonicalJson({
    values: { pc: { out: 3 } },
    states: {},
    pins: {},
  })
  const stateDigest = await digestBytes(new TextEncoder().encode(state))
  await writer.append('settlement', [
    { index: '0', time: '0', stateDigest, state },
  ])
  const chunk = fake.chunks[0]!
  // The record holds the reference; the bytes hold the state as written.
  expect(chunk.observations).toEqual([{ index: '0', time: '0', stateDigest }])
  const read = JSON.parse(
    new TextDecoder().decode(fake.blobs.get(chunk.blob)),
  ) as Array<{ state: unknown }>
  expect(read[0]!.state).toEqual({
    values: { pc: { out: 3 } },
    states: {},
    pins: {},
  })
  await expect(
    writer.append('settlement', [
      {
        index: '1',
        time: '1',
        stateDigest,
        state: canonicalJson({ other: 1 }),
      },
    ]),
  ).rejects.toMatchObject({ code: 'artifact_state_mismatch' })
  expect(fake.chunks).toHaveLength(1)
})

test('two runs are written side by side, each from its own index 0', async () => {
  const fake = backend()
  const first = new RunWriter(fake.store, run)
  const second = new RunWriter(fake.store, { ...run, id: 'spatial-heat:2' })
  await first.append('settlement', observations(0, 2))
  await second.append('settlement', observations(0, 3))
  await first.append('settlement', observations(2, 1))
  expect(
    fake.chunks.map((chunk) => `${chunk.runId} ${chunk.sequence}`),
  ).toEqual(['spatial-heat:1 0', 'spatial-heat:2 0', 'spatial-heat:1 1'])
})
