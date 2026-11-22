import { act } from 'react'
import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import * as esbuild from 'esbuild-wasm'
import { EditorView } from '@codemirror/view'
import {
  AssistantRuntimeProvider,
  MessagePrimitive,
  ThreadPrimitive,
  useExternalStoreRuntime,
} from '@assistant-ui/react'
import type { ThreadMessageLike } from '@assistant-ui/react'
import {
  Outlet,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { TheoremPartRenderers } from '@/components/chat/theorem-parts'
import { BLOCK_SANDBOX } from '@/lib/blocks/executor'
import * as hosted from '@/lib/blocks/hosted-app'
import { appDocumentFixture } from '../../../test/blocks/app-documents'
import {
  buttonNamed,
  cleanup,
  click,
  render,
  waitFor,
} from '../../../test/blocks/render'
import { ArtifactPanel, download } from './artifact-panel'
import { ArtifactActions } from './artifact-actions'
import { readArtifact } from './artifact-model'
import { useArtifactView } from './artifact-view'
import { useShell } from '@/components/shell/shell-state'

function Harness({
  messages,
  artifactId = 'app-draft-result',
}: {
  messages: ThreadMessageLike[]
  artifactId?: string
}) {
  const runtime = useExternalStoreRuntime({
    messages,
    isRunning: false,
    onNew: async () => {},
    convertMessage: (item: ThreadMessageLike) => item,
  })
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <div data-testid="dock">
        <ArtifactPanel artifactId={artifactId} onClose={() => {}} />
      </div>
    </AssistantRuntimeProvider>
  )
}

/** The conversation and its dock panel together, as the desktop shell has them. */
function Workspace({ messages }: { messages: ThreadMessageLike[] }) {
  const runtime = useExternalStoreRuntime({
    messages,
    isRunning: false,
    onNew: async () => {},
    convertMessage: (item: ThreadMessageLike) => item,
  })
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <TheoremPartRenderers />
      <ThreadPrimitive.Messages
        components={{ Message: () => <MessagePrimitive.Parts /> }}
      />
      <div data-testid="dock">
        <ArtifactPanel artifactId="app-draft-result" onClose={() => {}} />
      </div>
    </AssistantRuntimeProvider>
  )
}

/** The panel's own element, so a test can say what the dock does not hold. */
const dockOf = (root: ParentNode) =>
  root.querySelector<HTMLElement>('[data-testid="dock"]')!

/** Live DocumentApp instances: its toolbar is the only one that offers Stop. */
const liveRuntimeCount = (root: ParentNode) =>
  [...root.querySelectorAll('button')].filter(
    (button) => button.textContent.trim() === 'Stop App',
  ).length

function message(
  revision: number,
  content?: string,
  documentId = 'app-draft-document',
): ThreadMessageLike {
  return {
    id: `result-${revision}`,
    role: 'assistant',
    content: [
      {
        type: 'data',
        name: 'theorem-artifact',
        data: {
          artifactId: 'app-draft-result',
          artifactRevision: String(revision),
          artifactKind: 'app',
          rendererId: 'theorem-app',
          patchSequence: revision,
          lifecycle: 'ready',
          payload: {
            documentId,
            title: 'App',
            revision: { position: revision },
            ...(content && { content, language: 'html' }),
          },
        },
      },
    ],
  }
}

function documentMessage(revision: number): ThreadMessageLike {
  return {
    id: `document-${revision}`,
    role: 'assistant',
    content: [
      {
        type: 'data',
        name: 'theorem-artifact',
        data: {
          artifactId: 'doc-draft-result',
          artifactRevision: String(revision),
          artifactKind: 'document',
          rendererId: 'theorem-document',
          patchSequence: revision,
          lifecycle: 'ready',
          payload: {
            title: 'Field notes',
            content: '# Document',
            language: 'markdown',
          },
        },
      },
    ],
  }
}

function appArtifact() {
  const content = message(1).content
  if (typeof content === 'string' || content[0]?.type !== 'data')
    throw new Error('Expected artifact fixture')
  return readArtifact(content[0].data)!
}

// Opening an App in the workspace runs it; tests compile its page with the
// Node build of esbuild instead of the browser's wasm one.
const originalHosted = hosted.hostedAppDocument
let compile:
  ReturnType<typeof spyOn<typeof hosted, 'hostedAppDocument'>> | undefined
