// SOURCING: none: a fake of the backend's durable artifact routes
// (rustyred-thg-server theorem_apps_artifacts_api.rs) that keeps their rules:
// bytes before records, chunks in order from index 0, immutable runs, CSRF and
// an Idempotency-Key on writes, exact resolution. For bun:test only.
import { digestBytes } from '../../src/lib/blocks/artifact-runtime'
import {
  artifactStore,
  base64Of,
  bytesOf,
} from '../../src/lib/theorem/artifact-store'
import type { TraceChunk } from '../../src/lib/theorem/artifact-store'

export function backend(options: { staleToken?: boolean } = {}) {
  const blobs = new Map<string, Uint8Array>()
  const chunks: Array<TraceChunk> = []
  const runs = new Map<string, string>()
  const results = new Map<string, string>()
  const log: Array<string> = []
  let token = options.staleToken ? 'old' : 'current'
  const refuse = (status: number, code: string) =>
    new Response(JSON.stringify({ code, message: code }), { status })
  const ok = (body: unknown) =>
    new Response(JSON.stringify(body), { status: 200 })
  const request = async (input: string, init: RequestInit) => {
    const url = new URL(input, 'https://theorem.test')
    const route = url.pathname.split('/').at(-1)!
    if (init.method === 'POST' && route !== 'resolve') {
      const headers = init.headers as Record<string, string>
      if (headers['X-CSRF-Token'] !== 'current')
        return refuse(403, 'csrf_refused')
      if (!headers['Idempotency-Key'])
        return refuse(400, 'idempotency_key_missing')
    }
    const body = init.body
      ? (JSON.parse(init.body as string) as Record<string, unknown>)
      : {}
    log.push(`${init.method} ${route}`)
    switch (`${init.method} ${route}`) {
      case 'POST blobs': {
        const bytes = bytesOf(body.base64 as string)
        const digest = await digestBytes(bytes)
        blobs.set(digest, bytes)
        return ok({ digest, bytes: String(bytes.length) })
      }
      case 'GET blobs': {
        const bytes = blobs.get(url.searchParams.get('digest')!)
        return bytes
          ? ok({ base64: base64Of(bytes) })
          : refuse(404, 'artifact_blob_not_found')
      }
      case 'POST runs': {
        const text = JSON.stringify(body)
        if (runs.has(body.id as string) && runs.get(body.id as string) !== text)
          return refuse(409, 'apps_immutable_conflict')
        runs.set(body.id as string, text)
        return ok(body)
      }
      case 'POST chunks': {
        const chunk = body as unknown as TraceChunk
        if (!runs.has(chunk.runId)) return refuse(400, 'artifact_chunk_invalid')
        if (!blobs.has(chunk.blob)) return refuse(400, 'artifact_blob_missing')
        const own = chunks.filter((stored) => stored.runId === chunk.runId)
        const expected =
          own.length === 0
            ? 0
            : Number(own.at(-1)!.observations.at(-1)!.index) + 1
        if (
          Number(chunk.sequence) !== own.length ||
          Number(chunk.observations[0]!.index) !== expected
        )
          return refuse(400, 'artifact_chunk_out_of_order')
        chunks.push(chunk)
        return ok({ appended: 'appended' })
      }
      case 'POST results': {
        if (!blobs.has(body.content as string))
          return refuse(400, 'artifact_blob_missing')
        results.set(body.id as string, JSON.stringify(body))
        return ok(body)
      }
      case 'GET results': {
        const held = results.get(url.searchParams.get('result_id')!)
        return held
          ? ok(JSON.parse(held))
          : refuse(404, 'artifact_result_not_found')
      }
      case 'POST resolve': {
        const subject = body.subject as Record<string, any> | undefined
        if (subject?.kind === 'result')
          return ok(
            results.get(subject.result.id) === JSON.stringify(subject.result)
              ? { status: 'available', subject }
              : { status: 'unavailable', subject, reason: 'not-stored' },
          )
        if (subject?.kind === 'moment') {
          const at = subject.observation
          const held = chunks.flatMap((chunk) =>
            chunk.runId === at.runId ? chunk.observations : [],
          )[Number(at.index)]
          return ok(
            held?.stateDigest === at.stateDigest
              ? { status: 'available', subject }
              : { status: 'unavailable', subject, reason: 'moment-not-held' },
          )
        }
        return refuse(400, 'artifact_subject_invalid')
      }
      default:
        return refuse(404, 'route_not_found')
    }
  }
  return {
    blobs,
    chunks,
    runs,
    log,
    store: artifactStore({
      request,
      csrf: async (fresh) => {
        if (fresh) token = 'current'
        return token
      },
    }),
  }
}
