// SOURCING: none — thin mapping from the wire's document effects to ./documents (the owner); no behavior of its own beyond remembering which handle each open path holds
import type { Files } from '../files/files'
import type { Outcome } from '../environment/result'
import { reply, refusal } from '../port'
import type { Of, OwnerPort, OwnerReply } from '../port'
import type { HostMessage, ResourceRef, Revision } from '../wire'
import { tokenSpans } from './tokens'
import type { DocumentHistory } from './history'
import type { LocalState } from './local'
import type {
  DocumentEvent,
  DocumentHandle,
  Documents,
  EditCompletion,
} from './documents'

export interface DocumentsPortOptions {
  documents: Documents
  /** `documentCreate` makes the file first: the documents owner opens files, it does not make them. */
  files: Pick<Files, 'create' | 'delete'>
  /**
   * The history owner, built over the flush this port serves (the open session's edits answered, or refused
   * `pending_edits`). Absent: the history effects are refused `owner_unavailable`.
   */
  history?: (
    flush: HistoryFlush,
  ) => Pick<DocumentHistory, 'list' | 'preview' | 'restore'>
}

/** What the history owner calls before a restore: the document's own session says whether it holds unaccepted edits. */
export type HistoryFlush = (
  document: string,
  request: { requestId: string },
) => Promise<Outcome<unknown>>

const seq = (value: number): Revision => ({ scheme: 'seq', value })

const hostMessage = (event: DocumentEvent): HostMessage => {
  switch (event.kind) {
    case 'changed':
      return {
        type: 'documentChanged',
        resource: event.resource,
        revision: event.revision,
        actor: event.actor,
        ...(event.operationId ? { operationId: event.operationId } : {}),
        unit: event.unit,
        edits: event.edits,
      }
    case 'acknowledged':
      return {
        type: 'documentAcknowledged',
        resource: event.resource,
        revision: event.revision,
        operationId: event.operationId,
      }
    case 'resync':
      return {
        type: 'documentResync',
        resource: event.resource,
        revision: event.revision,
        text: event.text,
      }
    case 'saved':
      return {
        type: 'documentSaved',
        resource: event.resource,
        revision: event.revision,
      }
    case 'conflict':
      return {
        type: 'documentConflict',
        resource: event.resource,
        revision: event.revision,
        diskDeleted: event.diskDeleted,
      }
    case 'moved':
      return { type: 'documentMoved', from: event.from, to: event.to }
    case 'retired':
      return { type: 'documentRetired', resource: event.resource }
    case 'local':
      return {
        type: 'documentLocal',
        resource: event.resource,
        local: event.local,
      }
  }
}

/** The path a document resource names, or undefined for any other resource. */
const pathOf = (resource: ResourceRef): string | undefined =>
  resource.type === 'document' ? resource.resourceId : undefined

/** A document this workbench holds open, with the text and revision the owner holds for it now. */
export interface OpenDocument {
  path: string
  text: string
  revision: Revision
}

/** What happened to the set of open documents or to one's revision. A `moved` document is the same document under a new path. */
export type OpenDocumentChange =
  | { kind: 'opened' | 'revised' | 'closed'; path: string }
  /** Where the document's unaccepted work stands: draft, locally checkpointed or accepted. The wire has no message for it yet. */
  | { kind: 'local'; path: string; local: LocalState }
  | { kind: 'moved'; from: string; to: string }

/** What other owners read of the documents open here: the language owner's diagnostics feed is the first reader. */
export interface DocumentsView {
  list: () => OpenDocument[]
  on: (listener: (change: OpenDocumentChange) => void) => () => void
}