beforeEach(() => {
  compile = spyOn(hosted, 'hostedAppDocument').mockImplementation(
    (html, _esbuild, options) => originalHosted(html, esbuild, options),
  )
})

afterEach(async () => {
  await cleanup()
  compile?.mockRestore()
  useArtifactView.getState().reset()
})

test('a published revision refreshes the App in its answer, a stale editor save is refused, and the dock look back never discards the draft', async () => {
  const originalUrl = window.location.href
  window.location.href = 'https://theorem.test/'
  const store = await appDocumentFixture()
  const get = spyOn(window, 'fetch').mockImplementation(
    Object.assign(async () => Response.json(store.saved()), {
      preconnect: window.fetch.preconnect,
    }),
  )
  try {
    const { container, rerender } = await render(
      <Workspace messages={[message(1, undefined, 'draft-survivor-app')]} />,
    )
    // The one live runtime is the answer's; the panel holds a referrer.
    const answer = await waitFor(() =>
      container.querySelector<HTMLElement>(
        '[data-slot="inline-artifact"][data-current="true"]',
      ),
    )
    await waitFor(() => buttonNamed(answer, 'Edit source'))
    await click(buttonNamed(answer, 'Edit source')!)
    const content = await waitFor(() =>
      container.querySelector<HTMLElement>('.cm-content'),
    )
    const editor = EditorView.findFromDOM(content)!
    await act(() =>
      editor.dispatch({
        changes: {
          from: 0,
          to: editor.state.doc.length,
          insert: '<p>My unsaved draft</p>',
        },
      }),
    )
    expect(content.textContent).toContain('My unsaved draft')
    await store.remote('<p>Worker published source</p>')
    // The answer's runtime reloads the document; its editor's base revision
    // is now stale, and saving against it is refused without any write.
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
    })
    await waitFor(() => container.querySelector('[data-revision="2"]'))
    await click(buttonNamed(container, 'Save source')!)
    await waitFor(() => container.querySelector('[role="alert"]'))
    expect(container.textContent).toContain('changed since you started editing')
    expect(content.textContent).toContain('My unsaved draft')
    expect(store.writes).toHaveLength(0)
    await click(buttonNamed(container, 'Cancel edit')!)
    // The revision arrives in the conversation: the answer still holds
    // exactly one live runtime, refreshed to the published source.
    await rerender(
      <Workspace
        messages={[
          message(1, '<p>Original revision</p>', 'draft-survivor-app'),
          message(2, undefined, 'draft-survivor-app'),
        ]}
      />,
    )
    await waitFor(() => container.querySelector('[data-revision="2"]'))
    expect(liveRuntimeCount(container)).toBe(1)
    const current = await waitFor(() =>
      container.querySelector<HTMLElement>(
        '[data-slot="inline-artifact"][data-current="true"]',
      ),
    )
    await click(buttonNamed(current, 'Edit source')!)
    const reopened = await waitFor(() =>
      container.querySelector<HTMLElement>('.cm-content'),
    )
    expect(reopened.textContent).toContain('Worker published source')
    // Looking back through the dock never touches the answer's runtime: the
    // open editor and its draft are not the panel's to discard.
    await click(
      dockOf(container).querySelector('[aria-label="Previous version"]')!,
    )
    expect(dockOf(container).textContent).toContain('v1 of 2')
    expect(container.querySelector('.cm-content') === reopened).toBe(true)
    expect(reopened.textContent).toContain('Worker published source')
    await click(dockOf(container).querySelector('[aria-label="Next version"]')!)
    expect(dockOf(container).textContent).toContain('v2 of 2')
    expect(container.querySelector('.cm-content') === reopened).toBe(true)
    await click(buttonNamed(container, 'Cancel edit')!)
  } finally {
    get.mockRestore()
    window.location.href = originalUrl
  }
}, 30_000)

