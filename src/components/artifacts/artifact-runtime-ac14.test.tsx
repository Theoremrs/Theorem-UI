// UAE-AC-14 (AR-08 to AR-12) and the part of UAE-AC-16 that does not need a
// browser: a real App, through the answer, the dock's panel and the expanded
// view, with the runtime host mounted as the signed-in shell mounts it.
import { afterEach, expect, spyOn, test } from 'bun:test'
import * as esbuild from 'esbuild-wasm'
import { act } from 'react'
import {
  AssistantRuntimeProvider,
  MessagePrimitive,
  ThreadPrimitive,
  useExternalStoreRuntime,
} from '@assistant-ui/react'
import type { ThreadMessageLike } from '@assistant-ui/react'
import { TheoremPartRenderers } from '@/components/chat/theorem-parts'
import * as hosted from '@/lib/blocks/hosted-app'
import { appDocumentFixture } from '../../../test/blocks/app-documents'
import {
  buttonNamed,
  cleanup,
  click,
  render,
  waitFor,
} from '../../../test/blocks/render'
import { ArtifactPanel } from './artifact-panel'
import { expandedViewId, useArtifactRuntimes } from './artifact-runtime'
import { ArtifactRuntimeHost } from './artifact-runtime-host'
import { useArtifactView } from './artifact-view'

const originalHosted = hosted.hostedAppDocument

function Message() {
  return <MessagePrimitive.Parts />
}

type Part = {
  id: string
  lifecycle?: string
  documentId?: string
  position?: number
}

const message = ({
  id,
  lifecycle = 'ready',
  documentId = 'app-document',
  position = 1,
}: Part): ThreadMessageLike => ({
  id,
  role: 'assistant',
  status: { type: 'complete', reason: 'stop' },
  content: [
    {
      type: 'data',
      name: 'theorem-artifact',
      data: {
        artifactId: 'planner',
        artifactRevision: id,
        partId: `part-${id}`,
        artifactKind: 'app',
        rendererId: 'theorem-app',
        lifecycle,
        patchSequence: 1,
        payload: {
          title: 'Planner',
          ...(documentId && { documentId }),
          revision: { position },
        },
      },
    },
  ],
})

function Harness({ parts, docked }: { parts: Array<Part>; docked: boolean }) {
  const runtime = useExternalStoreRuntime({
    messages: parts.map(message),
    isRunning: false,
    onNew: async () => {},
    convertMessage: (item: ThreadMessageLike) => item,
  })
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <TheoremPartRenderers />
      <ArtifactRuntimeHost />
      <ThreadPrimitive.Messages components={{ Message }} />
      {docked && (
        <div data-testid="dock">
          <ArtifactPanel artifactId="planner" onClose={() => {}} />
        </div>
      )}
    </AssistantRuntimeProvider>
  )
}

afterEach(async () => {
  await cleanup()
  useArtifactRuntimes.getState().reset()
  useArtifactView.getState().reset()
})

async function withApp(run: (frames: () => number) => Promise<void>) {
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
  const create = document.createElement.bind(document)
  let frames = 0
  const made = spyOn(document, 'createElement').mockImplementation(
    (tag: string, options?: ElementCreationOptions) => {
      if (tag.toLowerCase() === 'iframe') frames++
      return create(tag, options)
    },
  )
  try {
    await run(() => frames)
  } finally {
    made.mockRestore()
    compile.mockRestore()
    fetch.mockRestore()
    window.location.href = originalUrl
  }
}

const primary = () =>
  Object.values(useArtifactRuntimes.getState().runtimes).find(
    (one) => one.primary,
  )!

const inlineDialog = () =>
  document.querySelector<HTMLDialogElement>(
    '[data-slot="inline-artifact"][data-current="true"]',
  )!

const dock = () => document.querySelector<HTMLElement>('[data-testid="dock"]')!

