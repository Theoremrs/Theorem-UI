// SOURCING: none: the saved document an artifact names, read through the one
// App document owner (theorem/apps.ts appDocumentFor) with React's
// useSyncExternalStore, and read again on focus and every 10 seconds while
// the page is visible, as DocumentApp reads an HTML App's head. No library
// models a Theorem artifact's current revision.
//
// Which revision a view shows is one rule for every form. The newest revision
// in a conversation is the document as saved now: a revision made anywhere
// else, and state saved since, are in it. An older revision is exactly what its
// message pinned. Notes and other surfaces that open a document with no message
// show its head.
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { describeError } from '@/lib/theorem/client'
import { appDocumentFor } from '@/lib/theorem/apps'
import type { AppDocument, AppSnapshot, SavedPublication } from '@/lib/theorem/apps'
import { contentDigest } from '@/lib/theorem/note-canonical'
import type { TheoremArtifact } from './artifact-model'

/** What a revision's publication sets on an artifact, as the server's part would carry it. */
type PublicationFields = Pick<
  TheoremArtifact,
  'title' | 'content' | 'notebook' | 'library' | 'form'
>

/**
 * The fields of the `artifact` part the server would make of `publication`
 * (conversation_apps.rs artifact_part_fields): a marimo notebook's retained
 * outputs are read by the hex SHA-256 of its source.
 */
async function fieldsOf(
  documentId: string,
  publication: SavedPublication,
): Promise<PublicationFields> {
  switch (publication.form) {
    case 'html-app':
      return { title: publication.title, content: publication.html }
    case 'openui':
      return {
        title: publication.title,
        content: publication.program,
        form: 'openui',
        library: publication.library,
      }
    case 'observable':
      return {
        title: publication.title,
        content: JSON.stringify(publication.cells, null, 2),
        form: 'observable',
        notebook: publication,
      }
    case 'marimo': {
      const revision = await contentDigest(
        new TextEncoder().encode(publication.source),
      )
      return {
        title: publication.title,
        content: publication.source,
        form: 'marimo',
        notebook: {
          ...publication,
          retainedOutputs: {
            sourceRevision: revision,
            href: `/api/artifacts/v1/documents/${encodeURIComponent(documentId)}/outputs?revision=${revision}`,
          },
        },
      }
    }
  }
}

/** How often a visible view reads its head again, as DocumentApp does. */
const REFRESH_MS = 10_000

/**
 * Reads `app`'s head now, again when the page regains focus, and every
 * REFRESH_MS while it is visible, so a revision made elsewhere reaches the
 * view. Answers why the last read failed, until one succeeds.
 */
function useHead(app: AppDocument | undefined): string | undefined {
  const [error, setError] = useState<string>()
  useEffect(() => {
    if (!app) return
    let active = true
    const read = () =>
      void app.load().then(
        () => active && setError(undefined),
        (failure: unknown) =>
          active && setError(describeError(failure, 'document')),
      )
    read()
    const refresh = () => {
      if (document.visibilityState === 'visible') read()
    }
    const timer = setInterval(refresh, REFRESH_MS)
    window.addEventListener('focus', refresh)
    return () => {
      active = false
      clearInterval(timer)
      window.removeEventListener('focus', refresh)
    }
  }, [app])
  return error
}

const noSnapshot = () => null
const noSubscription = () => () => {}

/** The App document a view of `artifact` reads and saves through, when it shows the head. */
export type SavedHead = {
  app: AppDocument
  snapshot: AppSnapshot
}

/**
 * The artifact a view shows. For the newest revision with a saved document it
 * is the document's head, once read (`pending` until then), and the message's
 * revision after a read fails, which `error` says. `head` is the document the
 * view saves state through, once read; an older revision has none and saves
 * nothing.
 *
 * The artifact is made again only when the saved source changes, so saving
 * state, which moves the revision, does not start a running view over.
 */
export function useSavedArtifact(
  artifact: TheoremArtifact,
  latest: boolean,
): {
  artifact: TheoremArtifact
  head?: SavedHead
  pending: boolean
  error?: string
} {
  const documentId = latest ? artifact.documentId : undefined
  const app = useMemo(
    () => (documentId ? appDocumentFor(documentId) : undefined),
    [documentId],
  )
  const snapshot = useSyncExternalStore(
    app?.subscribe ?? noSubscription,
    app?.getSnapshot ?? noSnapshot,
  )
  const error = useHead(app)
  const source = snapshot?.publication ? snapshot.html : undefined
  const [made, setMade] = useState<{ source: string; fields: PublicationFields }>()
  useEffect(() => {
    const publication = snapshot?.publication
    if (!snapshot || !publication || source === undefined) return
    let active = true
    void fieldsOf(snapshot.documentId, publication).then((fields) => {
      if (active) setMade({ source, fields })
    })
    return () => {
      active = false
    }
    // The fields follow the saved source; a state save keeps the same source.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source])
  const position = snapshot?.revision.position
  const shown = useMemo(
    () =>
      made && made.source === source && position !== undefined
        ? { ...artifact, ...made.fields, documentPosition: Number(position) }
        : artifact,
    [artifact, made, source, position],
  )
  const unreadable =
    snapshot?.unreadable &&
    `The saved ${snapshot.form} could not be read: ${snapshot.unreadable}`
  return {
    artifact: shown,
    head: app && snapshot ? { app, snapshot } : undefined,
    pending: Boolean(app) && !error && !unreadable && shown === artifact,
    error: error ?? (unreadable || undefined),
  }
}