test('an older revision opens its pinned source, labeled, while the answer keeps the one live runtime', async () => {
  const originalUrl = window.location.href
  window.location.href = 'https://theorem.test/'
  const store = await appDocumentFixture()
  const get = spyOn(window, 'fetch').mockImplementation(
    Object.assign(async () => Response.json(store.saved()), {
      preconnect: window.fetch.preconnect,
    }),
  )
  try {
    const { container } = await render(
      <Workspace
        messages={[
          message(1, '<p>Original revision</p>', 'lookback-app'),
          message(2, undefined, 'lookback-app'),
        ]}
      />,
    )
    const dock = dockOf(container)
    const referrer = await waitFor(() =>
      dock.querySelector<HTMLElement>('[data-slot="artifact-referrer"]'),
    )
    await click(dock.querySelector('[aria-label="Previous version"]')!)
    const revision = await waitFor(() =>
      dock.querySelector<HTMLElement>('[data-slot="app-revision"]'),
    )
    expect(revision.textContent).toContain('Saved revision 1')
    expect(revision.textContent).toContain('not saved')
    const frame = await waitFor(() => revision.querySelector('iframe'), 10_000)
    expect(frame.getAttribute('sandbox')).toBe(BLOCK_SANDBOX)
    expect(compile?.mock.calls.map((call) => call[0])).toContain(
      '<p>Original revision</p>',
    )
    // The newest slot keeps its referrer, hidden behind the look back. The
    // dock itself holds no live runtime: the answer does, exactly one.
    expect(referrer.isConnected).toBe(true)
    expect(referrer.closest('div')?.hasAttribute('hidden')).toBe(true)
    expect(liveRuntimeCount(dock)).toBe(0)
    expect(liveRuntimeCount(container)).toBe(1)
    await click(buttonNamed(revision, 'Open latest')!)
    expect(dock.querySelector('[data-slot="app-revision"]')).toBeNull()
    expect(dock.textContent).toContain('v2 of 2')
    expect(referrer.closest('div')?.hasAttribute('hidden')).toBe(false)
  } finally {
    get.mockRestore()
    window.location.href = originalUrl
  }
}, 30_000)

test("an older revision's frame keeps the page's look as it changes", async () => {
  const originalUrl = window.location.href
  window.location.href = 'https://theorem.test/'
  const store = await appDocumentFixture()
  const get = spyOn(window, 'fetch').mockImplementation(
    Object.assign(async () => Response.json(store.saved()), {
      preconnect: window.fetch.preconnect,
    }),
  )
  const followed: Array<HTMLIFrameElement> = []
  const follow = spyOn(hosted, 'followTheme').mockImplementation(
    (connection) => {
      followed.push(
        (connection as unknown as { frame: HTMLIFrameElement }).frame,
      )
      return () => {}
    },
  )
  try {
    const { container } = await render(
      <Harness
        messages={[
          message(1, '<p>Original revision</p>', 'theme-app'),
          message(2, undefined, 'theme-app'),
        ]}
      />,
    )
    const dock = dockOf(container)
    await waitFor(() => dock.querySelector('[data-slot="artifact-referrer"]'))
    await click(dock.querySelector('[aria-label="Previous version"]')!)
    const revision = await waitFor(() =>
      dock.querySelector('[data-slot="app-revision"]'),
    )
    const frame = await waitFor(() => revision.querySelector('iframe'), 10_000)
    expect(followed).toContain(frame)
  } finally {
    follow.mockRestore()
    get.mockRestore()
    window.location.href = originalUrl
  }
}, 30_000)

test('App copy and shared download resolve canonical source rather than the empty artifact placeholder', async () => {
  const originalUrl = window.location.href
  window.location.href = 'https://theorem.test/'
  const store = await appDocumentFixture()
  await store.remote('<!doctype html><h1>Saved App source</h1>')
  const get = spyOn(window, 'fetch').mockImplementation(
    Object.assign(async () => Response.json(store.saved()), {
      preconnect: window.fetch.preconnect,
    }),
  )
  const copied: string[] = []
  const clipboard = spyOn(navigator.clipboard, 'writeText').mockImplementation(
    async (text) => {
      copied.push(text)
    },
  )
  const blobs: Blob[] = []
  const urls = spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
    blobs.push(blob as Blob)
    return 'blob:test-export'
  })
  const anchor = spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(
    () => {},
  )
  try {
    const { container } = await render(<Harness messages={[message(1)]} />)
    await waitFor(() =>
      dockOf(container).querySelector('[data-slot="artifact-referrer"]'),
    )
    await click(container.querySelector('[aria-label^="Copy"]')!)
    await waitFor(() => copied.length > 0, 500)
    expect(copied).toEqual(['<!doctype html><h1>Saved App source</h1>'])
    const artifact = appArtifact()
    await act(() => download(artifact))
    expect(await blobs[0]!.text()).toBe(copied[0]!)
    expect(blobs[0]!.type).toStartWith('text/html')
    expect(
      container.querySelector('[aria-label="Download App source"]'),
    ).not.toBeNull()
  } finally {
    anchor.mockRestore()
    urls.mockRestore()
    clipboard.mockRestore()
    get.mockRestore()
    window.location.href = originalUrl
  }
})

