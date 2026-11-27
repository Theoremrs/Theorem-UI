// The panel is the document half of assistant-ui's canvas split: its header
// says whether the turn is still writing the revision shown, and its body
// carries the writing caret until the reply that writes it finishes.
import { act } from 'react'
import { afterEach, expect, test } from 'bun:test'
import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
} from '@assistant-ui/react'
import type { ThreadMessageLike } from '@assistant-ui/react'
import { cleanup, render, waitFor } from '../../../test/blocks/render'
import { ArtifactPanel } from './artifact-panel'
import { useArtifactView } from './artifact-view'

afterEach(async () => {
  await cleanup()
  useArtifactView.getState().reset()
})

function draft(revision: number, running = false): ThreadMessageLike {
  return {
    id: `draft-${revision}`,
    role: 'assistant',
    status: running
      ? { type: 'running' }
      : { type: 'complete', reason: 'stop' },
    content: [
      {
        type: 'data',
        name: 'theorem-artifact',
        data: {
          artifactId: 'notes',
          artifactRevision: String(revision),
          artifactKind: 'document',
          rendererId: 'theorem-document',
          patchSequence: revision,
          lifecycle: 'ready',
          payload: {
            title: 'Field notes',
            content: `# Draft ${revision}`,
            language: 'markdown',
          },
        },
      },
    ],
  }
}

function Panel({
  messages,
  isRunning,
}: {
  messages: ThreadMessageLike[]
  isRunning: boolean
}) {
  const runtime = useExternalStoreRuntime({
    messages,
    isRunning,
    onNew: async () => {},
    convertMessage: (item: ThreadMessageLike) => item,
  })
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ArtifactPanel artifactId="notes" onClose={() => {}} />
    </AssistantRuntimeProvider>
  )
}

const header = (root: ParentNode) =>
  root.querySelector('[data-slot="canvas-split-header"]')?.textContent ?? ''
const caret = (root: ParentNode) =>
  root.querySelector('[data-slot="canvas-split-body"] > span[aria-hidden]')

test('the revision the turn is writing reads editing, with the caret, until its reply finishes', async () => {
  const { container, rerender } = await render(
    <Panel messages={[draft(1, true)]} isRunning />,
  )
  await waitFor(() => container.querySelector('h1'))
  expect(
    container.querySelector('[data-slot="canvas-split-document"]'),
  ).not.toBeNull()
  expect(header(container)).toContain('Field notes')
  expect(header(container)).toContain('v1')
  expect(header(container)).toContain('editing')
  expect(caret(container)).not.toBeNull()

  await rerender(<Panel messages={[draft(1)]} isRunning={false} />)
  await waitFor(() => header(container).includes('saved'))
  expect(header(container)).not.toContain('editing')
  expect(caret(container)).toBeNull()
})

test('an older revision reads saved while the turn writes the newest', async () => {
  const { container } = await render(
    <Panel messages={[draft(1), draft(2, true)]} isRunning />,
  )
  await waitFor(() => header(container).includes('v2 of 2'))
  expect(header(container)).toContain('editing')
  await act(async () => useArtifactView.getState().select('notes', '1'))
  await waitFor(() => header(container).includes('v1 of 2'))
  expect(header(container)).toContain('saved')
  expect(caret(container)).toBeNull()
})

test('the header keeps one Copy, the one that reports a failed copy in place', async () => {
  const { container } = await render(
    <Panel messages={[draft(1)]} isRunning={false} />,
  )
  await waitFor(() => container.querySelector('h1'))
  const copies = container.querySelectorAll(
    '[data-slot="canvas-split-header"] [aria-label^="Copy"]',
  )
  expect(copies).toHaveLength(1)
  expect(
    container.querySelector(
      '[data-slot="canvas-split-header"] [aria-label="Close the canvas"]',
    ),
  ).not.toBeNull()
})
