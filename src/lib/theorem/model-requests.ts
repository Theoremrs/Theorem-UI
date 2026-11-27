// SOURCING: the native chat API's model-request captures, zod boundary parsing,
// and TanStack Query for paginated metadata and lazy immutable request bodies.
import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query'
import { TheoremError } from '@theoremharness/sdk'
import { z } from 'zod'
import { hasStatus } from './client'

const count = z.number().int().nonnegative()
const exclusion = z.object({ path: z.string(), reason: z.string() })

export const modelRequestSummaryShape = z.object({
  requestId: z.string(),
  sequence: count,
  provider: z.string(),
  model: z.string(),
  capturedAtMs: z.number(),
  bodyBytes: count,
  capturedBytes: count,
  bodyHash: z.string(),
  completeness: z.enum(['complete', 'redacted']),
  capturePoint: z.literal('before_send'),
  exclusions: z.array(exclusion),
  messageCount: count,
  toolCount: count,
})

const requestListShape = z.object({
  schema: z.literal('theorem.chat.model-requests/v1'),
  runId: z.string(),
  terminal: z.boolean(),
  captureStatus: z.enum(['recorded', 'not_recorded']),
  notRecordedReason: z.string().nullable(),
  requests: z.array(modelRequestSummaryShape),
  nextAfterSeq: count,
  hasMore: z.boolean(),
})

const requestDetailShape = z.object({
  schema: z.literal('theorem.chat.model-request/v1'),
  runId: z.string(),
  request: modelRequestSummaryShape,
  body: z.json(),
})

export type ModelRequestSummary = z.infer<typeof modelRequestSummaryShape>
export type ModelRequestList = z.infer<typeof requestListShape>
export type ModelRequestDetail = z.infer<typeof requestDetailShape>

const runPath = (runId: string) =>
  `/api/chat/v1/runs/${encodeURIComponent(runId)}/model-requests`

async function read<T>(
  path: string,
  schema: z.ZodType<T>,
  signal?: AbortSignal,
) {
  const response = await fetch(path, {
    headers: { accept: 'application/json' },
    signal,
  })
  const body: unknown = await response.json().catch(() => undefined)
  if (!response.ok)
    throw new TheoremError({ statusCode: response.status, body })
  const parsed = schema.safeParse(body)
  if (!parsed.success)
    throw new Error(
      'The node returned an unreadable request capture. The page and node may be different versions.',
    )
  return parsed.data
}

export async function readModelRequests(
  runId: string,
  afterSeq = 0,
  signal?: AbortSignal,
) {
  const page = await read(
    `${runPath(runId)}?afterSeq=${afterSeq}&limit=100`,
    requestListShape,
    signal,
  )
  if (page.runId !== runId)
    throw new Error('The node returned request captures for a different turn.')
  if (page.hasMore && page.nextAfterSeq <= afterSeq)
    throw new Error(
      'The node returned a request page without a forward cursor.',
    )
  return page
}

export async function readModelRequest(
  runId: string,
  requestId: string,
  signal?: AbortSignal,
) {
  const detail = await read(
    `${runPath(runId)}/${encodeURIComponent(requestId)}`,
    requestDetailShape,
    signal,
  )
  if (detail.runId !== runId || detail.request.requestId !== requestId)
    throw new Error('The node returned a capture for a different request.')
  return detail
}

export const modelRequestsQuery = (runId: string) =>
  infiniteQueryOptions({
    queryKey: ['theorem', 'model-requests', runId],
    initialPageParam: 0,
    queryFn: ({ pageParam, signal }) =>
      readModelRequests(runId, pageParam, signal),
    getNextPageParam: (page) => (page.hasMore ? page.nextAfterSeq : undefined),
    refetchInterval: (query) => {
      if (hasStatus(query.state.error, 401, 403, 404)) return false
      return query.state.data?.pages.at(-1)?.terminal ? false : 5_000
    },
    retry: false,
  })

export const modelRequestQuery = (runId: string, requestId: string) =>
  queryOptions({
    queryKey: ['theorem', 'model-request', runId, requestId],
    queryFn: ({ signal }) => readModelRequest(runId, requestId, signal),
    staleTime: Infinity,
    retry: false,
  })

export type RequestSection = {
  name: string
  value: unknown
  kind: 'messages' | 'tools' | 'text' | 'json'
}

/** All root fields remain inspectable, including providers with unfamiliar shapes. */
export function requestSections(body: unknown): RequestSection[] {
  if (typeof body !== 'object' || body === null || Array.isArray(body))
    return [{ name: 'Request body', value: body, kind: 'json' }]
  const { messages, system, tools, ...settings } = body as Record<
    string,
    unknown
  >
  const sections: RequestSection[] = []
  if (system !== undefined)
    sections.push({
      name: 'System',
      value: system,
      kind: typeof system === 'string' ? 'text' : 'json',
    })
  if (messages !== undefined)
    sections.push({
      name: 'Messages',
      value: messages,
      kind: Array.isArray(messages) ? 'messages' : 'json',
    })
  if (tools !== undefined)
    sections.push({
      name: 'Tool declarations',
      value: tools,
      kind: Array.isArray(tools) ? 'tools' : 'json',
    })
  if (Object.keys(settings).length)
    sections.push({
      name: 'Request settings and other fields',
      value: settings,
      kind: 'json',
    })
  return sections
}

/** Stored captures are JSON, so this is also the downloadable representation. */
export function capturedJson(body: unknown): string {
  return JSON.stringify(body ?? null, null, 2)
}

export function captureBytes(bytes: number): string {
  return bytes < 1_024
    ? `${bytes} B`
    : bytes < 1_048_576
      ? `${(bytes / 1_024).toFixed(1)} KiB`
      : `${(bytes / 1_048_576).toFixed(1)} MiB`
}
