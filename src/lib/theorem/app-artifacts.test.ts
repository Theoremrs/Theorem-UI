// SOURCING: bun:test over app-artifacts.ts through the capability bridge, with
// an App document from test/blocks/ and a fake of the artifact routes.
import { expect, test } from 'bun:test'
import { appDocumentFixture } from '../../../test/blocks/app-documents'
import { backend } from '../../../test/blocks/artifact-backend'
import {
  ARTIFACT_RUNTIME_SCHEMA,
  canonicalJson,
  digestBytes,
  resultRef,
} from '../blocks/artifact-runtime'
import { serveBridge } from '../blocks/bridge'
import type { BridgeHost } from '../blocks/bridge'
import { noCapabilities } from '../blocks/declarations'
import { call, rpcOver } from '../blocks/sandbox/protocol'
import type { PageMethods } from '../blocks/sandbox/protocol'
import { appArtifacts } from './app-artifacts'
import { appSourceRef } from './app-dossier'
import { AppDocument } from './apps'
import type { AppSnapshot } from './apps'

const run = {
  schema: ARTIFACT_RUNTIME_SCHEMA,
  id: 'spatial-a:0',
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
const at = (index: number) => ({
  index: String(index),
  time: String(index),
  stateDigest: `sha256:${index.toString(16).padStart(64, '0')}`,
})

async function connected() {
  const fixture = await appDocumentFixture()
  const snapshot = await new AppDocument(
    'app-document',
    fixture.api,
    fixture.change,
  ).load()
  const fake = backend()
  const host = {
    state: {} as BridgeHost['state'],
    client: {} as BridgeHost['client'],
    capabilities: noCapabilities(),
    run: () => Promise.reject(new Error('unused')),
    artifacts: appArtifacts(snapshot, fake.store),
  } satisfies BridgeHost
  const channel = new MessageChannel()
  const stop = serveBridge(rpcOver(channel.port1), host)
  return {
    snapshot,
    fake,
    frame: rpcOver(channel.port2),
    close: () => {
      stop()
      channel.port1.close()
      channel.port2.close()
    },
  }
}

test("an App's run is kept as run by the revision running, and continues where it ended", async () => {
  const { snapshot, fake, frame, close } = await connected()
  try {
    const first = await call<PageMethods, 'artifacts.record'>(
      frame,
      'artifacts.record',
      { run, domain: 'settlement', observations: [at(0), at(1)] },
    )
    expect(first.through).toBe('1')
    // The revision the stored run names, for a question about it to name too.
    expect(first.source).toEqual(appSourceRef(snapshot))
    const next = await call<PageMethods, 'artifacts.record'>(
      frame,
      'artifacts.record',
      { run, domain: 'settlement', observations: [at(2)] },
    )
    expect(next.through).toBe('2')
    expect(JSON.parse(fake.runs.get('spatial-a:0')!).source).toEqual(
      appSourceRef(snapshot),
    )
    // A gap is refused, not stored.
    const gap = await call<PageMethods, 'artifacts.record'>(
      frame,
      'artifacts.record',
      { run, domain: 'settlement', observations: [at(9)] },
    ).then(
      () => '',
      (error: Error) => error.message,
    )
    expect(gap).toContain('artifact_chunk_out_of_order')
    // The moment is then held exactly, and another state at it is not.
    const moment = (index: number, digest = at(index).stateDigest) => ({
      kind: 'moment',
      observation: {
        schema: ARTIFACT_RUNTIME_SCHEMA,
        runId: run.id,
        index: String(index),
        domain: 'settlement',
        time: String(index),
        stateDigest: digest,
      },
    })
    expect(
      await call<PageMethods, 'artifacts.resolve'>(frame, 'artifacts.resolve', {
        subject: moment(2),
      }),
    ).toEqual({ status: 'available' })
    expect(
      await call<PageMethods, 'artifacts.resolve'>(frame, 'artifacts.resolve', {
        subject: moment(2, at(1).stateDigest),
      }),
    ).toEqual({ status: 'unavailable', reason: 'moment-not-held' })
    // A malformed observation never reaches the store.
    const malformed = await call<PageMethods, 'artifacts.record'>(
      frame,
      'artifacts.record',
      {
        run,
        domain: 'settlement',
        observations: [{ ...at(3), stateDigest: 'nope' }],
      },
    ).then(
      () => false,
      () => true,
    )
    expect(malformed).toBe(true)
  } finally {
    close()
  }
})

test("an App's result is kept with its bytes and resolves as itself", async () => {
  const { snapshot, frame, close } = await connected()
  try {
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
    expect(
      await call<PageMethods, 'artifacts.result'>(frame, 'artifacts.result', {
        result,
        bytes,
      }),
    ).toEqual({ id: result.id })
    expect(
      await call<PageMethods, 'artifacts.resolve'>(frame, 'artifacts.resolve', {
        subject: { kind: 'result', result },
      }),
    ).toEqual({ status: 'available' })
    const other = await call<PageMethods, 'artifacts.result'>(
      frame,
      'artifacts.result',
      { result, bytes: new TextEncoder().encode('else') },
    ).then(
      () => '',
      (error: Error) => error.message,
    )
    expect(other).toContain('artifact_result_invalid')
    // Read back, from any App, with its bytes checked.
    const opened = await call<PageMethods, 'artifacts.open'>(
      frame,
      'artifacts.open',
      {
        id: result.id,
      },
    )
    expect(opened.result).toEqual(result)
    expect(new TextDecoder().decode(opened.bytes)).toBe(
      'slot,guest\n18:00,Ada\n',
    )
    const missing = await call<PageMethods, 'artifacts.open'>(
      frame,
      'artifacts.open',
      {
        id: `sha256:${'0'.repeat(64)}`,
      },
    ).then(
      () => '',
      (error: Error) => error.message,
    )
    expect(missing).toContain('artifact_result_not_found')
    // The revision running is the source a result computed now names.
    expect(
      await call<PageMethods, 'artifacts.source'>(
        frame,
        'artifacts.source',
        {},
      ),
    ).toEqual(appSourceRef(snapshot))
  } finally {
    close()
  }
})

/** A moment with its state, as a spatial model writes one. */
async function stateAt(index: number, value: unknown) {
  const state = canonicalJson({ value })
  return {
    index: String(index),
    time: String(index * 10),
    stateDigest: await digestBytes(new TextEncoder().encode(state)),
    state,
  }
}

/** A second App, in another conversation, over the same person's store. */
function elsewhere(
  fake: ReturnType<typeof backend>,
  snapshot: AppSnapshot,
): { frame: ReturnType<typeof rpcOver>; close: () => void } {
  const other: AppSnapshot = {
    ...snapshot,
    documentId: 'reader-document',
    revision: { ...snapshot.revision, position: 4, contentDigest: 'reader' },
  }
  const host = {
    state: {} as BridgeHost['state'],
    client: {} as BridgeHost['client'],
    capabilities: noCapabilities(),
    run: () => Promise.reject(new Error('unused')),
    artifacts: appArtifacts(other, fake.store),
  } satisfies BridgeHost
  const channel = new MessageChannel()
  const stop = serveBridge(rpcOver(channel.port1), host)
  return {
    frame: rpcOver(channel.port2),
    close: () => {
      stop()
      channel.port1.close()
      channel.port2.close()
    },
  }
}

test('a kept run reopens in another App with every moment and state its writer kept', async () => {
  const { snapshot, fake, frame, close } = await connected()
  const reader = elsewhere(fake, snapshot)
  try {
    const moments = [
      await stateAt(0, { carry: 0 }),
      await stateAt(1, { carry: 1, wide: 18446744073709551617n }),
      await stateAt(2, { carry: 1, note: ',"stateDigest":"' }),
    ]
    await call<PageMethods, 'artifacts.record'>(frame, 'artifacts.record', {
      run,
      domain: 'settlement',
      observations: moments.slice(0, 2),
    })
    await call<PageMethods, 'artifacts.record'>(frame, 'artifacts.record', {
      run,
      domain: 'settlement',
      observations: moments.slice(2),
    })
    close()
    // The writer is gone; the reader shares nothing with it but the store.
    const reopened = await call<PageMethods, 'artifacts.run'>(
      reader.frame,
      'artifacts.run',
      { id: run.id },
    )
    // The run still names the revision that ran it, not the reader's.
    expect(reopened.run).toEqual({ ...run, source: appSourceRef(snapshot) })
    expect(reopened.observations).toEqual(
      moments.map((each) => ({ ...each, domain: 'settlement' })),
    )
    expect(reopened.checkpoints).toEqual([])
    const missing = await call<PageMethods, 'artifacts.run'>(
      reader.frame,
      'artifacts.run',
      { id: 'never-run' },
    ).then(
      () => '',
      (error: Error) => error.message,
    )
    expect(missing).toContain('artifact_run_not_found')
  } finally {
    close()
    reader.close()
  }
})

test('a reopened run whose stored moments do not match what they record is refused, not repaired', async () => {
  const { snapshot, fake, frame, close } = await connected()
  const reader = elsewhere(fake, snapshot)
  const reopen = () =>
    call<PageMethods, 'artifacts.run'>(reader.frame, 'artifacts.run', {
      id: run.id,
    }).then(
      () => '',
      (error: Error) => error.message,
    )
  try {
    await call<PageMethods, 'artifacts.record'>(frame, 'artifacts.record', {
      run,
      domain: 'settlement',
      observations: [await stateAt(0, 1), await stateAt(1, 2)],
    })
    const chunk = fake.chunks[0]!
    const held = fake.blobs.get(chunk.blob)!
    const text = new TextDecoder().decode(held)
    // A state that is not the one its digest names, stored under the chunk's own blob digest.
    fake.blobs.set(
      chunk.blob,
      new TextEncoder().encode(text.replace('"value":2', '"value":3')),
    )
    expect(await reopen()).toContain('artifact_blob_mismatch')
    // The same tampering, with bytes that do match a digest the chunk is then made to name.
    const forged = new TextEncoder().encode(
      text.replace('"value":2', '"value":3'),
    )
    const forgedDigest = await digestBytes(forged)
    fake.blobs.set(forgedDigest, forged)
    fake.chunks[0] = { ...chunk, blob: forgedDigest }
    expect(await reopen()).toContain('is not the state its digest names')
    // A chunk that holds a moment it does not record.
    const extra = new TextEncoder().encode(
      `${text.slice(0, -1)},${text.slice(1, -1).split('},{')[0]}}]`,
    )
    const extraDigest = await digestBytes(extra)
    fake.blobs.set(extraDigest, extra)
    fake.chunks[0] = { ...chunk, blob: extraDigest }
    expect(await reopen()).toContain('artifact_chunk_mismatch')
  } finally {
    close()
    reader.close()
  }
})

test('a result kept in one App opens in another, naming the revision that made it', async () => {
  const { snapshot, fake, frame, close } = await connected()
  const reader = elsewhere(fake, snapshot)
  try {
    const bytes = new TextEncoder().encode('{"tMax":100}')
    const result = await resultRef({
      content: await digestBytes(bytes),
      bytes: String(bytes.length),
      mediaType: 'application/json',
      provenance: {
        kind: 'computed',
        source: appSourceRef(snapshot),
        operation: { name: 'solve', version: '1', schema: 'theorem.operation' },
        inputs: {},
      },
      reproducibility: 'deterministic',
    })
    await call<PageMethods, 'artifacts.result'>(frame, 'artifacts.result', {
      result,
      bytes,
    })
    close()
    const opened = await call<PageMethods, 'artifacts.open'>(
      reader.frame,
      'artifacts.open',
      { id: result.id },
    )
    expect(opened.result).toEqual(result)
    expect(
      (opened.result as { provenance: { source: unknown } }).provenance.source,
    ).toEqual(appSourceRef(snapshot))
    expect(new TextDecoder().decode(opened.bytes)).toBe('{"tMax":100}')
  } finally {
    close()
    reader.close()
  }
})
