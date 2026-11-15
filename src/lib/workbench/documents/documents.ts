// SOURCING: @theoremharness/sdk — each call is the generated client.documentSessions.* operation
// (open, edit, save, close, head, reconcile), live document events arrive on WorkspaceLive through
// ../environment, and utf16ToScalar / scalarToUtf16 are the SDK's own offset helpers. The SDK's
// DocumentSession class is NOT used: its constructor is private and wants a full TheoremClient and
// WorkspaceLive, it has no explicit base revision (it rebases local edits by operational transform),
// and on an unrecognised refusal its `reset` drops unaccepted edits (gate-0 owners 4, G1). The
// workbench's contract is the opposite: the Rust side rebases, so a stale edit is refused as a conflict
// and its text is kept here until the caller settles it. This file maps the host's answers to that.

import { scalarToUtf16, utf16ToScalar } from '@theoremharness/sdk'
import type { WorkspaceLiveEvents } from '@theoremharness/sdk'
import type {
  Environment,
  HostClient,
  LiveLease,
} from '../environment/environment'
import { createRun } from '../environment/run'
import { accepted, failure, refused } from '../environment/result'
import type { Answers, Completion } from '../environment/result'
import type { ReconcileKeep } from '../wire/ReconcileKeep'
import type { ResourceRef } from '../wire/ResourceRef'
import type { Revision } from '../wire/Revision'
import type { TextChange } from '../wire/TextChange'

/** The calls the documents owner makes of a Theorem client are `HostClient`'s. */
export type DocumentsClient = HostClient

/** Why an edit is held: the caller's text is kept until `settle` is called for its operation. */
export type PendingState =
  /** Sent; the host has not answered yet. */
  | 'inflight'
  /** Its base revision was not the document's: nothing was applied. */
  | 'conflicted'
  /** The host refused it for another reason: nothing was applied. */
  | 'refused'
  /** The answer was lost: it may or may not be applied. Never resent here. */
  | 'uncertain'

export interface PendingEdit {
  operationId: string
  baseRevision: Revision
  /** UTF-16 ranges against the text at `baseRevision`, as the caller sent them. */
  edits: TextChange[]
  state: PendingState
  reason?: string
}

export interface DocumentState {
  /** The authority's text at `revision`. Edits in `pending` are not in it. */
  text: string
  revision: Revision
  /** The revision the checkout holds, when known. */
  savedRevision?: Revision
  /** Reported, not inferred: pending edits, or a revision the checkout lacks, or a save whose answer was lost. */
  dirty: boolean
  /** A save was sent and its answer lost; whether the checkout has the text is not known. */
  saveUncertain: boolean
  pending: PendingEdit[]
  /** The host retired this document (deleted or replaced); edits are refused. */
  retired: boolean
  /** Why the document cannot be edited now: the host retired it, or says it does not take edits. Absent while it can be. */
  readOnly?: { reason: string }
}

export type DocumentEvent =
  /** Another writer's change: UTF-16 ranges against the text before it, for the Rust side to rebase over. */
  | {
      kind: 'changed'
      resource: ResourceRef
      revision: Revision
      actor: string
      operationId?: string
      unit: 'utf16'
      edits: TextChange[]
    }
  /** The caller's own edit was accepted, seen on the live stream before or instead of its answer. */
  | {
      kind: 'acknowledged'
      resource: ResourceRef
      revision: Revision
      operationId: string
    }
  /** A gap in the events, a reconnect or a revert: replace what is shown with this. */
  | {
      kind: 'resync'
      resource: ResourceRef
      revision: Revision
      text: string
    }
  | { kind: 'saved'; resource: ResourceRef; revision: Revision }
  | {
      kind: 'conflict'
      resource: ResourceRef
      revision: Revision
      diskDeleted: boolean
    }
  | { kind: 'moved'; from: ResourceRef; to: ResourceRef }
  | { kind: 'retired'; resource: ResourceRef }

