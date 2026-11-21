import { afterEach, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, waitFor } from '../../../test/blocks/render'
import { linkMetadataQueryKey, useLinkMetadata } from './link-preview'

const originalFetch = window.fetch
const url = 'https://example.com/recovering-source'

afterEach(async () => {
  try {
    await cleanup()
  } finally {
    window.fetch = originalFetch
  }
})

function Metadata() {
  const query = useLinkMetadata(url)
  return <p>{query.data?.title ?? 'No preview'}</p>
}

function recoveredSource() {
  let requests = 0
  window.fetch = Object.assign(
    async () => {
      requests += 1
      return Response.json({ href: url, title: 'Recovered source' })
    },
    { preconnect: originalFetch.preconnect },
  )
  return () => requests
}

function clientWith(data: { href: string; title: string } | null, age: number) {
  const client = new QueryClient({
    defaultOptions: { queries: { gcTime: Infinity } },
  })
  client.setQueryData(linkMetadataQueryKey(url), data, {
    updatedAt: Date.now() - age,
  })
  return client
}

test('a missing preview can recover after the five-minute negative cache expires', async () => {
  const requests = recoveredSource()
  const client = clientWith(null, 5 * 60_000 + 1000)
  const { container } = await render(
    <QueryClientProvider client={client}>
      <Metadata />
    </QueryClientProvider>,
  )
  await waitFor(() => container.textContent.includes('Recovered source'))
  expect(requests()).toBe(1)
  expect(client.getQueryData(linkMetadataQueryKey(url))).toMatchObject({
    title: 'Recovered source',
  })
})

test('a missing preview remains cached inside the server negative-cache window', async () => {
  const requests = recoveredSource()
  const client = clientWith(null, 4 * 60_000)
  const { container } = await render(
    <QueryClientProvider client={client}>
      <Metadata />
    </QueryClientProvider>,
  )
  expect(container.textContent).toBe('No preview')
  expect(requests()).toBe(0)
})

test('a successful preview keeps its longer freshness window', async () => {
  const requests = recoveredSource()
  const client = clientWith({ href: url, title: 'Cached source' }, 6 * 60_000)
  const { container } = await render(
    <QueryClientProvider client={client}>
      <Metadata />
    </QueryClientProvider>,
  )
  expect(container.textContent).toBe('Cached source')
  expect(requests()).toBe(0)
})
