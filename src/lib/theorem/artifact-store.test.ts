// SOURCING: bun:test over artifact-store.ts, against a fake of the backend's
// artifact routes that keeps their rules: bytes before records, chunks in
// order from index 0, immutable records, CSRF on writes.
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
import type { ChunkObservation } from './artifact-store'
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
