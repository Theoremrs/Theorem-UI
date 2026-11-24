import { afterEach, expect, spyOn, test } from 'bun:test'
import * as esbuild from 'esbuild-wasm'
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
import { useShell } from '@/components/shell/shell-state'
import { TheoremPartRenderers } from '@/components/chat/theorem-parts'
import * as hosted from '@/lib/blocks/hosted-app'
import { BLOCK_SANDBOX } from '@/lib/blocks/executor'
import { appDocumentFixture } from '../../../test/blocks/app-documents'
import {
  buttonNamed,
  cleanup,
  click,
  render,
  waitFor,
} from '../../../test/blocks/render'
import { useArtifactView } from './artifact-view'

const originalHosted = hosted.hostedAppDocument
function Message() {
  return <MessagePrimitive.Parts />
}
function Harness({
  kind = 'app',
  documentId = 'inline-app-test',
  running = false,
  content = '# Document',
}: {
  kind?: string
  documentId?: string
  running?: boolean
  content?: string
}) {
  const messages: ThreadMessageLike[] = [
    {
      id: 'result',
      role: 'assistant',
      status: running
        ? { type: 'running' }
        : { type: 'complete', reason: 'stop' },
      content: [
        {
          type: 'data',
          name: 'theorem-artifact',
          data: {
            artifactId: 'inline-result',
            artifactRevision: '1',
            artifactKind: kind,
            rendererId: `theorem-${kind}`,
            lifecycle: 'ready',
            patchSequence: 1,
            payload: {
              title: 'Browser shortlist',
              documentId,
              revision: { position: 1 },
              content,
            },
          },
        },
      ],
    },
  ]
  const runtime = useExternalStoreRuntime({
    messages,
    isRunning: running,
    onNew: async () => {},
    convertMessage: (item: ThreadMessageLike) => item,
  })
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <TheoremPartRenderers />
      <ThreadPrimitive.Messages components={{ Message }} />
    </AssistantRuntimeProvider>
  )
}