test('App download refuses failed canonical loading instead of saving an empty placeholder', async () => {
  const originalUrl = window.location.href
  window.location.href = 'https://theorem.test/'
  const get = spyOn(window, 'fetch').mockImplementation(
    Object.assign(
      async () =>
        Response.json(
          { detail: 'Document source unavailable' },
          { status: 503 },
        ),
      { preconnect: window.fetch.preconnect },
    ),
  )
  const urls = spyOn(URL, 'createObjectURL')
  const anchor = spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(
    () => {},
  )
  try {
    const artifact = appArtifact()
    await expect(download(artifact)).rejects.toThrow(
      'Document source unavailable',
    )
    expect(urls).not.toHaveBeenCalled()
  } finally {
    anchor.mockRestore()
    urls.mockRestore()
    get.mockRestore()
    window.location.href = originalUrl
  }
})

for (const status of [401, 403]) {
  test(`App actions refuse cached source after fresh authorization returns ${status}`, async () => {
    const originalUrl = window.location.href
    window.location.href = 'https://theorem.test/'
    const store = await appDocumentFixture()
    let denied = false
    const get = spyOn(window, 'fetch').mockImplementation(
      Object.assign(
        async () =>
          denied
            ? Response.json({ detail: 'App source access denied' }, { status })
            : Response.json(store.saved()),
        { preconnect: window.fetch.preconnect },
      ),
    )
    const copied: string[] = []
    const clipboard = spyOn(
      navigator.clipboard,
      'writeText',
    ).mockImplementation(async (text) => {
      copied.push(text)
    })
    const urls = spyOn(URL, 'createObjectURL')
    try {
      const { container } = await render(<Harness messages={[message(1)]} />)
      await waitFor(() =>
        dockOf(container).querySelector('[data-slot="artifact-referrer"]'),
      )
      await click(container.querySelector('[aria-label="Copy App source"]')!)
      await waitFor(() =>
        container.querySelector<HTMLButtonElement>('[aria-label="Copied"]'),
      )
      expect(copied).toEqual(['<p>Original</p>'])
      denied = true
      await click(
        container.querySelector<HTMLButtonElement>('[aria-label="Copied"]')!,
      )
      await waitFor(() => container.querySelector('[role="alert"]'))
      expect(container.textContent).toContain('App source access denied')
      expect(
        container.querySelector<HTMLButtonElement>('[aria-label="Copied"]'),
      ).toBeNull()
      expect(copied).toHaveLength(1)
      const artifact = appArtifact()
      await expect(download(artifact)).rejects.toThrow(
        'App source access denied',
      )
      expect(urls).not.toHaveBeenCalled()
    } finally {
      urls.mockRestore()
      clipboard.mockRestore()
      get.mockRestore()
      window.location.href = originalUrl
    }
  })
}

test('shared card download reports source failure and clipboard failure never reports Copied', async () => {
  const originalUrl = window.location.href
  window.location.href = 'https://theorem.test/'
  const store = await appDocumentFixture()
  let denied = false
  const get = spyOn(window, 'fetch').mockImplementation(
    Object.assign(
      async () =>
        denied
          ? Response.json(
              { detail: 'App source access denied' },
              { status: 403 },
            )
          : Response.json(store.saved()),
      { preconnect: window.fetch.preconnect },
    ),
  )
  const clipboard = spyOn(navigator.clipboard, 'writeText').mockRejectedValue(
    new Error('Clipboard permission denied'),
  )
  const artifact = appArtifact()
  try {
    const { container, rerender } = await render(
      <ArtifactActions artifact={artifact} copy />,
    )
    await click(
      container.querySelector<HTMLButtonElement>(
        '[aria-label="Copy App source"]',
      )!,
    )
    await waitFor(() => container.querySelector('[role="alert"]'))
    expect(container.textContent).toContain('Clipboard permission denied')
    expect(
      container.querySelector<HTMLButtonElement>('[aria-label="Copied"]'),
    ).toBeNull()
    denied = true
    await rerender(<ArtifactActions artifact={artifact} />)
    expect(container.querySelector('[aria-label="Copy App source"]')).toBeNull()
    await click(
      container.querySelector<HTMLButtonElement>(
        '[aria-label="Download App source"]',
      )!,
    )
    await waitFor(() =>
      container.textContent.includes('App source access denied'),
    )
    expect(container.querySelector('[role="alert"]')).not.toBeNull()
  } finally {
    clipboard.mockRestore()
    get.mockRestore()
    window.location.href = originalUrl
  }
})

