// SOURCING: @theoremharness/sdk-ide's utf8ToUtf16 (the host's findings count UTF-8 bytes of the document text at one revision); the line and column of a UTF-16 offset is the one thing computed here, because the SDK has an offset converter but no position one and @codemirror/state's Text would count a CRLF as one unit where the host's text counts two. The host has no push for diagnostics (only `diagnostics.subscribe`, one snapshot per call), so the feed asks again when a document's revision moves.

import { utf8ToUtf16 } from '@theoremharness/sdk-ide'
import type { DocumentsView, OpenDocument } from '../documents/port'
import type { FindingAt, HostMessage } from '../wire'
import type { Language } from './language'

export interface DiagnosticsFeedOptions {
  language: Pick<Language, 'diagnostics'>
  documents: Pick<DocumentsView, 'list' | 'on'>
  emit: (message: HostMessage) => void
  /** Quiet time after a document's revision moves before it is asked about. */
  debounceMs?: number
  /** How long to wait before asking again when the host said its findings are not the whole set. */
  partialMs?: number
  /** Asks again at most this many times for a partial set. */
  partialRetries?: number
  /** Defaults to timers; tests pass their own. */
  timer?: {
    set: (task: () => void, ms: number) => unknown
    clear: (handle: unknown) => void
  }
}

/** The line and column (UTF-16 code units) of a UTF-16 offset. */
export function positionAt(text: string, offset: number) {
  let line = 0
  let start = 0
  for (let at = text.indexOf('\n'); at !== -1 && at < offset;) {
    line += 1
    start = at + 1
    at = text.indexOf('\n', start)
  }
  return { line, character: offset - start }
}

/**
 * Sends `diagnosticsSet` for every document open here whenever its findings or accepted revision change,
 * and `diagnosticsCleared` when one closes. A set is for the document's current revision only: an answer
 * for another one is dropped, and the revision that replaced it asks again. A host that does not offer
 * `diagnostics.subscribe` gets nothing sent. Returns its stop.
 */
export function startDiagnosticsFeed({
  language,
  documents,
  emit,
  debounceMs = 250,
  partialMs = 500,
  partialRetries = 5,
  timer = {
    set: (task, ms) => setTimeout(task, ms),
    clear: (handle) => clearTimeout(handle as never),
  },
}: DiagnosticsFeedOptions): () => void {
  const state = new Map<
    string,
    { timer?: unknown; sent?: string; partial: number; asks: number }
  >()
  const flags = { stopped: false, unsupported: false }
  const stopped = () => flags.stopped

  const entry = (path: string) => {
    let known = state.get(path)
    if (!known) {
      known = { partial: 0, asks: 0 }
      state.set(path, known)
    }
    return known
  }
  const current = (path: string): OpenDocument | undefined =>
    documents.list().find((document) => document.path === path)

  function schedule(path: string, ms: number) {
    const known = entry(path)
    if (known.timer !== undefined) timer.clear(known.timer)
    known.timer = timer.set(() => {
      known.timer = undefined
      void ask(path)
    }, ms)
  }

  async function ask(path: string) {
    const document = current(path)
    if (flags.stopped || flags.unsupported || !document) return
    if (document.revision.scheme !== 'seq') return
    const known = entry(path)
    const requestId = `diagnostics:${path}:${(known.asks += 1)}`
    const done = await language.diagnostics({
      requestId,
      resourceId: path,
      revision: document.revision.value,
    })
    if (stopped()) return
    if (done.outcome !== 'accepted') {
      if (done.outcome === 'refused' && done.code === 'missing_capability')
        flags.unsupported = true
      return
    }
    // The text the offsets count is the document's at the snapshot's revision; only the current one is held.
    const now = current(path)
    const snapshot = done.value
    if (
      !now ||
      now.revision.scheme !== 'seq' ||
      snapshot.revision === undefined ||
      snapshot.revision !== now.revision.value
    )
      return
    const findings = snapshot.findings.flatMap((finding): FindingAt[] => {
      try {
        const start = utf8ToUtf16(now.text, finding.start)
        const end = utf8ToUtf16(now.text, finding.end)
        return [
          {
            range: {
              start: positionAt(now.text, start),
              end: positionAt(now.text, end),
            },
            severity: finding.severity,
            message: finding.message,
            ...(finding.provider ? { source: finding.provider } : {}),
            ...(finding.id ? { code: finding.id } : {}),
          },
        ]
      } catch {
        // A byte offset inside a character, or past the text: the host and this text disagree about it, so it is not placed.
        return []
      }
    })
    const key = JSON.stringify([snapshot.revision, findings])
    if (key !== known.sent) {
      known.sent = key
      emit({
        type: 'diagnosticsSet',
        path,
        revision: { scheme: 'seq', value: snapshot.revision },
        encoding: 'utf16_code_units',
        findings,
      })
    }
    if (!snapshot.full && known.partial < partialRetries) {
      known.partial += 1
      schedule(path, partialMs)
    } else if (snapshot.full) known.partial = 0
  }

  function clear(path: string) {
    const known = state.get(path)
    if (!known) return
    if (known.timer !== undefined) timer.clear(known.timer)
    state.delete(path)
    if (known.sent !== undefined) emit({ type: 'diagnosticsCleared', path })
  }

  for (const { path } of documents.list()) schedule(path, 0)
  const off = documents.on((change) => {
    switch (change.kind) {
      case 'opened':
        schedule(change.path, 0)
        return
      case 'revised':
        entry(change.path).partial = 0
        schedule(change.path, debounceMs)
        return
      case 'closed':
        clear(change.path)
        return
      case 'moved':
        clear(change.from)
        schedule(change.to, 0)
        return
    }
  })

  return () => {
    flags.stopped = true
    off()
    for (const known of state.values())
      if (known.timer !== undefined) timer.clear(known.timer)
    state.clear()
  }
}
