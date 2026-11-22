// SOURCING: none: what an App's `window.theorem.artifacts` reaches, written
// over artifact-store.ts. The host names the revision running as the source of
// a run that names none, the same way a question's binding does
// (app-dossier.ts dossierBinding), so a stored moment and a question about it
// name the same run.
import {
  readResultRef,
  readSourceRef,
  readSubjectRef,
  resultIdHolds,
} from '../blocks/artifact-runtime'
import type { RunRef } from '../blocks/artifact-runtime'
import { BridgeDenied } from '../blocks/bridge'
import type { AppArtifacts } from '../blocks/bridge'
import { appSourceRef } from './app-dossier'
import type { AppSnapshot } from './apps'
import {
  ArtifactRefused,
  RunWriter,
  artifactStore,
  reopenRun,
} from './artifact-store'
import type { ArtifactStore, RecordedObservation } from './artifact-store'

/** The most runs one App keeps writing at once; the oldest is let go first. */
const MAX_WRITERS = 32

const refusal = (error: unknown) =>
  error instanceof ArtifactRefused
    ? new BridgeDenied(`${error.message} (${error.code})`)
    : error

/** The durable store as one running App revision reaches it. */
export function appArtifacts(
  snapshot: AppSnapshot,
  store: ArtifactStore = artifactStore(),
): AppArtifacts {
  const source = appSourceRef(snapshot)
  const writers = new Map<string, { text: string; writer: RunWriter }>()

  function writerFor(given: Record<string, unknown>) {
    if (typeof given.id !== 'string' || !given.id)
      throw new BridgeDenied('A run is recorded under its id.')
    const run = (readSourceRef(given.source)
      ? given
      : { ...given, source }) as unknown as RunRef
    const text = JSON.stringify(run)
    const open = writers.get(run.id)
    if (open) {
      if (open.text !== text)
        throw new BridgeDenied(
          `Run ${run.id} is already recorded as a different run.`,
        )
      return open.writer
    }
    const writer = new RunWriter(store, run)
    writers.set(run.id, { text, writer })
    for (const old of [...writers.keys()].slice(
      0,
      Math.max(0, writers.size - MAX_WRITERS),
    ))
      writers.delete(old)
    return writer
  }

  return {
    async record(run, domain, observations) {
      const writer = writerFor(run)
      try {
        // The bridge checked each digest's form.
        await writer.append(domain, observations as Array<RecordedObservation>)
        await writer.settled()
      } catch (error) {
        throw refusal(error)
      }
      return {
        through: writer.through === undefined ? null : String(writer.through),
        source: writer.run.source,
      }
    },
    async result(given, bytes) {
      const result = readResultRef(given)
      if (!result)
        throw new BridgeDenied('A result is a @theorem/runtime ResultRef.')
      try {
        return { id: (await store.putResult(result, bytes)).id }
      } catch (error) {
        throw refusal(error)
      }
    },
    source: () => source,
    async open(id) {
      try {
        const result = await store.result(id as `sha256:${string}`)
        if (result.id !== id || !(await resultIdHolds(result)))
          throw new BridgeDenied(`The result read is not ${id}.`)
        // blob() checks the bytes against their digest.
        return { result, bytes: await store.blob(result.content) }
      } catch (error) {
        throw refusal(error)
      }
    },
    async run(id) {
      try {
        // reopenRun checks every chunk's bytes, its place and each state's digest.
        return await reopenRun(store, id)
      } catch (error) {
        throw refusal(error)
      }
    },
    async resolve(given) {
      const subject = readSubjectRef(given)
      if (!subject)
        throw new BridgeDenied('A subject is a @theorem/runtime SubjectRef.')
      try {
        const found = await store.resolve(subject)
        return found.status === 'available'
          ? { status: 'available' }
          : { status: 'unavailable', reason: found.reason }
      } catch (error) {
        throw refusal(error)
      }
    },
  }
}