test('source actions reject missing references and empty content while inline exports keep their formats', async () => {
  const artifact = appArtifact()
  const blobs: Blob[] = []
  const names: string[] = []
  const urls = spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
    blobs.push(blob as Blob)
    return 'blob:source-format'
  })
  const anchor = spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(
    function (this: HTMLAnchorElement) {
      names.push(this.download)
    },
  )
  try {
    await expect(
      download({ ...artifact, documentId: undefined }),
    ).rejects.toThrow('saved document reference')
    await expect(
      download({ ...artifact, kind: 'document', content: '' }),
    ).rejects.toThrow('no saved content')
    expect(blobs).toHaveLength(0)
    for (const [kind, content, type, name] of [
      ['document', '# Saved document', 'text/markdown', 'app.md'],
      ['code', 'const value = 1', 'text/plain', 'app.txt'],
    ]) {
      await download({
        ...artifact,
        kind: kind!,
        rendererId: kind!,
        content: content!,
      })
      const saved = blobs.at(-1)!
      expect(await saved.text()).toBe(content!)
      expect(saved.type).toStartWith(type!)
      expect(names.at(-1)).toBe(name)
    }
    const { container } = await render(
      <ArtifactActions
        artifact={{ ...artifact, kind: 'document', content: '# Inline' }}
        copy
      />,
    )
    expect(container.querySelector('[aria-label="Copy"]')).not.toBeNull()
    expect(container.querySelector('[aria-label="Download"]')).not.toBeNull()
  } finally {
    anchor.mockRestore()
    urls.mockRestore()
  }
})

test('source actions stay disabled until the fresh document read and clipboard write finish', async () => {
  const originalUrl = window.location.href
  window.location.href = 'https://theorem.test/'
  const store = await appDocumentFixture()
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const get = spyOn(window, 'fetch').mockImplementation(
    Object.assign(
      async () => {
        await gate
        return Response.json(store.saved())
      },
      { preconnect: window.fetch.preconnect },
    ),
  )
  const clipboard = spyOn(navigator.clipboard, 'writeText').mockResolvedValue(
    undefined,
  )
  try {
    const { container } = await render(
      <ArtifactActions artifact={appArtifact()} copy />,
    )
    const copy = container.querySelector<HTMLButtonElement>(
      '[aria-label="Copy App source"]',
    )!
    const downloadButton = container.querySelector<HTMLButtonElement>(
      '[aria-label="Download App source"]',
    )!
    expect(copy.disabled).toBe(false)
    expect(downloadButton.disabled).toBe(false)
    await click(copy)
    expect(copy.disabled).toBe(true)
    expect(downloadButton.disabled).toBe(true)
    expect(clipboard).not.toHaveBeenCalled()
    await act(async () => release())
    await waitFor(() => container.querySelector('[aria-label="Copied"]'))
    expect(copy.disabled).toBe(false)
    expect(downloadButton.disabled).toBe(false)
  } finally {
    release()
    clipboard.mockRestore()
    get.mockRestore()
    window.location.href = originalUrl
  }
})

function ThreadHarness({ messages }: { messages: ThreadMessageLike[] }) {
  const runtime = useExternalStoreRuntime({
    messages,
    isRunning: false,
    onNew: async () => {},
    convertMessage: (item: ThreadMessageLike) => item,
  })
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <TheoremPartRenderers />
      <ThreadPrimitive.Messages
        components={{ Message: () => <MessagePrimitive.Parts /> }}
      />
    </AssistantRuntimeProvider>
  )
}