/** The reply inside a router, as the app draws it: a document's card asks the route which project's Gallery it opens in. */
async function renderRouted(props: Parameters<typeof Harness>[0]) {
  const router = createRouter({
    routeTree: createRootRoute({ component: () => <Harness {...props} /> }),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  await router.load()
  return render(<RouterProvider router={router} />)
}

afterEach(async () => {
  await cleanup()
  useArtifactView.getState().reset()
  useShell.setState({
    projectId: undefined,
    sideDrawer: undefined,
    galleryArtifact: undefined,
  })
})

test('a live App runs once inside its answer and never opens a workspace of its own', async () => {
  const originalUrl = window.location.href
  window.location.href = 'https://theorem.test/'
  const store = await appDocumentFixture()
  const fetch = spyOn(window, 'fetch').mockImplementation(
    Object.assign(async () => Response.json(store.saved()), {
      preconnect: window.fetch.preconnect,
    }),
  )
  const compile = spyOn(hosted, 'hostedAppDocument').mockImplementation(
    (html) => originalHosted(html, esbuild),
  )
  try {
    const { container } = await render(<Harness />)
    // The answer holds the live runtime directly: no card, no activation
    // step, and nothing opens in the dock beside it.
    const answer = await waitFor(() =>
      container.querySelector<HTMLElement>(
        '[data-slot="inline-artifact"][data-current="true"]',
      ),
    )
    const frame = await waitFor(() => answer.querySelector('iframe'), 10_000)
    expect(frame.getAttribute('sandbox')).toBe(BLOCK_SANDBOX)
    expect(buttonNamed(answer, 'Stop App')).toBeDefined()
    expect(container.querySelectorAll('iframe')).toHaveLength(1)
    expect(useArtifactView.getState().openId).toBeUndefined()
    await click(buttonNamed(answer, 'Stop App')!)
    expect(answer.querySelector('iframe')).toBeNull()
  } finally {
    compile.mockRestore()
    fetch.mockRestore()
    window.location.href = originalUrl
  }
}, 20_000)

test('in a project, a document card opens the Gallery on its document', async () => {
  useShell.setState({ projectId: 'project-1' })
  const { container } = await renderRouted({ kind: 'document' })
  await click(
    await waitFor(() =>
      container.querySelector('[aria-label="Open Browser shortlist"]'),
    ),
  )
  expect(useShell.getState().sideDrawer).toBe('outputs')
  expect(useShell.getState().galleryArtifact).toBe('inline-result')
  expect(useArtifactView.getState().openId).toBeUndefined()
})

test('outside any project, a document card opens the document panel', async () => {
  const { container } = await renderRouted({ kind: 'document' })
  await click(
    await waitFor(() =>
      container.querySelector('[aria-label="Open Browser shortlist"]'),
    ),
  )
  expect(useArtifactView.getState().openId).toBe('inline-result')
  expect(useShell.getState().sideDrawer).toBeUndefined()
  expect(container.querySelector('iframe')).toBeNull()
})

for (const kind of ['app', 'document']) {
  test(`a newly arriving ${kind} preserves the intended follow behavior`, async () => {
    const originalUrl = window.location.href
    window.location.href = 'https://theorem.test/'
    // A live App reads its document on arrival; answer the read the same way
    // offline it would fail, so no frame can start during a working turn.
    const fetch = spyOn(window, 'fetch').mockImplementation(
      Object.assign(
        async () => Response.json({ detail: 'offline' }, { status: 503 }),
        { preconnect: window.fetch.preconnect },
      ),
    )
    try {
      const { container } = await renderRouted({ kind, running: true })
      // A live artifact belongs to the working answer itself; a card stands
      // for everything else. Follow the Agent opens the card's panel, never
      // a live session.
      await waitFor(() =>
        kind === 'app'
          ? container.querySelector('[data-slot="inline-artifact"]')
          : container.querySelector('[aria-label="Open Browser shortlist"]'),
      )
      expect(useArtifactView.getState().openId).toBe(
        kind === 'app' ? undefined : 'inline-result',
      )
      // While the turn writes it, the card says how far it has got.
      if (kind === 'document')
        expect(
          container.querySelector('[data-slot="artifact-card"]')?.textContent,
        ).toBe('Browser shortlistWriting·1 words')
      expect(container.querySelector('iframe')).toBeNull()
    } finally {
      fetch.mockRestore()
      window.location.href = originalUrl
    }
  })
}

test('an App without a saved document reports the missing reference in its answer', async () => {
  const { container } = await render(<Harness documentId="" />)
  const alert = await waitFor(() => container.querySelector('[role="alert"]'))
  expect(alert.textContent).toContain("This App couldn't be opened.")
  expect(container.querySelector('iframe')).toBeNull()
  expect(useArtifactView.getState().openId).toBeUndefined()
})

test('a failed App load shows the actual failure in the answer and never starts a frame', async () => {
  const originalUrl = window.location.href
  window.location.href = 'https://theorem.test/'
  const fetch = spyOn(window, 'fetch').mockImplementation(
    Object.assign(
      async () =>
        Response.json({ detail: 'App source unavailable' }, { status: 503 }),
      { preconnect: window.fetch.preconnect },
    ),
  )
  try {
    const { container } = await render(
      <Harness documentId="inline-app-unavailable" />,
    )
    await waitFor(() => container.querySelector('[role="alert"]'))
    expect(container.textContent).toContain('App source unavailable')
    expect(container.querySelector('iframe')).toBeNull()
    expect(useArtifactView.getState().openId).toBeUndefined()
  } finally {
    fetch.mockRestore()
    window.location.href = originalUrl
  }
})

test('replacing the App in the answer with another saved App replaces the live runtime rather than reusing it', async () => {
  const originalUrl = window.location.href
  window.location.href = 'https://theorem.test/'
  const store = await appDocumentFixture()
  const fetch = spyOn(window, 'fetch').mockImplementation(
    Object.assign(async () => Response.json(store.saved()), {
      preconnect: window.fetch.preconnect,
    }),
  )
  const compile = spyOn(hosted, 'hostedAppDocument').mockImplementation(
    (html) => originalHosted(html, esbuild),
  )
  try {
    const { container, rerender } = await render(
      <Harness documentId="inline-app-original" />,
    )
    const first = await waitFor(() => container.querySelector('iframe'), 10_000)
    await rerender(<Harness documentId="inline-app-replacement" />)
    // The new saved App starts its own runtime; the previous document's
    // frame is gone, not carried over to another identity.
    const second = await waitFor(() => {
      const frame = container.querySelector('iframe')
      return frame && frame !== first ? frame : undefined
    }, 10_000)
    expect(container.querySelectorAll('iframe')).toHaveLength(1)
    expect(second).not.toBe(first)
    expect(useArtifactView.getState().openId).toBeUndefined()
  } finally {
    compile.mockRestore()
    fetch.mockRestore()
    window.location.href = originalUrl
  }
}, 20_000)

test('a document is a card in the reply: its title and kind, no excerpt and no live session', async () => {
  const { container } = await renderRouted({ kind: 'document' })
  const card = await waitFor(() =>
    container.querySelector('[data-slot="artifact-card"]'),
  )
  expect(card.textContent).toBe('Browser shortlistDocument')
  expect(container.querySelector('h1')).toBeNull()
  expect(
    container.querySelector('[data-slot="theorem-artifact-card"]'),
  ).toBeNull()
  expect(buttonNamed(container, 'Interact')).toBeUndefined()
})

test('a graph is drawn bare in the reply: its nodes, with no card, title or ground', async () => {
  const content = JSON.stringify({
    nodes: [
      { id: 'harbor' },
      { id: 'headland', dependsOn: ['harbor'] },
      { id: 'lighthouse', dependsOn: ['headland'] },
    ],
  })
  const { container } = await render(<Harness kind="graph" content={content} />)
  const graph = await waitFor(() =>
    container.querySelector('[data-slot="flow-graph"]'),
  )
  expect(graph.textContent).toBe('harborheadlandlighthouse')
  expect(graph.className).toContain('border-0')
  expect(graph.className).toContain('bg-transparent')
  expect(container.textContent).not.toContain('Browser shortlist')
  expect(
    container.querySelector('[data-slot="theorem-artifact-card"]'),
  ).toBeNull()
})

test('a kind this build has no renderer for shows the Theorem card, not a guess', async () => {
  const { container } = await render(<Harness kind="notebook" />)
  await click(
    await waitFor(() =>
      container.querySelector('[aria-label="Open Browser shortlist"]'),
    ),
  )
  expect(buttonNamed(container, 'Interact')).toBeUndefined()
  expect(container.querySelector('[data-slot="app-preview"]')).toBeNull()
})
