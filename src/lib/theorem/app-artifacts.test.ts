// SOURCING: bun:test over app-artifacts.ts through the capability bridge, with
// an App document from test/blocks/ and a fake of the artifact routes.
import { expect, test } from 'bun:test'
import { appDocumentFixture } from '../../../test/blocks/app-documents'
import { backend } from '../../../test/blocks/artifact-backend'
import { ARTIFACT_RUNTIME_SCHEMA, digestBytes, resultRef } from '../blocks/artifact-runtime'
import { serveBridge } from '../blocks/bridge'
import type { BridgeHost } from '../blocks/bridge'
import { noCapabilities } from '../blocks/declarations'
import { call, rpcOver } from '../blocks/sandbox/protocol'
import type { PageMethods } from '../blocks/sandbox/protocol'
import { appArtifacts } from './app-artifacts'
import { appSourceRef } from './app-dossier'
import { AppDocument } from './apps'

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
  const snapshot = await new AppDocument('app-document', fixture.api, fixture.change).load()
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
    const first = await call<PageMethods, 'artifacts.record'>(frame, 'artifacts.record', { run, domain: 'settlement', observations: [at(0), at(1)] })
    expect(first.through).toBe('1')
    const next = await call<PageMethods, 'artifacts.record'>(frame, 'artifacts.record', { run, domain: 'settlement', observations: [at(2)] })
    expect(next.through).toBe('2')
    expect(JSON.parse(fake.runs.get('spatial-a:0')!).source).toEqual(appSourceRef(snapshot))
    // A gap is refused, not stored.
    const gap = await call<PageMethods, 'artifacts.record'>(frame, 'artifacts.record', { run, domain: 'settlement', observations: [at(9)] }).then(() => '', (error: Error) => error.message)
    expect(gap).toContain('artifact_chunk_out_of_order')
    // The moment is then held exactly, and another state at it is not.
    const moment = (index: number, digest = at(index).stateDigest) => ({
      kind: 'moment',
      observation: { schema: ARTIFACT_RUNTIME_SCHEMA, runId: run.id, index: String(index), domain: 'settlement', time: String(index), stateDigest: digest },
    })
    expect(await call<PageMethods, 'artifacts.resolve'>(frame, 'artifacts.resolve', { subject: moment(2) })).toEqual({ status: 'available' })
    expect(await call<PageMethods, 'artifacts.resolve'>(frame, 'artifacts.resolve', { subject: moment(2, at(1).stateDigest) })).toEqual({ status: 'unavailable', reason: 'moment-not-held' })
    // A malformed observation never reaches the store.
    const malformed = await call<PageMethods, 'artifacts.record'>(frame, 'artifacts.record', { run, domain: 'settlement', observations: [{ ...at(3), stateDigest: 'nope' }] }).then(() => false, () => true)
    expect(malformed).toBe(true)
  } finally {
    close()
  }
})

test("an App's result is kept with its bytes and resolves as itself", async () => {
  const { frame, close } = await connected()
  try {
    const bytes = new TextEncoder().encode('slot,guest\n18:00,Ada\n')
    const result = await resultRef({
      content: await digestBytes(bytes),
      bytes: String(bytes.length),
      mediaType: 'text/csv',
      provenance: { kind: 'captured', capturedAt: '2026-11-18T20:00:00Z', unknowns: ['producer-build'] },
    })
    expect(await call<PageMethods, 'artifacts.result'>(frame, 'artifacts.result', { result, bytes })).toEqual({ id: result.id })
    expect(await call<PageMethods, 'artifacts.resolve'>(frame, 'artifacts.resolve', { subject: { kind: 'result', result } })).toEqual({ status: 'available' })
    const other = await call<PageMethods, 'artifacts.result'>(frame, 'artifacts.result', { result, bytes: new TextEncoder().encode('else') }).then(() => '', (error: Error) => error.message)
    expect(other).toContain('artifact_result_invalid')
  } finally {
    close()
  }
})