test('an older revision in the conversation downloads the source its message pinned, not the current App', async () => {
  const originalUrl = window.location.href
  window.location.href = 'https://theorem.test/'
  const store = await appDocumentFixture()
  const get = spyOn(window, 'fetch').mockImplementation(
    Object.assign(async () => Response.json(store.saved()), {
      preconnect: window.fetch.preconnect,
    }),
  )
  const blobs: Blob[] = []
  const urls = spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
    blobs.push(blob as Blob)
    return 'blob:pinned-export'
  })
  const anchor = spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(
    () => {},
  )
  try {
    const { container } = await render(
      <ThreadHarness
        messages={[
          message(1, '<p>Original revision</p>', 'pinned-download-app'),
          message(2, undefined, 'pinned-download-app'),
        ]}
      />,
    )
    // A live App belongs to its answer; both revisions offer their download
    // from the answer's inline artifact, not from a card.
    const downloads = await waitFor(() => {
      const found = container.querySelectorAll<HTMLButtonElement>(
        '[data-slot="inline-artifact"] [aria-label="Download App source"]',
      )
      return found.length === 2 ? found : undefined
    }, 10_000)
    expect(downloads[0]!.title).toStartWith("Download this revision's source")
    expect(downloads[1]!.title).toStartWith('Download current saved source')
    // The pinned revision hands over exactly the source its message carried.
    // (That the pinned handover reads no document is proven at the registry
    // level, in artifact-registry's older-revision test; in the answer both
    // instances race their mount reads and their frames' src loads, so call
    // timing here would only measure scheduling.)
    await click(downloads[0]!)
    await waitFor(() => blobs.length)
    expect(await blobs[0]!.text()).toBe('<p>Original revision</p>')
  } finally {
    anchor.mockRestore()
    urls.mockRestore()
    get.mockRestore()
    window.location.href = originalUrl
  }
}, 30_000)

test('the panel of a live App is a referrer and mounts no runtime of its own', async () => {
  const originalUrl = window.location.href
  window.location.href = 'https://theorem.test/'
  // A live App reads its saved document when it mounts. The panel must not
  // perform that read: no document, no startup, twice.
  const get = spyOn(window, 'fetch').mockImplementation(
    Object.assign(
      async () =>
        Response.json({ detail: 'unused by the referrer' }, { status: 503 }),
      { preconnect: window.fetch.preconnect },
    ),
  )
  try {
    const { container } = await render(
      <Harness messages={[message(1, undefined, 'referrer-panel-app')]} />,
    )
    const referrer = await waitFor(() =>
      container.querySelector<HTMLElement>('[data-slot="artifact-referrer"]'),
    )
    expect(referrer.textContent).toContain('App')
    expect(buttonNamed(referrer, 'Open in answer')).toBeDefined()
    // Nothing of a live App appears in the dock.
    expect(container.querySelector('iframe')).toBeNull()
    expect(buttonNamed(container, 'Edit source')).toBeUndefined()
    expect(buttonNamed(container, 'Stop App')).toBeUndefined()
    expect(get).not.toHaveBeenCalled()
  } finally {
    get.mockRestore()
    window.location.href = originalUrl
  }
})

test('the answer and the panel of the same live App hold exactly one runtime', async () => {
  const originalUrl = window.location.href
  window.location.href = 'https://theorem.test/'
  const store = await appDocumentFixture()
  const get = spyOn(window, 'fetch').mockImplementation(
    Object.assign(async () => Response.json(store.saved()), {
      preconnect: window.fetch.preconnect,
    }),
  )
  try {
    const { container } = await render(
      <Workspace
        messages={[message(1, undefined, 'referrer-one-runtime-app')]}
      />,
    )
    // The answer runs the App; the panel refers to that answer.
    const frame = await waitFor(() => container.querySelector('iframe'), 10_000)
    expect(frame.getAttribute('sandbox')).toBe(BLOCK_SANDBOX)
    await waitFor(() =>
      container.querySelector('[data-slot="artifact-referrer"]'),
    )
    expect(container.querySelectorAll('iframe')).toHaveLength(1)
    expect(liveRuntimeCount(container)).toBe(1)
    expect(dockOf(container).querySelector('iframe')).toBeNull()
    expect(buttonNamed(dockOf(container), 'Edit source')).toBeUndefined()
  } finally {
    get.mockRestore()
    window.location.href = originalUrl
  }
}, 20_000)

