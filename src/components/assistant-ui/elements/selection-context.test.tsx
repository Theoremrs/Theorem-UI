import { afterEach, expect, test } from 'bun:test'
import { act } from 'react'
import type { ReactNode } from 'react'
import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
} from '@assistant-ui/react'
import type { ThreadMessageLike } from '@assistant-ui/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { Thread } from './thread.aui'
import { cleanup, render, waitFor } from '../../../../test/blocks/render'
import { useComposerReferences } from '@/components/chat/composer-references'

const client = new QueryClient({
  defaultOptions: { queries: { retry: false } },
})

afterEach(async () => {
  useComposerReferences.setState({ references: [] })
  await cleanup()
})

function Harness() {
  const runtime = useExternalStoreRuntime({
    messages: [
      {
        id: 'm1',
        role: 'assistant',
        status: { type: 'complete', reason: 'stop' },
        content: [{ type: 'text', text: 'The quadratic formula solves the equation.' }],
      },
    ] as ThreadMessageLike[],
    isRunning: false,
    onNew: async () => {},
    convertMessage: (message: ThreadMessageLike) => message,
    adapters: {
      threadList: {
        threadId: 't1',
        threads: [{ status: 'regular', id: 't1', remoteId: 'thread_remote_1' }],
      },
    },
  })
  return (
    <QueryClientProvider client={client}>
      <AssistantRuntimeProvider runtime={runtime}>
        <Thread autoFocus={false} />
      </AssistantRuntimeProvider>
    </QueryClientProvider>
  )
}

async function mount(harness: ReactNode) {
  const router = createRouter({
    routeTree: createRootRoute({ component: () => harness }),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  await router.load()
  const view = await render(<RouterProvider router={router} />)
  await waitFor(() => view.container.querySelector('.ProseMirror'))
  await waitFor(() => !client.isFetching())
  await act(() => new Promise((resolve) => setTimeout(resolve)))
  return view
}

test('selecting reply text and adding it to context puts a durable reference in the composer', async () => {
  const { container } = await mount(<Harness />)
  // The toolbar reads the selection on the next animation frame; happy-dom
  // does not fire those on its own, so run the queued one by hand.
  const raf = globalThis.requestAnimationFrame
  globalThis.requestAnimationFrame = (callback) => {
    callback(performance.now())
    return 0
  }
  const prose = await waitFor(() =>
    container.querySelector('[data-slot="aui_assistant-message-content"]'),
  )
  // Select the first words of the reply, as a pointer drag would.
  const walker = document.createTreeWalker(prose, NodeFilter.SHOW_TEXT)
  const node = walker.nextNode()
  expect(node).not.toBeNull()
  const range = document.createRange()
  range.setStart(node!, 0)
  range.setEnd(node!, 12)
  await act(async () => {
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    prose.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
  })
  // The toolbar portals to document.body, outside the rendered container.
  const button = await waitFor(() =>
    document.body.querySelector('[data-slot="selection-toolbar-context"]'),
  )
  expect(button).not.toBeNull()
  await act(async () => {
    ;(button as HTMLButtonElement).click()
  })
  globalThis.requestAnimationFrame = raf

  const references = await waitFor(() => {
    const refs = useComposerReferences.getState().references
    return refs.length ? refs : null
  })
  expect(references).toHaveLength(1)
  expect(references[0]!.location.resource).toEqual({
    kind: 'message',
    threadId: 'thread_remote_1',
    messageId: 'm1',
  })
  expect(references[0]!.excerpt).toBe('The quadrati')
})