export function createDocumentsPort({
  documents,
  files,
  history: buildHistory,
}: DocumentsPortOptions): OwnerPort<Of<'document'>> & {
  view: DocumentsView
  /** Where one open document's unaccepted work stands now; `undefined` for a path not open here. */
  local: (path: string) => LocalState | undefined
} {
  /** The handle this port holds per path: one holder, however many times the path is opened. */
  const held = new Map<string, { handle: DocumentHandle; stop: () => void }>()
  const listeners = new Set<(message: HostMessage) => void>()
  const watchers = new Set<(change: OpenDocumentChange) => void>()
  const changed = (change: OpenDocumentChange) => {
    for (const watcher of [...watchers]) watcher(change)
  }
  const view: DocumentsView = {
    list: () =>
      [...held].map(([path, { handle }]) => ({
        path,
        text: handle.state.text,
        revision: handle.state.revision,
      })),
    on(watcher) {
      watchers.add(watcher)
      return () => void watchers.delete(watcher)
    },
  }

  /** The revision whose tokens each path was last sent, so one revision is tokenized once. */
  const tokened = new Map<string, number>()

  /**
   * Sends the highlight spans of a document's text at its current revision. A file with no grammar sends
   * none. It goes after the answer that announced the revision, so the panel knows the document first.
   */
  function sendTokens(path: string) {
    setTimeout(() => {
      const handle = held.get(path)?.handle
      if (!handle) return
      const { text, revision } = handle.state
      if (revision.scheme !== 'seq' || tokened.get(path) === revision.value)
        return
      const spans = tokenSpans(path, text)
      if (!spans) return
      tokened.set(path, revision.value)
      const message: HostMessage = {
        type: 'documentTokens',
        resource: handle.resource,
        revision,
        encoding: 'utf16_code_units',
        spans,
      }
      for (const listener of [...listeners]) listener(message)
    }, 0)
  }

  /** Where the document's unaccepted work stands, after the answer that announced the document. */
  function sendLocal(path: string) {
    setTimeout(() => {
      const handle = held.get(path)?.handle
      if (!handle) return
      const message: HostMessage = {
        type: 'documentLocal',
        resource: handle.resource,
        local: handle.state.local,
      }
      for (const listener of [...listeners]) listener(message)
    }, 0)
  }

  const forward = (event: DocumentEvent) => {
    if (event.kind === 'moved') {
      const from = pathOf(event.from)
      const to = pathOf(event.to)
      const entry = from === undefined ? undefined : held.get(from)
      if (entry && from !== undefined && to !== undefined) {
        held.delete(from)
        tokened.delete(from)
        held.set(to, entry)
        changed({ kind: 'moved', from, to })
      }
    }
    const message = hostMessage(event)
    for (const listener of [...listeners]) listener(message)
    if (event.kind === 'local') {
      const path = pathOf(event.resource)
      if (path !== undefined)
        changed({ kind: 'local', path, local: event.local })
    }
    if (
      event.kind === 'changed' ||
      event.kind === 'acknowledged' ||
      event.kind === 'resync'
    ) {
      const path = pathOf(event.resource)
      if (path !== undefined) {
        sendTokens(path)
        changed({ kind: 'revised', path })
      }
    }
    if (event.kind === 'retired') {
      const path = pathOf(event.resource)
      if (path !== undefined) changed({ kind: 'closed', path })
    }
  }

  /** The session's edits answered; a document not open here holds none. */
  const flush: HistoryFlush = async (path, { requestId }) => {
    const handle = held.get(path)?.handle
    return handle
      ? handle.flushed({ requestId })
      : { outcome: 'accepted', value: undefined }
  }
  const history = buildHistory?.(flush)

  const noDocument = (path: string): OwnerReply =>
    refusal('document_not_open', `${path} is not open in this workbench`)

  async function open(path: string, requestId: string): Promise<OwnerReply> {
    const known = held.get(path)
    let handle = known?.handle
    if (!handle) {
      const done = await documents.open({ requestId, path })
      if (done.outcome !== 'accepted') return reply(done)
      handle = done.value
      held.set(path, { handle, stop: handle.on(forward) })
      changed({ kind: 'opened', path })
    }
    const { state } = handle
    // An open is a panel that has no spans yet, so this revision's are sent again.
    tokened.delete(path)
    sendTokens(path)
    sendLocal(path)
    return {
      outcome: 'accepted',
      value: {
        type: 'documentOpened',
        text: state.text,
        revision: state.revision,
        ...(state.savedRevision ? { savedRevision: state.savedRevision } : {}),
        dirty: state.dirty,
        ...(state.readOnly ? { readOnly: state.readOnly } : {}),
        ...(state.pending.length > 0 ? { pending: state.pending } : {}),
      },
      revision: state.revision,
    }
  }

  function edited(
    handle: DocumentHandle,
    done: EditCompletion,
    operationId: string,
  ): OwnerReply {
    if (done.outcome === 'refused' && 'baseRevision' in done) {
      return {
        outcome: 'refused',
        code: done.code,
        reason: done.reason,
        value: {
          type: 'documentConflicted',
          operationId: done.operationId,
          baseRevision: done.baseRevision,
          current: done.current,
          pending: handle.state.pending,
        },
      }
    }
    return reply(done, ({ revision }) => ({
      value: { type: 'documentEdited', operationId, revision },
      revision,
    }))
  }

  return {
    view,
    local: (path) => held.get(path)?.handle.state.local,
    async perform(effect, requestId) {
      if (effect.kind === 'documentCreate') {
        const { path, seedText } = effect.payload
        const made = await files.create({
          requestId: `${requestId}:create`,
          path,
          kind: 'file',
          ...(seedText ? { text: seedText } : {}),
        })
        if (made.outcome !== 'accepted') return reply(made)
        const opened = await open(path, requestId)
        // An uncertain open may have happened on the host: the file stays.
        if (opened.outcome === 'accepted' || opened.outcome === 'uncertain')
          return opened
        // This call made the file (an accepted create) and the open failed: take it back. A file that
        // was already there makes the create refuse, so it never reaches this line.
        const removed = await files.delete({
          requestId: `${requestId}:rollback`,
          path,
        })
        if (removed.outcome === 'accepted') return opened
        return {
          ...opened,
          reason: `${opened.reason}; the file this call created could not be removed: ${removed.reason}`,
        }
      }

      const path = pathOf(effect.resource)
      if (path === undefined)
        return refusal(
          'wrong_resource',
          'A document effect needs a document resource',
        )

      switch (effect.kind) {
        case 'documentHistoryList':
        case 'documentHistoryPreview':
        case 'documentHistoryRestore': {
          if (!history)
            return refusal(
              'owner_unavailable',
              'The document history owner is not available',
            )
          if (effect.kind === 'documentHistoryList')
            return reply(await history.list(path, { requestId }), (list) => ({
              value: {
                type: 'documentHistory',
                entries: list.entries.map(({ point, revision }) => ({
                  point,
                  revision: seq(revision),
                })),
              },
            }))
          if (effect.kind === 'documentHistoryPreview')
            return reply(
              await history.preview(path, effect.payload.point, { requestId }),
              ({ text }) => ({ value: { type: 'documentPreview', text } }),
            )
          const opened = held.get(path)
          if (!opened) return noDocument(path)
          const done = await history.restore(path, effect.payload.point, {
            requestId,
          })
          if (done.outcome === 'accepted') {
            // The restore arrives as a new revision on the live stream; this reads the head so the core hears it
            // now even if the stream is late. A failed read is not a failed restore: the stream still delivers it.
            const read = await opened.handle.refresh({
              requestId: `${requestId}:refresh`,
            })
            if (read.outcome !== 'accepted')
              console.warn(
                `${path} was restored but its head could not be read: ${read.outcome}`,
              )
          }
          return reply(done)
        }
      }

      if (effect.kind === 'documentOpen') {
        // The owner opens what the checkout has; it has no text to seed a document with.
        if (effect.payload.seedText)
          return refusal(
            'unsupported_seed',
            'The documents owner opens a file as it is and cannot seed it with text',
          )
        return open(path, requestId)
      }

      const entry = held.get(path)
      if (!entry) return noDocument(path)
      const { handle } = entry

      switch (effect.kind) {
        case 'documentEdit': {
          const { operationId, unit, edits } = effect.payload
          if (unit !== 'utf16')
            return refusal(
              'unsupported_unit',
              `The documents owner counts UTF-16 units, not ${unit}`,
            )
          if (!effect.revision)
            return refusal(
              'revision_required',
              'An edit names the revision it was computed against',
            )
          return edited(
            handle,
            await handle.edit({
              requestId,
              operationId,
              baseRevision: effect.revision,
              edits,
            }),
            operationId,
          )
        }
        case 'documentSave':
          return reply(await handle.save({ requestId }), ({ revision }) => ({
            value: { type: 'documentSaved', revision },
            revision,
          }))
        case 'documentReconcile':
          return reply(
            await handle.reconcile({ requestId, keep: effect.payload.keep }),
            ({ revision, text }) => ({
              value: { type: 'documentReconciled', revision, text },
              revision,
            }),
          )
        case 'documentRevert':
          return reply(
            await handle.revert({ requestId }),
            ({ revision, text }) => ({
              value: { type: 'documentReconciled', revision, text },
              revision,
            }),
          )
        case 'documentSettle':
          handle.settle(effect.payload.operationId)
          return { outcome: 'accepted' }
        case 'documentKeep':
          // Kept on this device, sent nowhere; the whole queue each time, empty when nothing is held.
          handle.keep(effect.payload.edits)
          return { outcome: 'accepted' }
        case 'documentClose': {
          const done = await handle.close({ requestId })
          if (done.outcome === 'accepted') {
            entry.stop()
            held.delete(path)
            tokened.delete(path)
            changed({ kind: 'closed', path })
          }
          return reply(done)
        }
      }
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
  }
}