test("the referrer focuses the answer's running App instead of starting another", async () => {
  const originalUrl = window.location.href
  window.location.href = 'https://theorem.test/'
  const get = spyOn(window, 'fetch').mockImplementation(
    Object.assign(
      async () =>
        Response.json(
          { detail: 'load state is not the point' },
          {
            status: 503,
          },
        ),
      { preconnect: window.fetch.preconnect },
    ),
  )
  try {
    const { container } = await render(
      <Workspace messages={[message(1, undefined, 'referrer-focus-app')]} />,
    )
    const answer = await waitFor(() =>
      container.querySelector<HTMLElement>(
        '[data-slot="inline-artifact"][data-current="true"]',
      ),
    )
    // A DOM-only test has no viewport layout; record the focus request on the
    // instance that is already running, as artifact-message.test.tsx does.
    const scroll = spyOn(answer, 'scrollIntoView').mockImplementation(() => {})
    try {
      await click(buttonNamed(dockOf(container), 'Open in answer')!)
      expect(scroll).toHaveBeenCalledWith({ block: 'center' })
      expect(document.activeElement).toBe(answer)
      expect(useArtifactView.getState().openId).toBeUndefined()
      expect(container.querySelector('iframe')).toBeNull()
    } finally {
      scroll.mockRestore()
    }
  } finally {
    get.mockRestore()
    window.location.href = originalUrl
  }
})

test('the referrer goes to the conversation before it focuses, and never starts one here', async () => {
  const originalUrl = window.location.href
  window.location.href = 'https://theorem.test/'
  const get = spyOn(window, 'fetch').mockImplementation(
    Object.assign(
      async () =>
        Response.json(
          { detail: 'no frame without a source' },
          {
            status: 503,
          },
        ),
      { preconnect: window.fetch.preconnect },
    ),
  )
  const messages = [message(1, undefined, 'referrer-away-app')]
  // Another mode is on screen: the panel is open, its conversation is not.
  function Page() {
    const runtime = useExternalStoreRuntime({
      messages,
      isRunning: false,
      onNew: async () => {},
      convertMessage: (item: ThreadMessageLike) => item,
    })
    return (
      <AssistantRuntimeProvider runtime={runtime}>
        <Outlet />
      </AssistantRuntimeProvider>
    )
  }
  function PanelOnlyPage() {
    return (
      <div data-testid="dock">
        <ArtifactPanel artifactId="app-draft-result" onClose={() => {}} />
      </div>
    )
  }
  function ConversationPage() {
    return (
      <>
        <TheoremPartRenderers />
        <ThreadPrimitive.Messages
          components={{ Message: () => <MessagePrimitive.Parts /> }}
        />
        <div data-testid="dock">
          <ArtifactPanel artifactId="app-draft-result" onClose={() => {}} />
        </div>
      </>
    )
  }
  const root = createRootRoute({ component: Page })
  const panelOnly = createRoute({
    getParentRoute: () => root,
    path: '/',
    component: PanelOnlyPage,
  })
  const conversation = createRoute({
    getParentRoute: () => root,
    path: '/c/$threadId',
    component: ConversationPage,
  })
  root.addChildren([panelOnly, conversation])
  const router = createRouter({
    routeTree: root,
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  useShell.getState().setChatThreadId('answer-thread')
  try {
    await router.load()
    const { container } = await render(<RouterProvider router={router} />)
    const referrer = await waitFor(() =>
      container.querySelector<HTMLElement>('[data-slot="artifact-referrer"]'),
    )
    expect(container.querySelector('iframe')).toBeNull()
    await click(buttonNamed(referrer, 'Open in answer')!)
    // The conversation comes on screen, and the answer's instance takes focus.
    await waitFor(
      () => router.state.location.pathname === '/c/answer-thread',
      5_000,
    )
    const answer = await waitFor(
      () =>
        container.querySelector<HTMLElement>(
          '[data-slot="inline-artifact"][data-current="true"]',
        ),
      5_000,
    )
    await waitFor(() => document.activeElement === answer, 5_000)
    // The panel still holds no runtime of its own, whatever the navigation did.
    const dock = dockOf(container)
    expect(dock.querySelector('[data-slot="artifact-referrer"]')).not.toBeNull()
    expect(dock.querySelector('iframe')).toBeNull()
    expect(liveRuntimeCount(dock)).toBe(0)
  } finally {
    useShell.getState().setChatThreadId(undefined)
    get.mockRestore()
    window.location.href = originalUrl
  }
}, 20_000)

test('a non-live artifact keeps its normal body in the panel', async () => {
  const { container } = await render(
    <Harness messages={[documentMessage(1)]} artifactId="doc-draft-result" />,
  )
  const heading = await waitFor(() => container.querySelector('h1'))
  expect(heading.textContent).toBe('Document')
  expect(container.querySelector('[data-slot="artifact-referrer"]')).toBeNull()
})
