// SOURCING: the platform's fetch, through this origin's Theorem proxy
// (src/server/theorem-proxy.ts adds the bearer). The backend writes the
// recording with Rerun's Rust SDK (theorem-proto-emit, trace.rs); no browser
// library writes Rerun's format.
import type { ModelTrace } from '../blocks/sandbox/protocol'

export const TRACE_RECORDING_ROUTE = '/api/chat/v1/apps/traces/rrd'

/** An App's model trace as a Rerun recording: `.rrd` bytes. */
export async function traceRecording(
  trace: ModelTrace,
  request: (input: string, init: RequestInit) => Promise<Response> = (input, init) =>
    window.fetch(input, init),
): Promise<Uint8Array> {
  const response = await request(TRACE_RECORDING_ROUTE, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(trace),
  })
  if (!response.ok) {
    const problem = (await response.json().catch(() => null)) as {
      title?: string
      detail?: string
    } | null
    throw new Error(
      [problem?.title ?? `The recording was refused (${response.status})`, problem?.detail]
        .filter(Boolean)
        .join(': '),
    )
  }
  return new Uint8Array(await response.arrayBuffer())
}
