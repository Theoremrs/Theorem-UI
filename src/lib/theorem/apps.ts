// SOURCING: @theoremharness/sdk documents (Theorem Documents v2), loro-crdt (the canonical body), async-mutex (one save queue per App), zod through notebooks/forms (a saved notebook's form)
// Revision coordination over the existing Documents SDK and canonical Loro body.
import type { Theorem } from './client'
import { Mutex } from 'async-mutex'
import { LoroDoc } from 'loro-crdt/base64'
import { describeError, hasStatus, mutate, theorem } from './client'
import { fromBase64, toBase64 } from '../blocks/state'
import { parseNotebookForm } from '../notebooks/forms'
import type { MarimoNotebook, ObservableNotebook } from '../notebooks/forms'
import {
  contentDigest,
  encodeNote,
  isEditableNote,
  noteAttribute,
  noteMarkdown,
  reviseNote,
} from './note-canonical'

/**
 * The source block's attribute naming a saved artifact's form, as the server
 * writes it (conversation_apps.rs FORM_ATTR). A block without it is an HTML
 * App, so every App saved before other forms reads as it did.
 */
const FORM_ATTR = 'artifactForm'

/** An OpenUI program as it is saved: the program and the library it was written against. */
export type OpenUIPublication = {
  form: 'openui'
  title: string
  library: { id: string; version: string }
  program: string
}

/**
 * What a saved App revision holds, read as its form: an HTML App's page, or
 * another form's publication exactly as write_app took it.
 */
export type SavedPublication =
  | { form: 'html-app'; title: string; html: string }
  | ObservableNotebook
  | MarimoNotebook
  | OpenUIPublication

const isOpenUI = (value: unknown): value is OpenUIPublication => {
  const v = value as Partial<OpenUIPublication> | null
  return (
    v?.form === 'openui' &&
    typeof v.title === 'string' &&
    typeof v.program === 'string' &&
    typeof v.library?.id === 'string' &&
    typeof v.library.version === 'string'
  )
}

/**
 * A saved source read as the form its block names. Another form's source is
 * its publication as JSON (conversation_apps.rs canonical_source); one this
 * build cannot read says why instead of being shown as something it is not.
 */
export function readPublication(
  form: string,
  source: string,
  title: string,
): { publication: SavedPublication } | { unreadable: string } {
  if (form === 'html-app')
    return { publication: { form: 'html-app', title, html: source } }
  let value: unknown
  try {
    value = JSON.parse(source)
  } catch (error) {
    return {
      unreadable: `The saved ${form} source is not a publication: ${(error as Error).message}`,
    }
  }
  if (form === 'observable' || form === 'marimo') {
    const notebook = parseNotebookForm(value)
    return notebook?.form === form
      ? { publication: notebook }
      : {
          unreadable: `The saved source is not a ${form} notebook this version of Theorem reads.`,
        }
  }
  if (form === 'openui')
    return isOpenUI(value)
      ? { publication: value }
      : { unreadable: 'The saved source is not an OpenUI program.' }
  return { unreadable: `This version of Theorem does not read form ${form}.` }
}

/** The snapshot fields a source read as its form fills: one of them, and the other cleared. */
function sourceAs(form: string, source: string, title: string) {
  const read = readPublication(form, source, title)
  return 'publication' in read
    ? { publication: read.publication, unreadable: undefined }
    : { publication: undefined, unreadable: read.unreadable }
}

export interface AppDocuments {
  get: (
    request: Theorem.GetDocumentsRequest,
  ) => Promise<Theorem.DocumentSnapshot>
  snapshot: (
    request: Theorem.SnapshotDocumentsRequest,
  ) => Promise<Theorem.DocumentSnapshot>
  revise: (
    request: Theorem.ReviseDocumentRequest,
  ) => Promise<Theorem.DocumentCommitReceipt>
}

export type AppSnapshot = {
  documentId: string
  title: string
  /** The saved source text: an HTML App's page, another form's publication as JSON. */
  html: string
  /** The form the source is in, as its block names it. */
  form: SavedPublication['form'] | (string & {})
  /** The source read as its form, or undefined when this build cannot read it. */
  publication?: SavedPublication
  /** Why `publication` is undefined. */
  unreadable?: string
  /** The projection search and text readers see, kept as the writer of the source set it. */
  markdownProjection: string
  canonical: Uint8Array
  revision: Theorem.DocumentRevision
  saveError?: string
  pendingState?: boolean
}

export class AppDocument {
  constructor(
    readonly documentId: string,
    private readonly suppliedApi?: AppDocuments,
    private readonly change: typeof mutate = mutate,
  ) {}

  private get api(): AppDocuments {
    return this.suppliedApi ?? theorem().documents
  }

  private current: AppSnapshot | null = null
  private readonly listeners = new Set<() => void>()
  private readonly lock = new Mutex()
  private readonly pending: Uint8Array[] = []

  hasPendingState = (): boolean => this.pending.length > 0

  getSnapshot = (): AppSnapshot | null => this.current
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private publish(snapshot: AppSnapshot): AppSnapshot {
    this.current = { ...snapshot, pendingState: this.hasPendingState() }
    for (const listener of this.listeners) listener()
    return this.current
  }

