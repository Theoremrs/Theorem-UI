// SOURCING: bun:test over happy-dom, with the upload answered by stories/fake-theorem in parts, as the network brings it
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { installFakeTheorem } from '@/stories/fake-theorem'
import { readUploadHead, uploadContentPath } from './uploads'

// The Theorem client asks this page's origin, which about:blank lacks.
const page = (
  window as unknown as { happyDOM: { setURL: (url: string) => void } }
).happyDOM
beforeAll(() => page.setURL('http://localhost:3000/'))
afterAll(() => page.setURL('about:blank'))

let restore = () => {}
afterEach(() => restore())

/** An upload of `size` bytes, answered in parts of `part` bytes. */
function serve(size: number, part: number) {
  const bytes = new Uint8Array(size).map((_, i) => i % 251)
  let at = 0
  restore = installFakeTheorem({
    'GET /api/chat/v1/uploads/:uploadId/content': () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(stream) {
            if (at >= bytes.length) return stream.close()
            stream.enqueue(bytes.slice(at, (at += part)))
          },
        }),
        { headers: { 'content-type': 'application/pdf' } },
      ),
  })
  return bytes
}

const path = uploadContentPath('upload-1')

test('a file whose last part crosses the limit is not whole, and only its beginning is kept', async () => {
  // Parts of 4 and 4 against a limit of 6: the second part ends the file past it.
  const bytes = serve(8, 4)
  const { head, whole } = await readUploadHead(path, 6)
  expect(whole).toBe(false)
  expect(head.size).toBe(6)
  expect(new Uint8Array(await head.arrayBuffer())).toEqual(bytes.slice(0, 6))
  expect(head.type).toBe('application/pdf')
})

test('a file that ends exactly at the limit is whole', async () => {
  serve(8, 4)
  const { head, whole } = await readUploadHead(path, 8)
  expect(whole).toBe(true)
  expect(head.size).toBe(8)
})

test('a file shorter than the limit is whole', async () => {
  serve(5, 2)
  const { head, whole } = await readUploadHead(path, 64)
  expect(whole).toBe(true)
  expect(head.size).toBe(5)
})

test('a file that goes on past the limit is not whole', async () => {
  serve(64, 4)
  const { head, whole } = await readUploadHead(path, 8)
  expect(whole).toBe(false)
  expect(head.size).toBe(8)
})