/** An edit refused because its base revision was not the document's. The caller's edit is in `pending`. */
export type ConflictCompletion = Answers & {
  outcome: 'refused'
  code: 'conflict'
  reason: string
  operationId: string
  baseRevision: Revision
  current: { revision: Revision; text: string }
}

export type EditCompletion =
  Completion<{ revision: Revision }> | ConflictCompletion

interface Request {
  requestId: string
}

export interface DocumentHandle {
  readonly path: string
  readonly resource: ResourceRef
  readonly state: DocumentState
  /**
   * Apply explicit UTF-16 ranges on top of `baseRevision`. A base that is not
   * the document's revision is refused as a conflict with the current revision
   * and text, and the edit stays in `state.pending`; it is never applied
   * against a different revision and never dropped.
   */
  edit: (
    request: Request & {
      operationId: string
      baseRevision: Revision
      edits: TextChange[]
    },
  ) => Promise<EditCompletion>
  /** Saves the authority's revision. A lost answer is `uncertain` and the save is not repeated. */
  save: (request: Request) => Promise<Completion<{ revision: Revision }>>
  /** Resolves a conflict between the checkout and the authority, then re-reads the document. */
  reconcile: (
    request: Request & { keep: ReconcileKeep },
  ) => Promise<Completion<{ revision: Revision; text: string }>>
  /** Drops unsaved edits and returns to the checkout's text: `reconcile` keeping the disk, and pending edits are discarded. */
  revert: (
    request: Request,
  ) => Promise<Completion<{ revision: Revision; text: string }>>
  /** The caller has dealt with a pending edit (rebased and resent it, or chose to drop it). */
  settle: (operationId: string) => void
  on: (listener: (event: DocumentEvent) => void) => () => void
  /** Releases this holder; the host session closes once, when the last holder releases. */
  close: (request: Request) => Promise<Completion<{ path: string }>>
}

export interface Documents {
  /** One session per path, shared by every holder; a second open does not call the host. */
  open: (
    request: Request & { path: string },
  ) => Promise<Completion<DocumentHandle>>
  dispose: () => void
}

interface Head {
  document_id: string
  revision: number
  content_hash?: string
  text?: string
  binary?: boolean
  retired?: boolean
  disk_hash?: string | null
}

type RevisionRecord = WorkspaceLiveEvents['document.changed']

interface Session {
  path: string
  documentId: string
  text: string
  revision: number
  savedRevision?: number
  saveUncertain: boolean
  retired: boolean
  pending: Map<string, PendingEdit>
  holders: number
  listeners: Set<(event: DocumentEvent) => void>
  lease: LiveLease
  /** Edits, saves and re-reads run one after another, so a base revision is checked against the revision it will meet. */
  queue: Promise<unknown>
}

const STALE = new Set(['stale_revision', 'revision_conflict'])
const seq = (value: number): Revision => ({ scheme: 'seq', value })

/** The workspace path without a leading `./` or trailing `/`. */
function cleanPath(path: string): string {
  return path.replace(/^(\.\/)+/, '').replace(/\/+$/, '')
}

function escapes(path: string): boolean {
  return (
    path === '' ||
    path === '.' ||
    path.startsWith('/') ||
    path.includes('\0') ||
    path.split('/').some((segment) => segment === '..')
  )
}

/** `text` with simultaneous, ascending, non-overlapping UTF-16 edits applied. */
function applyEdits(text: string, edits: TextChange[]): string {
  let out = ''
  let at = 0
  for (const edit of edits) {
    out += text.slice(at, edit.start) + edit.insert
    at = edit.end
  }
  return out + text.slice(at)
}

/** The caller's ranges in order and checked against `text`; a message when they cannot be applied. */
function checkRanges(
  text: string,
  edits: TextChange[],
): { edits: TextChange[] } | { problem: string } {
  const sorted = [...edits].sort((a, b) => a.start - b.start || a.end - b.end)
  let previousEnd = 0
  for (const edit of sorted) {
    if (
      !Number.isInteger(edit.start) ||
      !Number.isInteger(edit.end) ||
      edit.start < 0 ||
      edit.end < edit.start ||
      edit.end > text.length
    ) {
      return { problem: `range ${edit.start}..${edit.end} is outside the text` }
    }
    if (edit.start < previousEnd) {
      return { problem: 'ranges overlap' }
    }
    previousEnd = edit.end
  }
  return { edits: sorted }
}

