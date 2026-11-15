// SOURCING: none — thin mapping from the wire's document effects to ./documents (the owner); no behavior of its own beyond remembering which handle each open path holds
import type { Files } from '../files/files'
import { reply, refusal } from '../port'
import type { Of, OwnerPort, OwnerReply } from '../port'
import type { HostMessage, ResourceRef } from '../wire'
import type {
  DocumentEvent,
  DocumentHandle,
  Documents,
  EditCompletion,
} from './documents'

export interface DocumentsPortOptions {
  documents: Documents
  /** `documentCreate` makes the file first: the documents owner opens files, it does not make them. */
  files: Pick<Files, 'create'>
}

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
  }
}

/** The path a document resource names, or undefined for any other resource. */
const pathOf = (resource: ResourceRef): string | undefined =>
  resource.type === 'document' ? resource.resourceId : undefined

export function createDocumentsPort({
  documents,
  files,
}: DocumentsPortOptions): OwnerPort<Of<'document'>> {
  /** The handle this port holds per path: one holder, however many times the path is opened. */
  const held = new Map<string, { handle: DocumentHandle; stop: () => void }>()
  const listeners = new Set<(message: HostMessage) => void>()

  const forward = (event: DocumentEvent) => {
    if (event.kind === 'moved') {
      const from = pathOf(event.from)
      const to = pathOf(event.to)
      const entry = from === undefined ? undefined : held.get(from)
      if (entry && from !== undefined && to !== undefined) {
        held.delete(from)
        held.set(to, entry)
      }
    }
    const message = hostMessage(event)
    for (const listener of [...listeners]) listener(message)
  }

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
    }
    const { state } = handle
    return {
      outcome: 'accepted',
      value: {
        type: 'documentOpened',
        text: state.text,
        revision: state.revision,
        ...(state.savedRevision ? { savedRevision: state.savedRevision } : {}),
        dirty: state.dirty,
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
        return open(path, requestId)
      }

      const path = pathOf(effect.resource)
      if (path === undefined)
        return refusal(
          'wrong_resource',
          'A document effect needs a document resource',
        )

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
        case 'documentClose': {
          const done = await handle.close({ requestId })
          if (done.outcome === 'accepted') {
            entry.stop()
            held.delete(path)
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
