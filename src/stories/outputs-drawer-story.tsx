// SOURCING: assistant-ui's external store runtime (a conversation holding an App, a document and some code), a TanStack memory router so the drawer reads the open chat's route, the real OutputsDrawer opened through the shell state.
import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
} from '@assistant-ui/react'
import type { ThreadMessageLike } from '@assistant-ui/react'
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { ARTIFACT_PART } from '@/components/artifacts/artifact-model'
import { OutputsDrawer } from '@/components/shell/outputs-drawer'
import { useShell } from '@/components/shell/shell-state'

const APP = `<!doctype html><html><body style="margin:0;font:16px system-ui;background:#f6f1e8">
<header style="padding:24px 28px;background:#1f3a5f;color:white"><h1 style="margin:0;font-size:28px">Gallery</h1><p style="margin:6px 0 0;opacity:.8">Twelve apps, three pinned</p></header>
<main style="display:grid;grid-template-columns:repeat(3,1fr);gap:16px;padding:24px 28px">
${['#e07a5f', '#3d405b', '#81b29a', '#f2cc8f', '#6d597a', '#457b9d']
  .map(
    (c, i) =>
      `<div style="border-radius:12px;background:white;box-shadow:0 1px 3px #0002;overflow:hidden"><div style="height:90px;background:${c}"></div><p style="margin:10px 12px">App ${i + 1}</p></div>`,
  )
  .join('')}
</main></body></html>`

const DOCUMENT = `# Gallery direction

Two directions are open. The **grid** keeps every app the same size, so the
gallery reads as a catalogue. The **shelf** lets a pinned app grow, so the
apps a person uses most stand out.

## What decides it

- How many apps a person keeps
- Whether pins are per project
- What the poster costs to render`

const CODE = `export function galleryLayout(apps: App[], pinned: Set<string>) {
  const shelf = apps.filter((app) => pinned.has(app.id))
  const rest = apps.filter((app) => !pinned.has(app.id))
  return { shelf, grid: chunk(rest, 3) }
}`

function part(
  id: string,
  kind: string,
  title: string,
  content: string,
  language: string,
  revisions = 1,
): ThreadMessageLike {
  return {
    id: `message-${id}`,
    role: 'assistant',
    status: { type: 'complete', reason: 'stop' },
    content: Array.from({ length: revisions }, (_, index) => ({
      type: 'data' as const,
      name: ARTIFACT_PART,
      data: {
        artifactId: `art_${id}`,
        artifactRevision: `rev_${index + 1}`,
        artifactKind: kind,
        rendererId: `theorem-${kind}`,
        contractVersion: 'theorem-artifact-v1',
        lifecycle: 'ready',
        patchSequence: index + 1,
        fallbackText: title,
        payload: { title, content, language },
      },
    })),
  }
}

const MESSAGES = [
  part('gallery', 'app', 'Gallery prototype', APP, 'html', 3),
  part('direction', 'document', 'Gallery direction', DOCUMENT, 'markdown'),
  part('layout', 'code', 'galleryLayout', CODE, 'typescript', 2),
]

function Chat() {
  const runtime = useExternalStoreRuntime({
    messages: MESSAGES,
    isRunning: false,
    onNew: async () => {},
    convertMessage: (message: ThreadMessageLike) => message,
  })
  useEffect(() => {
    useShell.getState().setSideDrawer('outputs')
    return () => useShell.getState().setSideDrawer(undefined)
  }, [])
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <div className="h-dvh bg-sheet" />
      <OutputsDrawer />
    </AssistantRuntimeProvider>
  )
}

/** A chat's apps and outputs in the right-hand drawer, as thumbnails. */
export function OutputsDrawerStory() {
  const [router] = useState(() => {
    const root = createRootRoute({ component: Outlet })
    return createRouter({
      routeTree: root.addChildren([
        createRoute({
          getParentRoute: () => root,
          path: 'c/$threadId',
          component: Chat,
        }),
      ]),
      history: createMemoryHistory({ initialEntries: ['/c/thread-gallery'] }),
    })
  })
  return <RouterProvider router={router} />
}
