// SOURCING: bun:test over happy-dom with the repo's render helpers (test/blocks/render); the real Thread and Theorem's part renderers over assistant-ui's external-store runtime, with the upload answered by stories/fake-theorem
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
} from '@assistant-ui/react'
import type { ThreadMessageLike } from '@assistant-ui/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { installFakeTheorem } from '@/stories/fake-theorem'
import type { FakeAnswer } from '@/stories/fake-theorem'
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

/** A thread holding one sent message as Theorem stores it: text, then one upload. */
function Sent({ name, mediaType }: { name: string; mediaType: string }) {
  // Each file its own upload: the query cache outlives a test.
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
              uploadId: `upload-${name}`,
              name,
              mediaType,
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

const answer = (body: BodyInit, type: string): Record<string, FakeAnswer> => ({
  'GET /api/chat/v1/uploads/:uploadId/content': ({ uploadId }) =>
    uploadId?.startsWith('upload-')
      ? new Response(body, { headers: { 'content-type': type } })
      : new Response(null, { status: 404 }),
})

const tile = (container: Element) =>
  waitFor(
    () =>
      container.querySelector<HTMLElement>(
        '.aui-user-message .aui-attachment-tile',
      ) ?? container.querySelector<HTMLElement>('.aui-attachment-tile'),
  )

test('a sent pasted text stands as the composer showed it, read from its upload, and opens whole', async () => {
  restore = installFakeTheorem(answer(PASTED, 'text/plain'))
  const { container } = await render(
    <Sent name="Pasted text.txt" mediaType="text/plain" />,
  )
  const card = await tile(container)
  await waitFor(() => card.textContent.includes('TXT · 90 lines'))
  expect(card.textContent).toContain('Pasted text')
  expect(card.getAttribute('aria-label')).toBe('Preview Pasted text.txt')
  await click(card)
  const body = await waitFor(() =>
    document.querySelector('.aui-pasted-text-body'),
  )
  expect(body.textContent).toBe(PASTED)
  // A sent message keeps what it sent: there is no draft to put it back in.
  expect(buttonNamed(document, 'Paste inline')).toBeUndefined()
})

test('a sent image opens as an image, and a Word file stands without a preview', async () => {
  const png = Uint8Array.from(
    atob(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    ),
    (c) => c.charCodeAt(0),
  )
  restore = installFakeTheorem(answer(png, 'image/png'))
  const image = await render(<Sent name="shot.png" mediaType="image/png" />)
  const card = await tile(image.container)
  await waitFor(() => card.textContent.includes(`PNG · ${png.length} bytes`))
  await waitFor(() => card.getAttribute('role') === 'button')
  await click(card)
  await waitFor(() => document.querySelector('img[alt="Preview of shot.png"]'))
  restore()
  await cleanup()

  const docx =
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  restore = installFakeTheorem(answer('PK', docx))
  const word = await render(<Sent name="brief.docx" mediaType={docx} />)
  const doc = await tile(word.container)
  await waitFor(() => doc.textContent.includes('DOCX · 2 bytes'))
  expect(doc.getAttribute('role')).toBe('group')
})
