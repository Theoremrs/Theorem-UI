import { TheoremError } from '@theoremharness/sdk'
import { LoroDoc } from 'loro-crdt/base64'
import { fromBase64, toBase64 } from '../../src/lib/blocks/state'
import type { FakeRoutes } from '../../src/stories/fake-theorem'
import type { AppDocuments } from '../../src/lib/theorem/apps'
import type { Theorem, mutate } from '../../src/lib/theorem/client'
import {
  contentDigest,
  encodeNote,
  reviseNote,
} from '../../src/lib/theorem/note-canonical'

/**
 * A saved artifact's body as the server writes one (conversation_apps.rs):
 * one paragraph whose attributes name its form, holding the publication.
 */
export function savedArtifactBody(
  publication: { form: string } & Record<string, unknown>,
): Uint8Array {
  const doc = new LoroDoc()
  const block = doc.getTree('blocks').createNode().createNode()
  doc.getMap(`attrs:${block.id}`).set('kind', 'paragraph')
  doc.getMap(`attrs:${block.id}`).set('artifactForm', publication.form)
  doc.getText(`text:${block.id}`).insert(0, JSON.stringify(publication))
  doc.commit()
  return doc.export({ mode: 'snapshot' })
}

/**
 * One App document behind the Documents API. It holds an HTML App unless
 * `canonical` gives another body, such as a notebook laid out as the server
 * writes one.
 */
export async function appDocumentFixture(
  held: {
    documentId?: string
    position?: number
    canonical?: Uint8Array
    markdownProjection?: string
  } = {},
) {
  const canonical = held.canonical ?? encodeNote('<p>Original</p>')
  const digest = await contentDigest(canonical)
  let saved: Theorem.DocumentSnapshot = {
    schema: 'theorem-document/2',
    summary: {
      schema: 'theorem-document/2',
      documentId: held.documentId ?? 'app-document',
      documentKind: 'theorem.app',
      title: 'Comparison',
      revision: { position: held.position ?? 1, contentDigest: digest },
      readOnly: false,
      createdPosition: 1,
      updatedPosition: 1,
      actors: [],
      collectionIds: [],
      origin: {
        kind: 'user_authored',
        actorId: 'builder',
        originSurface: 'conversation',
      },
      projectionDigest: digest,
    },
    canonical: {
      placement: 'inline',
      bytesBase64: toBase64(canonical),
      size: canonical.length,
      digest,
    },
    markdownProjection: held.markdownProjection ?? '<p>Original</p>',
  }
  let fail = false
  const writes: Theorem.ReviseDocumentRequest[] = []
  const api: AppDocuments = {
    async get() {
      return structuredClone(saved)
    },
    async snapshot() {
      return structuredClone(saved)
    },
    async revise(request) {
      if (fail)
        throw new TheoremError({
          statusCode: 503,
          body: { detail: 'Document store unavailable' },
        })
      if (
        String(request.expectedRevision.position) !==
        String(saved.summary.revision.position)
      )
        throw new TheoremError({
          statusCode: 412,
          message: 'Revision conflict',
        })
      writes.push(request)
      const previousRevision = saved.summary.revision
      saved = {
        ...saved,
        canonical: request.body.canonical,
        markdownProjection: request.body.markdownProjection,
        summary: {
          ...saved.summary,
          documentKind: request.body.documentKind,
          revision: {
            position: Number(previousRevision.position) + 1,
            contentDigest: request.body.canonical.digest,
          },
        },
      }
      return {
        schema: 'theorem-document/2',
        idempotencyKey: request.idempotencyKey,
        document: saved.summary,
        previousRevision,
        memoryProjection: {
          memoryDocId: 'projection',
          derivationRef: 'document',
          contentAddress: 'content',
          projectionDigest: 'digest',
        },
      }
    },
  }
  const change: typeof mutate = async (run) =>
    run({ 'X-CSRF-Token': 'test-csrf', 'Idempotency-Key': crypto.randomUUID() })
  return {
    api,
    change,
    writes,
    saved: () => saved,
    fail: (value: boolean) => {
      fail = value
    },
    async remote(html: string) {
      if (saved.canonical.placement !== 'inline')
        throw new Error('fixture must be inline')
      const bytes = reviseNote(fromBase64(saved.canonical.bytesBase64), html)
      const digest = await contentDigest(bytes)
      saved = {
        ...saved,
        markdownProjection: html,
        canonical: {
          placement: 'inline',
          bytesBase64: toBase64(bytes),
          digest,
          size: bytes.length,
        },
        summary: {
          ...saved.summary,
          revision: {
            position: Number(saved.summary.revision.position) + 1,
            contentDigest: digest,
          },
        },
      }
    },
  }
}

type DocumentFixture = Awaited<ReturnType<typeof appDocumentFixture>>

/**
 * What a fake Theorem answers for `documents`: each one read and revised as
 * the Documents API does, by its id, and the session a revision bootstraps.
 */
export function documentRoutes(documents: ReadonlyArray<DocumentFixture>): FakeRoutes {
  const byId = (documentId = '') =>
    documents.find(
      (document) =>
        document.saved().summary.documentId === decodeURIComponent(documentId),
    )
  const missing = () =>
    new Response(JSON.stringify({ detail: 'No such document' }), { status: 404 })
  return {
    'GET /api/chat/v1/bootstrap': () => ({
      schema: 'theorem.chat.bootstrap.v1',
      tenantId: 'test',
      csrfToken: 'test-csrf',
      principalId: 'test',
      projects: { items: [] },
      uploadLimits: { maxCount: 10, maxTotalBytes: 1024 },
    }),
    'GET /api/documents/v2/documents/:documentId': ({ documentId }) =>
      byId(documentId)?.saved() ?? missing(),
    'PUT /api/documents/v2/documents/:documentId': async ({ documentId }, request) => {
      const document = byId(documentId)
      if (!document) return missing()
      try {
        return await document.api.revise(
          (await request.json()) as Theorem.ReviseDocumentRequest,
        )
      } catch (error) {
        const status = (error as { statusCode?: number }).statusCode ?? 500
        return new Response(JSON.stringify({ detail: String(error) }), { status })
      }
    },
  }
}
