// SOURCING: none: the saved Apps running on this page, by document, each with
// its frame's end of the bridge, so `app.control` (app-operations.ts) reaches
// the App the person is looking at. A frame is listed from its connection
// until it is unmounted; the newest frame of a document is the one reached.
import type { FrameConnection } from './executor'
import type { Rpc } from './sandbox/protocol'

interface Running {
  documentId: string
  title: string
  rpc: Rpc
}

const running: Array<Running> = []

/** Lists `connection`'s frame as running `documentId` once it connects; returns what unlists it. */
export function trackRunningApp(documentId: string, title: string, connection: FrameConnection): () => void {
  let entry: Running | undefined
  let active = true
  void connection.connected.then(
    (rpc) => {
      if (!active) return
      entry = { documentId, title, rpc }
      running.push(entry)
    },
    () => {},
  )
  return () => {
    active = false
    const at = entry ? running.indexOf(entry) : -1
    if (at >= 0) running.splice(at, 1)
  }
}

/** The newest running frame of `documentId`. */
export const runningApp = (documentId: string): Rpc | undefined =>
  running.findLast((entry) => entry.documentId === documentId)?.rpc

/** Each running App once, newest frame first: its document and title. */
export function runningApps(): Array<{ documentId: string; title: string }> {
  const seen = new Map<string, string>()
  for (const entry of running.toReversed()) if (!seen.has(entry.documentId)) seen.set(entry.documentId, entry.title)
  return [...seen].map(([documentId, title]) => ({ documentId, title }))
}
