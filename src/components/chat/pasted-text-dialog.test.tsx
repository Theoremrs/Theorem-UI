// SOURCING: bun:test over happy-dom with the repo's render helpers (test/blocks/render); the real Thread and Theorem's part renderers over assistant-ui's external-store runtime, with the upload answered by stories/fake-theorem
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
} from '@assistant-ui/react'
import type { ThreadMessageLike } from '@assistant-ui/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { installFakeTheorem } from '@/stories/fake-theorem'
import { Thread } from '../assistant-ui/elements/thread.aui'
import { TheoremPartRenderers } from './theorem-parts'
import {
  buttonNamed,
  cleanup,
  click,
  render,
  waitFor,
} from '../../../test/blocks/render'

const PASTED = Array.from(
  { length: 90 },
  (_, row) => `row ${row + 1}, ok`,
).join('\n')

// The Theorem client asks this page's origin, which about:blank lacks.
const page = (
  window as unknown as { happyDOM: { setURL: (url: string) => void } }
).happyDOM
beforeAll(() => page.setURL('http://localhost:3000/'))
afterAll(() => page.setURL('about:blank'))

const client = new QueryClient({
  defaultOptions: { queries: { retry: false } },
})
let restore = () => {}
afterEach(async () => {
  restore()
  await cleanup()
})

/** A thread holding one sent message as Theorem stores it: text, then its pasted text's upload. */
function Sent() {
  const runtime = useExternalStoreRuntime({
    messages: [
      {
        id: 'u1',
        role: 'user',
        content: [
          { type: 'text', text: 'Check these rows' },
          {
            type: 'data',
            name: 'theorem-attachment',
            data: {
              uploadId: 'upload-1',
              name: 'Pasted text.txt',
              mediaType: 'text/plain',
              state: 'ready',
            },
          },
        ],
      },
    ] satisfies ThreadMessageLike[],
    convertMessage: (message: ThreadMessageLike) => message,
    isRunning: false,
    onNew: async () => {},
  })
  return (
    <QueryClientProvider client={client}>
      <AssistantRuntimeProvider runtime={runtime}>
        <TheoremPartRenderers />
        <Thread autoFocus={false} />
      </AssistantRuntimeProvider>
    </QueryClientProvider>
  )
}

test("a sent pasted text shows as the element's received-file row, read from its upload, and opens whole", async () => {
  restore = installFakeTheorem({
    'GET /api/chat/v1/uploads/:uploadId/content': ({ uploadId }) =>
      uploadId === 'upload-1'
        ? new Response(PASTED, { headers: { 'content-type': 'text/plain' } })
        : new Response(null, { status: 404 }),
  })
  const { container } = await render(<Sent />)
  const row = await waitFor(() =>
    container.querySelector<HTMLButtonElement>(
      '[data-slot="message-attachments"] button',
    ),
  )
  await waitFor(() =>
    row.textContent.includes(
      `90 lines · ${PASTED.length.toLocaleString()} characters`,
    ),
  )
  expect(row.textContent).toContain('Pasted text.txt')
  await click(row)
  const body = await waitFor(() =>
    document.querySelector('.aui-pasted-text-body'),
  )
  expect(body.textContent).toBe(PASTED)
  // A sent message keeps what it sent: there is no draft to put it back in.
  expect(buttonNamed(document, 'Paste inline')).toBeUndefined()
})
