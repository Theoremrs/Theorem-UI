import { describe, expect, it } from 'bun:test'
import { TRACE_RECORDING_ROUTE, traceRecording } from './app-traces'

const trace = { recordingId: 'spatial-a:0', frames: [{ cycle: 0, cause: 'start', values: {} }] }

describe('an App trace recording', () => {
  it('posts the trace to the backend and returns the recording bytes', async () => {
    const sent: Array<{ url: string; init: RequestInit }> = []
    const bytes = await traceRecording(trace, async (url, init) => {
      sent.push({ url, init })
      return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'application/vnd.rerun.rrd' } })
    })
    expect([...bytes]).toEqual([1, 2, 3])
    expect(sent[0]?.url).toBe(TRACE_RECORDING_ROUTE)
    expect(sent[0]?.init.method).toBe('POST')
    expect(JSON.parse(sent[0]?.init.body as string)).toEqual(trace)
  })

  it("says what the backend refused, in the backend's words", async () => {
    const refused = await traceRecording(trace, async () =>
      Response.json(
        { title: 'The trace could not be written as a recording', detail: 'A model trace needs a recording id' },
        { status: 422 },
      ),
    ).then(() => '', (error: Error) => error.message)
    expect(refused).toBe('The trace could not be written as a recording: A model trace needs a recording id')
  })
})