  private async read(): Promise<AppSnapshot> {
    let snapshot = await this.api.get({
      documentId: this.documentId,
      schema: 'theorem-document/2',
    })
    if (snapshot.canonical.placement !== 'inline') {
      snapshot = await this.api.snapshot({
        documentId: this.documentId,
        schema: 'theorem-document/2',
        expectedPosition: Number(snapshot.summary.revision.position),
        expectedDigest: snapshot.summary.revision.contentDigest,
      })
    }
    if (
      snapshot.summary.documentKind !== 'theorem.app' ||
      snapshot.summary.readOnly
    )
      throw new Error('This document is not an editable App')
    if (snapshot.canonical.placement !== 'inline')
      throw new Error('The App source could not be loaded')
    const canonical = fromBase64(snapshot.canonical.bytesBase64)
    if (
      (await contentDigest(canonical)) !==
      snapshot.summary.revision.contentDigest
    )
      throw new Error('The App source does not match its saved revision')
    if (!isEditableNote(canonical))
      throw new Error('This App uses an unsupported document layout')
    const source = noteMarkdown(canonical)!
    const form = noteAttribute(canonical, FORM_ATTR) ?? 'html-app'
    return {
      documentId: this.documentId,
      title: snapshot.summary.title,
      canonical,
      html: source,
      form,
      ...sourceAs(form, source, snapshot.summary.title),
      markdownProjection: snapshot.markdownProjection,
      revision: snapshot.summary.revision,
    }
  }

  load(): Promise<AppSnapshot> {
    return this.lock.runExclusive(async () =>
      this.publish({
        ...(await this.read()),
        saveError: this.current?.saveError,
      }),
    )
  }

  private async write(base: AppSnapshot, canonical: Uint8Array): Promise<void> {
    const html = noteMarkdown(canonical)
    if (html === undefined) throw new Error('The App source layout changed')
    const body = {
      title: base.title,
      documentKind: 'theorem.app',
      // An HTML App's page is its projection. Another form's projection is
      // the one its writer made of the publication, and saving state keeps it.
      markdownProjection:
        base.form === 'html-app' ? html : base.markdownProjection,
      canonical: {
        placement: 'inline' as const,
        bytesBase64: toBase64(canonical),
        size: canonical.length,
        digest: await contentDigest(canonical),
      },
    }
    const receipt = await this.change((headers) =>
      this.api.revise({
        ...headers,
        'If-Match': String(base.revision.position),
        documentIdPath: this.documentId,
        documentId: this.documentId,
        schema: 'theorem-document/2',
        idempotencyKey: headers['Idempotency-Key'],
        expectedRevision: base.revision,
        body,
      }),
    )
    this.publish({
      ...base,
      html,
      ...sourceAs(base.form, html, base.title),
      markdownProjection: body.markdownProjection,
      canonical,
      revision: receipt.document.revision,
      saveError: undefined,
    })
  }

  private failed(error: unknown): never {
    if (this.current)
      this.publish({
        ...this.current,
        saveError: describeError(error, 'document'),
      })
    throw error
  }

  async saveSource(
    html: string,
    revision: Theorem.DocumentRevision,
  ): Promise<void> {
    return this.lock.runExclusive(async () => {
      try {
        const base = await this.read()
        if (base.form !== 'html-app')
          throw new Error(
            `This App is saved as ${base.form}; its source is revised as that form, not as a page.`,
          )
        if (
          String(base.revision.position) !== String(revision.position) ||
          base.revision.contentDigest !== revision.contentDigest
        )
          throw new Error(
            'This App changed since you started editing. Reload its current source before saving.',
          )
        await this.write(base, reviseNote(base.canonical, html))
      } catch (error) {
        this.failed(error)
      }
    })
  }

  async pushState(update: Uint8Array): Promise<void> {
    this.pending.push(update.slice())
    if (this.current) this.publish(this.current)
    await this.flush()
  }

  flush(): Promise<void> {
    return this.lock.runExclusive(async () => {
      if (!this.pending.length) return
      const batch = this.pending.slice()
      for (let attempt = 0; ; attempt++) {
        try {
          const base = await this.read()
          const doc = LoroDoc.fromSnapshot(base.canonical)
          for (const update of batch) doc.import(update)
          await this.write(base, doc.export({ mode: 'snapshot' }))
          this.pending.splice(0, batch.length)
          this.publish(this.current!)
          return
        } catch (error) {
          if (hasStatus(error, 409, 412) && attempt < 2) continue
          this.failed(error)
        }
      }
    })
  }
}

// Every view and source action shares the same save queue and revision owner.
const documents = new Map<string, AppDocument>()
let owner: { api?: AppDocuments; change?: typeof mutate } = {}

/**
 * Where this page's Apps are read and saved, when not through the page's own
 * session: the App host a native app embeds (routes/app-host.tsx) reaches
 * Theorem through that app's sign-in. Set once, before any App is opened.
 */
export function ownAppDocumentsThrough(api: AppDocuments, change: typeof mutate) {
  owner = { api, change }
}

export function appDocumentFor(id: string): AppDocument {
  let app = documents.get(id)
  if (!app) {
    app = new AppDocument(id, owner.api, owner.change)
    documents.set(id, app)
  }
  return app
}

/**
 * Writes a new App document holding `html`, laid out as every App is: one
 * Markdown paragraph of source in the canonical body. It opens wherever an
 * App opens, and the agent reads and revises it like any other.
 */
export async function createAppDocument(
  title: string,
  html: string,
): Promise<{ documentId: string; revision: Theorem.DocumentRevision }> {
  const canonical = encodeNote(html)
  const digest = await contentDigest(canonical)
  const { document } = await mutate((headers) =>
    theorem().documents.create({
      ...headers,
      schema: 'theorem-document/2',
      idempotencyKey: headers['Idempotency-Key'],
      body: {
        title,
        documentKind: 'theorem.app',
        markdownProjection: html,
        canonical: {
          placement: 'inline',
          bytesBase64: toBase64(canonical),
          size: canonical.length,
          digest,
        },
      },
    }),
  )
  return { documentId: document.documentId, revision: document.revision }
}
