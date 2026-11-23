// SOURCING: Theorem's upload routes (docs/plans/thread-organization-and-review.md, Media) through lib/theorem/client and imports' uploadFile, @tanstack/react-query for an image's bytes. Bytes go through fetch because the client carries Theorem's session; a blob: URL is what the platform's elements then read, as useShotUrl does for review shots.
import { useQuery } from '@tanstack/react-query'
import { useFileSrc } from '@/hooks/use-attachment-src'
import { mutate, theorem } from './client'
import type { EmbedRef } from './embeds'
import { uploadFile } from './imports'
import { theoremJson } from './passthrough'
import { fileBlock, fileShape, imageBlock } from './note-kinds'

const BASE = '/api/chat/v1/uploads'

export const uploadContentPath = (uploadId: string) =>
  `${BASE}/${encodeURIComponent(uploadId)}/content`

/** A note's image written as a Theorem upload, rather than a URL anywhere else. */
export const isUploadPath = (url: string) =>
  url.startsWith(`${BASE}/`) && url.endsWith('/content')

/** What file notes may hold. Theorem checks each by its magic bytes as well. */
export const MEDIA_ACCEPT =
  'image/png,image/jpeg,image/webp,image/gif,application/pdf,audio/*,video/mp4,video/webm,video/quicktime'

export async function readUpload(
  path: string,
  signal?: AbortSignal,
): Promise<Blob> {
  const response = await theorem().fetch(path, { signal })
  if (!response.ok) throw new Error(`The file answered ${response.status}`)
  return response.blob()
}

/** An upload's first bytes, and how big it is whole. */
export type UploadHead = {
  head: Blob
  /** The whole file's size, when the server says it or the head is all of it. */
  size: number | undefined
  /** Whether the head is the whole file. */
  whole: boolean
}

/**
 * Reads an upload no further than `limit` bytes, then lets the rest of the
 * response go, so a card that needs a file's beginning does not fetch all of it.
 */
export async function readUploadHead(
  path: string,
  limit: number,
  signal?: AbortSignal,
): Promise<UploadHead> {
  const response = await theorem().fetch(path, { signal })
  if (!response.ok) throw new Error(`The file answered ${response.status}`)
  const type = response.headers.get('content-type') ?? ''
  const length = response.headers.get('content-length')
  const size = length === null ? undefined : Number(length)
  const reader = response.body?.getReader()
  if (!reader) {
    const head = await response.blob()
    return { head, size: head.size, whole: true }
  }
  const chunks: BlobPart[] = []
  let read = 0
  let whole = false
  while (!whole && read < limit) {
    const { done, value } = await reader.read()
    if (done) whole = true
    else {
      chunks.push(value)
      read += value.byteLength
    }
  }
  // At the limit, one more read tells a file that ends there from a longer one.
  if (!whole) whole = (await reader.read()).done
  if (!whole) void reader.cancel()
  const head = new Blob(chunks, { type })
  return whole
    ? { head, size: head.size, whole }
    : { head: head.slice(0, limit, type), size, whole }
}

/**
 * Keeps an upload in the Library. Uploads expire after a day unless
 * something keeps them: the Library, a message, or a project that names one.
 */
export function retainUpload(uploadId: string) {
  return mutate((headers) =>
    theoremJson<unknown>(
      `/api/chat/v1/library/uploads/${encodeURIComponent(uploadId)}/retain`,
      { method: 'POST', headers },
    ),
  )
}

export type UploadedBlock = {
  title: string
  /** The Markdown block that shows the file. */
  markdown: string
  /** Which viewer the block opens in. */
  shape: ReturnType<typeof fileShape>
}

/** A file put in Theorem for good, and the block a note shows it with. */
export async function uploadBlock(
  projectId: string,
  file: File,
): Promise<UploadedBlock> {
  const { uploadId, sha256 } = await uploadFile(projectId, file)
  await retainUpload(uploadId)
  const shape = fileShape(file.type)
  const embed: EmbedRef = {
    kind: 'file',
    id: uploadId,
    title: file.name,
    mime: file.type,
    size: file.size,
    sha256,
  }
  return {
    title: file.name,
    shape,
    markdown:
      shape === 'image'
        ? imageBlock(uploadContentPath(uploadId), file.name)
        : fileBlock(embed),
  }
}

/** An upload's first `limit` bytes, such as a sent file's card draws from. */
export function useUploadHead(uploadId: string, limit: number) {
  return useQuery({
    queryKey: ['theorem', 'upload-head', uploadId, limit],
    // An upload's bytes never change.
    staleTime: Number.POSITIVE_INFINITY,
    queryFn: ({ signal }) =>
      readUploadHead(uploadContentPath(uploadId), limit, signal),
  })
}

/** An upload's bytes, whole, once `enabled`: a sent file opened to be read. */
export function useUploadBlob(uploadId: string, enabled: boolean) {
  return useQuery({
    queryKey: ['theorem', 'upload-blob', uploadId],
    enabled,
    // An upload's bytes never change.
    staleTime: Number.POSITIVE_INFINITY,
    queryFn: ({ signal }) => readUpload(uploadContentPath(uploadId), signal),
  })
}

/** An image's address the platform can read: uploads as a blob:, the rest as written. */
export function useImageUrl(src: string | undefined) {
  const upload = src !== undefined && isUploadPath(src)
  const { data: blob, error } = useQuery({
    queryKey: ['theorem', 'upload', src],
    enabled: upload,
    // An upload's bytes never change.
    staleTime: Number.POSITIVE_INFINITY,
    queryFn: () => readUpload(src!),
  })
  const url = useFileSrc(blob)
  return { url: upload ? url : src, error }
}
