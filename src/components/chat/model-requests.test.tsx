import { afterEach, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { cleanup, click, render, waitFor } from '../../../test/blocks/render'
import { ModelRequests } from './model-requests'

const originalFetch = globalThis.fetch
afterEach(() => {
  cleanup()
  globalThis.fetch = originalFetch
})

const request = {
  requestId: 'request-1',
  sequence: 27,
  provider: 'deepseek',
  model: 'deepseek-chat',
  capturedAtMs: 1_000,
  bodyBytes: 300,
  capturedBytes: 250,
  bodyHash: 'sha256:original',
  completeness: 'redacted',
  capturePoint: 'before_send',
  exclusions: [
    {
      path: '/messages/1/reasoning_content',
      reason: 'Opaque continuation omitted',
    },
  ],
  messageCount: 2,
  toolCount: 1,
}

const list = {
  schema: 'theorem.chat.model-requests/v1',
  runId: 'run-1',
  terminal: true,
  captureStatus: 'recorded',
  notRecordedReason: null,
  requests: [request],
  nextAfterSeq: 27,
  hasMore: false,
}

function serve(answers: (path: string) => unknown, status = 200) {
  const paths: string[] = []
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const path = String(input)
    paths.push(path)
    return Promise.resolve(Response.json(answers(path), { status }))
  }) as typeof fetch
  return paths
}

function harness() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  })
  return render(
    <QueryClientProvider client={client}>
      <ModelRequests runId="run-1" />
    </QueryClientProvider>,
  )
}

async function openSummary(container: ParentNode, title: string) {
  const summary = [...container.querySelectorAll('summary')].find(
    (item) => item.textContent === title,
  )
  if (!summary) throw new Error(`No disclosure ${title}`)
  const details = summary.parentElement as HTMLDetailsElement
  await act(async () => {
    details.open = true
    details.dispatchEvent(new Event('toggle', { bubbles: true }))
  })
}

test('a body is read only after selecting its request and user content remains plain text', async () => {
  const hostile = '<img src=x onerror="alert(1)">\nAn exact system instruction.'
  const body = {
    model: 'deepseek-chat',
    messages: [
      { role: 'system', content: hostile },
      { role: 'user', content: 'Make a simulation' },
    ],
    tools: [
      {
        type: 'function',
        function: { name: 'write_app', parameters: { type: 'object' } },
      },
    ],
  }
  const paths = serve((path) =>
    path.endsWith('/request-1')
      ? {
          schema: 'theorem.chat.model-request/v1',
          runId: 'run-1',
          request,
          body,
        }
      : list,
  )
  const { container } = await harness()
  const button = await waitFor(() =>
    [...container.querySelectorAll('button')].find((item) =>
      item.textContent.includes('Request 1'),
    ),
  )
  expect(paths).toHaveLength(1)
  expect(container.textContent).not.toContain('Request 27')
  await click(button)
  await waitFor(() => container.textContent.includes('Original body hash'))
  expect(paths).toEqual([
    '/api/chat/v1/runs/run-1/model-requests?afterSeq=0&limit=100',
    '/api/chat/v1/runs/run-1/model-requests/request-1',
  ])
  expect(container.textContent).toContain('Event position27')
  expect(container.textContent).toContain('Excluded from this capture')
  expect(container.textContent).toContain('Opaque continuation omitted')
  expect(container.textContent).toContain(
    'Provider receipt is not recorded here',
  )
  await openSummary(container, 'Messages (2)')
  await openSummary(container, '1. system')
  expect(container.textContent).toContain(hostile)
  expect(container.querySelector('img')).toBeNull()
  await openSummary(container, 'Tool declarations (1)')
  expect(container.textContent).toContain('1. write_app')
  await openSummary(container, 'Captured JSON')
  const source = [...container.querySelectorAll('pre')].find((item) =>
    item.textContent.includes('"messages"'),
  )
  expect(JSON.parse(source?.textContent ?? '')).toEqual(body)
})

test('an older run says capture was not recorded without inventing requests', async () => {
  serve(() => ({
    ...list,
    captureStatus: 'not_recorded',
    requests: [],
    notRecordedReason: 'This turn predates request capture.',
  }))
  const { container } = await harness()
  await waitFor(() =>
    container.textContent.includes('This turn predates request capture.'),
  )
  expect(container.textContent).not.toContain('Request 1')
  expect(
    container.querySelector('[data-slot="captured-model-request"]'),
  ).toBeNull()
})

test('pagination opens the next event page and keeps request numbering sequential', async () => {
  const paths = serve((path) =>
    path.includes('afterSeq=27')
      ? {
          ...list,
          requests: [{ ...request, requestId: 'request-2', sequence: 98 }],
          nextAfterSeq: 98,
        }
      : { ...list, hasMore: true },
  )
  const { container } = await harness()
  const more = await waitFor(() =>
    [...container.querySelectorAll('button')].find(
      (item) => item.textContent === 'Load more requests',
    ),
  )
  await click(more)
  await waitFor(() => container.textContent.includes('Request 2'))
  expect(paths).toContain(
    '/api/chat/v1/runs/run-1/model-requests?afterSeq=27&limit=100',
  )
  expect(container.textContent).not.toContain('Request 98')
})

test('an unavailable endpoint is distinguished from an older uncaptured run', async () => {
  serve(() => ({ error: { message: 'Not found' } }), 404)
  const { container } = await harness()
  await waitFor(() =>
    container.textContent.includes(
      'Request inspection is unavailable for this turn or this server version.',
    ),
  )
  expect(container.textContent).not.toContain('This turn predates')
})