export function createDocuments(env: Environment<DocumentsClient>): Documents {
  const { workspaceId } = env
  const sessions = new Map<string, Session>()
  const opening = new Map<string, Promise<Completion<Session>>>()
  const closing = new Map<string, Promise<unknown>>()
  const docs = () => env.client.documentSessions
  /** A write is sent once; the SDK's own retries are off, so the host sees it once. */
  const once = { maxRetries: 0 }

  const resourceOf = (session: Session): ResourceRef => ({
    type: 'document',
    workspace: workspaceId,
    resourceId: session.path,
  })

  function emit(session: Session, event: DocumentEvent) {
    for (const listener of [...session.listeners]) {
      try {
        listener(event)
      } catch (error) {
        console.warn('A document listener failed', error)
      }
    }
  }

  function stateOf(session: Session): DocumentState {
    const pending = [...session.pending.values()].map((edit) => ({
      ...edit,
      edits: edit.edits.map((change) => ({ ...change })),
    }))
    return {
      text: session.text,
      revision: seq(session.revision),
      savedRevision:
        session.savedRevision === undefined
          ? undefined
          : seq(session.savedRevision),
      dirty:
        pending.length > 0 ||
        session.saveUncertain ||
        session.savedRevision !== session.revision,
      saveUncertain: session.saveUncertain,
      pending,
      retired: session.retired,
      ...readOnlyOf(session),
    }
  }

  /** Only a reason the host or the document gave: an edit operation the host lists as unavailable, or a retired document. */
  function readOnlyOf(session: Session): Pick<DocumentState, 'readOnly'> {
    if (session.retired)
      return { readOnly: { reason: `${session.path} was retired by the host` } }
    const edit = env.operations().find(({ name }) => name === 'documents.edit')
    return edit?.state.state === 'unavailable'
      ? {
          readOnly: {
            reason: `The host does not take edits: ${edit.state.reason}`,
          },
        }
      : {}
  }

  function serial<T>(session: Session, task: () => Promise<T>): Promise<T> {
    const next = session.queue.then(task, task)
    session.queue = next.catch(() => undefined)
    return next
  }

  const run = createRun(env)

  /** Takes the host's head as the document's own. Returns whether what the caller sees changed. */
  function adopt(session: Session, head: Head): boolean {
    const text = head.text ?? ''
    const changed = head.revision !== session.revision || text !== session.text
    session.text = text
    session.revision = head.revision
    if (head.disk_hash !== undefined && head.content_hash !== undefined) {
      if (head.disk_hash === head.content_hash) {
        session.savedRevision = head.revision
      }
    }
    return changed
  }

  /** Reads the document's head again (or seats it again after the host reopened the workspace). */
  async function reread(
    session: Session,
    how: 'head' | 'seat',
    force = false,
  ): Promise<boolean> {
    const id = crypto.randomUUID()
    const headers = env.headers(id)
    const head = (
      how === 'seat'
        ? await docs().open({ ...headers, resource_id: session.path })
        : await docs().head({
            ...headers,
            body: { document_id: session.documentId },
          })
    ) as Head
    const changed = adopt(session, head)
    if (changed || force) {
      emit(session, {
        kind: 'resync',
        resource: resourceOf(session),
        revision: seq(session.revision),
        text: session.text,
      })
    }
    return changed
  }

  /** Best effort: an edit that met a stale revision means the stream missed something. */
  async function refreshQuietly(session: Session) {
    try {
      await reread(session, 'head')
    } catch (error) {
      console.warn('The document head could not be read', error)
    }
  }

  function conflict(
    session: Session,
    answers: Answers,
    operationId: string,
    baseRevision: Revision,
    reason: string,
  ): ConflictCompletion {
    return {
      ...answers,
      outcome: 'refused',
      code: 'conflict',
      reason,
      operationId,
      baseRevision,
      current: { revision: seq(session.revision), text: session.text },
    }
  }

  /** A record from the live stream, for a document this module has open. */
  function receive(session: Session, record: RevisionRecord) {
    if (record.revision <= session.revision) return
    if (record.revision !== session.revision + 1 || record.binary) {
      void refreshQuietly(session)
      return
    }
    const before = session.text
    const edits: TextChange[] = record.edits.map((edit) => ({
      start: scalarToUtf16(before, edit.start),
      end: scalarToUtf16(before, edit.end),
      insert: edit.insert,
    }))
    session.text = applyEdits(before, edits)
    session.revision = record.revision
    const own = session.pending.get(record.operation_id)
    if (own && (own.state === 'inflight' || own.state === 'uncertain')) {
      session.pending.delete(record.operation_id)
      emit(session, {
        kind: 'acknowledged',
        resource: resourceOf(session),
        revision: seq(record.revision),
        operationId: record.operation_id,
      })
      return
    }
    emit(session, {
      kind: 'changed',
      resource: resourceOf(session),
      revision: seq(record.revision),
      actor: record.actor,
      operationId: record.operation_id,
      unit: 'utf16',
      edits,
    })
  }

  function watch(session: Session) {
    const { lease } = session
    lease.on('document.changed', ({ data }) => {
      if (data.document_id === session.documentId) receive(session, data)
    })
    lease.on('document.saved', ({ data }) => {
      if (data.document_id !== session.documentId) return
      session.savedRevision = Math.max(
        session.savedRevision ?? 0,
        data.revision,
      )
      if (data.revision >= session.revision) session.saveUncertain = false
      emit(session, {
        kind: 'saved',
        resource: resourceOf(session),
        revision: seq(data.revision),
      })
    })
    lease.on('document.conflict', ({ data }) => {
      if (data.document_id !== session.documentId) return
      emit(session, {
        kind: 'conflict',
        resource: resourceOf(session),
        revision: seq(data.revision),
        diskDeleted: data.disk_deleted,
      })
    })
    lease.on('document.moved', ({ data }) => {
      if (data.document_id !== session.documentId) return
      const from = resourceOf(session)
      sessions.delete(session.path)
      session.path = data.resource_id
      sessions.set(session.path, session)
      emit(session, { kind: 'moved', from, to: resourceOf(session) })
    })
    lease.on('document.retired', ({ data }) => {
      if (data.document_id !== session.documentId) return
      session.retired = true
      emit(session, { kind: 'retired', resource: resourceOf(session) })
    })
    // Events lost across a reconnect: read the head and tell the holders if it differs.
    lease.onReconnected(() => void refreshQuietly(session))
  }

  const unsubscribe = env.subscribe((event) => {
    if (event.type !== 'reopened') return
    for (const session of sessions.values()) {
      void reread(session, 'seat').catch((error) =>
        console.warn('The document could not be seated again', error),
      )
    }
  })

  async function openSession(
    requestId: string,
    path: string,
  ): Promise<Completion<Session>> {
    await closing.get(path)
    const head = await run(requestId, 'documents.open', false, (headers) =>
      docs().open({ ...headers, resource_id: path }),
    )
    if (head.outcome !== 'accepted') return head
    const answers: Answers = { workspaceId, requestId }
    const raw = head.value as Head
    if (raw.binary || raw.retired) {
      void docs()
        .close(
          { ...env.headers(crypto.randomUUID()), body: { resource_id: path } },
          once,
        )
        .catch(() => undefined)
      return refused(
        answers,
        raw.binary ? 'binary_file' : 'retired',
        raw.binary ? `${path} is not a text file` : `${path} was retired`,
      )
    }
    const session: Session = {
      path,
      documentId: raw.document_id,
      text: raw.text ?? '',
      revision: raw.revision,
      saveUncertain: false,
      retired: false,
      pending: new Map(),
      holders: 0,
      listeners: new Set(),
      lease: env.acquireLive(),
      queue: Promise.resolve(),
    }
    if (raw.disk_hash !== undefined && raw.disk_hash === raw.content_hash) {
      session.savedRevision = raw.revision
    }
    watch(session)
    sessions.set(path, session)
    return accepted(answers, session)
  }

  function handleFor(session: Session): DocumentHandle {
    const own = new Set<(event: DocumentEvent) => void>()
    let released = false

    const gone = (requestId: string) =>
      refused(
        { workspaceId, requestId },
        'closed',
        `${session.path} is closed in this pane`,
      )

    async function edit({
      requestId,
      operationId,
      baseRevision,
      edits,
    }: Parameters<DocumentHandle['edit']>[0]): Promise<EditCompletion> {
      const answers: Answers = { workspaceId, requestId }
      if (released) return gone(requestId)
      if (baseRevision.scheme !== 'seq') {
        return refused(
          answers,
          'unsupported_revision',
          'A document edit needs a sequence revision as its base',
        )
      }
      return serial(session, async () => {
        const base = baseRevision.value
        if (session.retired) {
          return refused(answers, 'retired', `${session.path} was retired`)
        }
        if (edits.length === 0) {
          return accepted(answers, { revision: seq(session.revision) })
        }
        const hold = (state: PendingState, reason?: string) =>
          session.pending.set(operationId, {
            operationId,
            baseRevision,
            edits: edits.map((change) => ({ ...change })),
            state,
            reason,
          })
        if (base !== session.revision) {
          const reason = `The document is at revision ${session.revision}, not ${base}`
          hold('conflicted', reason)
          return conflict(session, answers, operationId, baseRevision, reason)
        }
        const checked = checkRanges(session.text, edits)
        if ('problem' in checked) {
          return refused(answers, 'invalid_range', checked.problem)
        }
        let scalar: { start: number; end: number; insert: string }[]
        try {
          scalar = checked.edits.map((change) => ({
            start: utf16ToScalar(session.text, change.start),
            end: utf16ToScalar(session.text, change.end),
            insert: change.insert,
          }))
        } catch (error) {
          return refused(
            answers,
            'invalid_range',
            error instanceof Error
              ? error.message
              : 'A range splits a character',
          )
        }
        hold('inflight')
        const done = await run(
          requestId,
          'documents.edit',
          true,
          (headers) =>
            docs().edit(
              {
                ...headers,
                resource_id: session.path,
                operation_id: operationId,
                base_revision: base,
                edits: scalar.map((change) => ({ ...change })),
              },
              once,
            ),
          // The operation id is the host's idempotency key.
          { idempotencyKey: operationId },
        )
        if (done.outcome === 'accepted') {
          const head = done.value as unknown as Head
          if (session.revision === base) {
            if (head.revision === base + 1) {
              session.text = applyEdits(session.text, checked.edits)
              session.revision = head.revision
            } else {
              // Someone else's revision sits between: take the host's text, and the edit is not applied as sent.
              adopt(session, head)
              emit(session, {
                kind: 'resync',
                resource: resourceOf(session),
                revision: seq(session.revision),
                text: session.text,
              })
              const reason = `The host is at revision ${head.revision}`
              hold('conflicted', reason)
              return conflict(
                session,
                answers,
                operationId,
                baseRevision,
                reason,
              )
            }
          }
          session.pending.delete(operationId)
          return accepted(answers, { revision: seq(session.revision) })
        }
        if (done.outcome === 'refused' && STALE.has(done.code)) {
          // The host's answer was a stale-revision refusal: re-read, so the conflict carries the real head.
          await refreshQuietly(session)
          hold('conflicted', done.reason)
          return conflict(
            session,
            answers,
            operationId,
            baseRevision,
            done.reason,
          )
        }
        if (done.outcome === 'refused') {
          hold('refused', done.reason)
        } else if (done.outcome === 'uncertain') {
          // Kept as sent: it may have been applied. A live event for this operation settles it.
          hold('uncertain', done.reason)
        } else {
          hold('refused', done.reason)
        }
        return done
      })
    }

    async function resolveWith(
      requestId: string,
      keep: ReconcileKeep,
      discard: boolean,
    ): Promise<Completion<{ revision: Revision; text: string }>> {
      if (released) return gone(requestId)
      return serial(session, async () => {
        const done = await run(
          requestId,
          'documents.reconcile',
          true,
          async (headers) => {
            await docs().reconcile(
              {
                ...headers,
                body: {
                  resource_id: session.path,
                  keep,
                  expected_revision: session.revision,
                },
              },
              once,
            )
          },
        )
        if (done.outcome !== 'accepted') return done
        try {
          await reread(session, 'head', true)
        } catch (error) {
          return failure({ workspaceId, requestId }, error, false)
        }
        if (discard) session.pending.clear()
        session.saveUncertain = false
        return accepted(
          { workspaceId, requestId },
          { revision: seq(session.revision), text: session.text },
        )
      })
    }

    return {
      get path() {
        return session.path
      },
      get resource() {
        return resourceOf(session)
      },
      get state() {
        return stateOf(session)
      },
      edit,
      save: ({ requestId }) => {
        if (released) return Promise.resolve(gone(requestId))
        return serial(session, async () => {
          const revision = session.revision
          const done = await run(requestId, 'documents.save', true, (headers) =>
            docs().save(
              { ...headers, body: { resource_id: session.path, revision } },
              once,
            ),
          )
          if (done.outcome === 'accepted') {
            session.savedRevision = Math.max(
              session.savedRevision ?? 0,
              revision,
            )
            session.saveUncertain = false
            emit(session, {
              kind: 'saved',
              resource: resourceOf(session),
              revision: seq(revision),
            })
            return accepted(
              { workspaceId, requestId },
              { revision: seq(revision) },
            )
          }
          if (done.outcome === 'uncertain') session.saveUncertain = true
          return done
        })
      },
      reconcile: ({ requestId, keep }) => resolveWith(requestId, keep, false),
      revert: ({ requestId }) => resolveWith(requestId, 'disk', true),
      settle: (operationId) => void session.pending.delete(operationId),
      on(listener) {
        own.add(listener)
        session.listeners.add(listener)
        return () => {
          own.delete(listener)
          session.listeners.delete(listener)
        }
      },
      async close({ requestId }) {
        const answers: Answers = { workspaceId, requestId }
        if (released) return accepted(answers, { path: session.path })
        released = true
        for (const listener of own) session.listeners.delete(listener)
        own.clear()
        session.holders -= 1
        if (session.holders > 0)
          return accepted(answers, { path: session.path })
        const path = session.path
        sessions.delete(path)
        session.lease.release()
        const shut = run(requestId, 'documents.close', true, (headers) =>
          docs().close({ ...headers, body: { resource_id: path } }, once),
        ).then((done) =>
          done.outcome === 'accepted' ? accepted(answers, { path }) : done,
        )
        closing.set(path, shut)
        void shut.finally(() => {
          if (closing.get(path) === shut) closing.delete(path)
        })
        return shut
      },
    }
  }

  return {
    async open({ requestId, path }) {
      const answers: Answers = { workspaceId, requestId }
      const target = cleanPath(path)
      if (escapes(target)) {
        return refused(
          answers,
          'outside_workspace',
          `${path} is outside the workspace`,
        )
      }
      let session = sessions.get(target)
      if (!session) {
        let attempt = opening.get(target)
        if (!attempt) {
          attempt = openSession(requestId, target).finally(() =>
            opening.delete(target),
          )
          opening.set(target, attempt)
        }
        const got = await attempt
        if (got.outcome !== 'accepted') return { ...got, ...answers }
        session = got.value
      }
      session.holders += 1
      return accepted(answers, handleFor(session))
    },
    dispose() {
      unsubscribe()
      for (const session of sessions.values()) {
        session.lease.release()
        session.listeners.clear()
      }
      sessions.clear()
    },
  }
}