test('AC-14: inline, docked, expanded, restored, closed and reopened, the App starts once and keeps its runtime and state', async () => {
  await withApp(async (frames) => {
    const parts = [{ id: '1' }]
    const { rerender } = await render(<Harness parts={parts} docked={false} />)
    const iframe = await waitFor(
      () =>
        document.querySelector<HTMLIFrameElement>(
          '[data-slot="artifact-runtime"] iframe',
        ),
      10_000,
    )
    const element = iframe.closest<HTMLElement>(
      '[data-slot="artifact-runtime"]',
    )!
    const parent = element.parentNode
    const runtimeId = primary().id
    // The answer holds the runtime; the App is not inside the answer's subtree.
    expect(inlineDialog().querySelector('iframe')).toBeNull()
    expect(
      inlineDialog()
        .querySelector('[data-slot="artifact-runtime-slot"]')
        ?.getAttribute('data-runtime-id'),
    ).toBe(runtimeId)
    // Inspect the source: the editor is the runtime's own state.
    await click(buttonNamed(element, 'Edit source')!)
    await waitFor(() => buttonNamed(element, 'Save source'))

    // Docked: the panel attaches as a passive view, then takes the attachment.
    await rerender(<Harness parts={parts} docked />)
    const passive = await waitFor(() =>
      dock().querySelector('[data-slot="artifact-runtime-passive"]'),
    )
    expect(passive.textContent).toContain('Running in its answer')
    await click(buttonNamed(passive, 'Move here')!)
    await waitFor(() =>
      dock().querySelector('[data-slot="artifact-runtime-slot"]'),
    )
    expect(primary().holder).toStartWith('docked:')
    expect(inlineDialog().textContent).toContain('Running in a panel')

    // Expanded from the answer: the host's own view takes it, in the top layer.
    const expand = [...inlineDialog().querySelectorAll('button')].find(
      (button) => button.textContent.trim() === 'Expand',
    )!
    await click(expand)
    const stage = document.querySelector<HTMLDialogElement>(
      'dialog[data-runtime-stage]',
    )!
    await waitFor(() =>
      stage.querySelector(
        '[data-slot="artifact-runtime-expanded"] [data-slot="artifact-runtime-slot"]',
      ),
    )
    expect(primary().holder).toBe(expandedViewId(runtimeId))
    expect(expand.getAttribute('aria-expanded')).toBe('true')

    // Restored with Escape: back to the answer that opened it.
    await act(() => {
      stage.dispatchEvent(new Event('cancel', { cancelable: true }))
    })
    expect(useArtifactRuntimes.getState().expanded).toBeUndefined()
    expect(primary().holder).toBe(`inline:part-1`)
    expect(
      stage.querySelector('[data-slot="artifact-runtime-expanded"]'),
    ).toBeNull()

    // Close the panel: no Stop, the answer keeps it. Reopen and move it back.
    await rerender(<Harness parts={parts} docked={false} />)
    expect(primary().attachments.map((one) => one.surface)).toEqual(['inline'])
    await rerender(<Harness parts={parts} docked />)
    await click(
      buttonNamed(
        await waitFor(() =>
          dock().querySelector('[data-slot="artifact-runtime-passive"]'),
        ),
        'Move here',
      )!,
    )
    expect(primary().holder).toStartWith('docked:')

    // One startup in all of it; the same frame, element, parent and runtime.
    expect(frames()).toBe(1)
    expect(primary().startups).toBe(1)
    expect(primary().id).toBe(runtimeId)
    expect(document.querySelectorAll('iframe')).toHaveLength(1)
    expect(element.querySelector('iframe')).toBe(iframe)
    expect(element.parentNode).toBe(parent)
    expect(buttonNamed(element, 'Save source')).toBeDefined()
    expect(buttonNamed(element, 'Stop App')).toBeDefined()
  })
}, 30_000)

test('AC-16 (without a browser): a new revision still being written keeps the last valid App running and names it accurately', async () => {
  await withApp(async (frames) => {
    const { rerender } = await render(
      <Harness parts={[{ id: '1' }]} docked={false} />,
    )
    await waitFor(
      () => document.querySelector('[data-slot="artifact-runtime"] iframe'),
      10_000,
    )
    await waitFor(() => primary().revisions.running === '1')
    // The agent streams the next revision: its part names no document yet.
    await rerender(
      <Harness
        parts={[
          { id: '1' },
          { id: '2', lifecycle: 'streaming', documentId: '', position: 2 },
        ]}
        docked={false}
      />,
    )
    const status = await waitFor(() =>
      document.querySelector<HTMLElement>(
        '[data-slot="inline-artifact"][data-part-id="part-2"] [data-slot="artifact-runtime-status"] [role="status"]',
      ),
    )
    // The newest answer shows the runtime that still runs v1, never as v2.
    expect(status.textContent).toBe('Writing v2 · still running v1')
    expect(primary().holder).toBe('inline:part-2')
    expect(frames()).toBe(1)
    expect(document.querySelectorAll('iframe')).toHaveLength(1)
    // The older answer shows its pinned revision, which executes nothing.
    expect(
      document.querySelector(
        '[data-slot="inline-artifact"][data-part-id="part-1"] iframe',
      ),
    ).toBeNull()
  })
}, 30_000)
