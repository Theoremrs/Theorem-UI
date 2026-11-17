import { afterEach, expect, spyOn, test } from 'bun:test'
import { act, useState } from 'react'
import {
  AssistantRuntimeProvider,
  MessagePrimitive,
  ThreadPrimitive,
  useExternalStoreRuntime,
} from '@assistant-ui/react'
import type { ThreadMessageLike } from '@assistant-ui/react'
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import * as esbuild from 'esbuild-wasm'
import { TheoremPartRenderers } from '@/components/chat/theorem-parts'
import * as hosted from '@/lib/blocks/hosted-app'
import * as apps from '@/lib/theorem/apps'
import { appDocumentFixture } from '../../../test/blocks/app-documents'
import {
  buttonNamed,
  cleanup,
  click,
  render,
  waitFor,
} from '../../../test/blocks/render'
import { useArtifactView } from './artifact-view'

afterEach(async () => {
  await cleanup()
  useArtifactView.getState().reset()
})

const ORIGINAL = '<!doctype html><p>Original explanation</p>'
const REVISED = '<!doctype html><p>Revised explanation</p>'

function revisionPart(revision: number, content: string) {
  return {
    type: 'data' as const,
    name: 'theorem-artifact',
    data: {
      partId: `app-part-${revision}`,
      artifactId: 'answer-app',
      artifactRevision: String(revision),
      artifactKind: 'app',
      rendererId: 'theorem-app',
      contractVersion: 'theorem-artifact-v1',
      lifecycle: 'ready',
      patchSequence: revision,
      fallbackText: 'Authored explanation',
      payload: {
        documentId: 'app-document',
        revision: { position: revision },
        title: 'Authored explanation',
        content,
        language: 'html',
      },
    },
  }
}

function Message() {
  return (
    <MessagePrimitive.Root>
      <MessagePrimitive.Parts />
    </MessagePrimitive.Root>
  )
}

function Conversation({ continuation }: { continuation: string }) {
  const messages: ThreadMessageLike[] = [
    {
      id: 'original-answer',
      role: 'assistant',
      status: { type: 'complete', reason: 'stop' },
      content: [revisionPart(1, ORIGINAL)],
    },
    {
      id: 'revised-answer',
      role: 'assistant',
      status: { type: 'complete', reason: 'stop' },
      content: [
        revisionPart(2, REVISED),
        { type: 'text', text: continuation },
      ],
    },
  ]
  const runtime = useExternalStoreRuntime({
    messages,
    convertMessage: (message: ThreadMessageLike) => message,
    isRunning: false,
    onNew: async () => {},
  })
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <TheoremPartRenderers />
      <ThreadPrimitive.Root>
        <ThreadPrimitive.Messages components={{ Message }} />
      </ThreadPrimitive.Root>
    </AssistantRuntimeProvider>
  )
}

test('an older answer opens the existing latest App without creating another mutable runtime', async () => {
  useArtifactView.getState().reset()
  const store = await appDocumentFixture()
  await store.remote(REVISED)
  const document = new apps.AppDocument('app-document', store.api, store.change)
  const originalOwner = apps.appDocumentFor
  const owner = spyOn(apps, 'appDocumentFor').mockImplementation((id) =>
    id === 'app-document' ? document : originalOwner(id),
  )
  // Use the same hosted page builder with Bun's esbuild entry, as the other
  // App component tests do; the renderer, bridge and document owner are real.
  const originalHosted = hosted.hostedAppDocument
  const compile = spyOn(hosted, 'hostedAppDocument').mockImplementation(
    (html, _esbuild, options) => originalHosted(html, esbuild, options),
  )
  let continueAnswer!: (text: string) => void
  function Page() {
    const [continuation, setContinuation] = useState('Here is the revision.')
    continueAnswer = setContinuation
    return <Conversation continuation={continuation} />
  }
  const router = createRouter({
    routeTree: createRootRoute({ component: Page }),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  try {
    await router.load()
    const { container } = await render(<RouterProvider router={router} />)
    const current = await waitFor(() =>
      container.querySelector<HTMLDialogElement>(
        '[data-slot="inline-artifact"][data-part-id="app-part-2"][data-current="true"]',
      ),
    )
    const previous = container.querySelector<HTMLDialogElement>(
      '[data-slot="inline-artifact"][data-part-id="app-part-1"]',
    )!
    const liveFrame = await waitFor(() => current.querySelector('iframe'), 10_000)
    const pinnedFrame = await waitFor(() => previous.querySelector('iframe'), 10_000)
    const liveControls = () =>
      [...container.querySelectorAll('button')].filter(
        (button) => button.textContent.trim() === 'Stop App',
      )

    expect(liveControls()).toHaveLength(1)
    expect(buttonNamed(current, 'Stop App')).toBeDefined()
    expect(buttonNamed(previous, 'Stop App')).toBeUndefined()
    expect(previous.querySelector('[data-slot="app-revision"]')).not.toBeNull()
    expect(previous.textContent).toContain('Changes you make here are not saved')
    expect(container.querySelectorAll('iframe')).toHaveLength(2)

    // A DOM-only test has no viewport layout; retain the real focus action
    // while recording the request to bring the current answer into view.
    const scroll = spyOn(current, 'scrollIntoView').mockImplementation(() => {})
    try {
      await click(buttonNamed(previous, 'Open latest')!)
      expect(scroll).toHaveBeenCalledWith({ block: 'center' })
      expect(globalThis.document.activeElement).toBe(current)
      expect(useArtifactView.getState().openId).toBeUndefined()
      expect(liveControls()).toHaveLength(1)
      expect(current.querySelector('iframe')).toBe(liveFrame)
      expect(previous.querySelector('iframe')).toBe(pinnedFrame)
      expect(container.querySelectorAll('iframe')).toHaveLength(2)

      // Updating the surrounding answer goes through the actual part
      // renderer and its key, without changing either App revision.
      await act(() => continueAnswer('Here is the revision, with more explanation.'))
      expect(current.isConnected).toBe(true)
      expect(current.querySelector('iframe')).toBe(liveFrame)
      expect(previous.querySelector('iframe')).toBe(pinnedFrame)
      expect(liveControls()).toHaveLength(1)
      expect(container.querySelectorAll('iframe')).toHaveLength(2)
    } finally {
      scroll.mockRestore()
    }
  } finally {
    await cleanup()
    compile.mockRestore()
    owner.mockRestore()
  }
}, 30_000)
