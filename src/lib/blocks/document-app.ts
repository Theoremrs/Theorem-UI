// SOURCING: loro-crdt through StateReplica (state collections) and the existing sandbox bridge; no library models an App document's bridge host
// Adapt the existing sandbox bridge to one revisioned Documents SDK owner.
import { useEffect, useState } from 'react'
import type { AppDocument, AppSnapshot } from '../theorem/apps'
import { describeError } from '../theorem/client'
import { appArtifacts } from '../theorem/app-artifacts'
import { appCompute } from '../theorem/app-compute'
import { traceRecording } from '../theorem/app-traces'
import { contentDigest } from '../theorem/note-canonical'
import { BridgeDenied } from './bridge'
import type { AppDatabases, BridgeHost, StateCollections } from './bridge'
import { StateReplica } from './state'

/** An App's declared state collection lives in its document under this key. */
const stateKey = (name: string) => `app-state:${name}`

function collections(
  replica: StateReplica,
  saved: () => Promise<void>,
): StateCollections {
  return {
    snapshot: (name) => replica.snapshot(stateKey(name)),
    set: async (name, id, value) => {
      replica.set(stateKey(name), id, value)
      await saved()
    },
    delete: async (name, id) => {
      replica.delete(stateKey(name), id)
      await saved()
    },
    subscribe: (name, listener) => replica.subscribe(stateKey(name), listener),
  }
}

export function documentAppState(app: AppDocument) {
  const replica = new StateReplica({
    load: async () => (await app.load()).canonical,
    push: (update) => app.pushState(update),
    subscribe: (onUpdate) =>
      app.subscribe(() => {
        const snapshot = app.getSnapshot()
        if (snapshot) onUpdate(snapshot.canonical)
      }),
  })
  return {
    state: collections(replica, () => app.flush()),
    ready: replica.ready,
    dispose: () => replica.dispose(),
  }
}

/**
 * An App document's state as a view holds it while mounted: the replica,
 * once it has read the document, or why it could not. Every view of one
 * document reads and saves the same collections through its one owner.
 */
export function useDocumentReplica(app: AppDocument | undefined): {
  state?: ReturnType<typeof documentAppState>
  error?: string
} {
  const [held, setHeld] = useState<{
    app: AppDocument
    state?: ReturnType<typeof documentAppState>
    error?: string
  }>()
  useEffect(() => {
    if (!app) return
    let active = true
    const replica = documentAppState(app)
    void replica.ready.then(
      () => {
        if (active) setHeld({ app, state: replica })
      },
      (failure: unknown) => {
        if (active) setHeld({ app, error: describeError(failure, 'document') })
      },
    )
    return () => {
      active = false
      replica.dispose()
    }
  }, [app])
  // A replica read for another document is not this one's.
  return held && held.app === app ? held : {}
}

/**
 * State for a pinned revision shown outside its live document: it starts from
 * `seed` (the saved document, when the revision is still current) and keeps
 * changes in this frame only. Nothing reaches the App's document.
 */
export function pinnedAppState(seed: Uint8Array | null) {
  const replica = new StateReplica({
    load: async () => seed,
    push: async () => {},
    subscribe: () => () => {},
  })
  return {
    state: collections(replica, async () => {}),
    ready: replica.ready,
    dispose: () => replica.dispose(),
  }
}

/**
 * The host for a pinned revision: its own source, no writes, no agent runs.
 * `db`, when given, is the App's databases opened for reading only.
 */
export function pinnedAppHost(
  html: string,
  documentId: string,
  state: StateCollections,
  db?: AppDatabases,
): BridgeHost {
  const source = new TextEncoder().encode(html)
  return {
    state,
    db,
    recording: traceRecording,
    compute: appCompute(),
    client: {
      async read(path) {
        if (path !== 'index.html')
          throw new BridgeDenied('This App contains only index.html.')
        return { bytes: source, hash: await contentDigest(source) }
      },
      async tree() {
        return [
          {
            id: documentId,
            path: 'index.html',
            kind: 'file' as const,
            size: source.length,
            mtimeMs: 0,
          },
        ]
      },
      async write() {
        throw new BridgeDenied(
          'This is a saved revision of the App. Open the App to change its source.',
        )
      },
    },
    run: async () => {
      throw new BridgeDenied(
        'Agent blocks are not available inside a conversation App. Ask in the conversation to start work.',
      )
    },
  }
}

export function documentAppHost(
  app: AppDocument,
  snapshot: AppSnapshot,
  state: StateCollections,
  db?: AppDatabases,
): BridgeHost {
  const source = new TextEncoder().encode(snapshot.html)
  const artifacts = appArtifacts(snapshot)
  const onlySource = (path: string) => {
    if (path !== 'index.html')
      throw new Error(
        'This App contains only index.html; use declared state collections for saved data.',
      )
  }
  return {
    state,
    db,
    recording: traceRecording,
    compute: appCompute(),
    artifacts,
    client: {
      async read(path) {
        onlySource(path)
        return { bytes: source, hash: await contentDigest(source) }
      },
      async tree() {
        return [
          {
            id: app.documentId,
            path: 'index.html',
            kind: 'file' as const,
            size: source.length,
            mtimeMs: 0,
          },
        ]
      },
      async write(path, data) {
        onlySource(path)
        const html =
          typeof data === 'string' ? data : new TextDecoder().decode(data)
        const current = app.getSnapshot()
        await app.saveSource(
          html,
          current?.html === snapshot.html
            ? current.revision
            : snapshot.revision,
        )
        return { hash: await contentDigest(new TextEncoder().encode(html)) }
      },
    },
    run: async () => {
      throw new Error(
        'Agent blocks are not available inside a conversation App. Ask in the conversation to start work.',
      )
    },
  }
}
