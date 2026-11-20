import { afterEach, expect, test } from 'bun:test'
import { act } from 'react'
import { AssistantRuntimeProvider, useExternalStoreRuntime } from '@assistant-ui/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { toAssistantMessages } from '@theoremharness/sdk/assistant-ui'
import type { ThreadMessageLike } from '@assistant-ui/react'
import type { Theorem } from '@/lib/theorem/client'
import { Thread } from '../assistant-ui/elements/thread.aui'
import { TheoremPartRenderers } from './theorem-parts'
import { cleanup, render, waitFor } from '../../../test/blocks/render'

const queryClient = new QueryClient()
function Harness({
  messages,
  client = queryClient,
}: {
  messages: ThreadMessageLike[]
  client?: QueryClient
}) {
  const runtime = useExternalStoreRuntime({
    messages, isRunning: false, onNew: async () => {},
    convertMessage: (message: ThreadMessageLike) => message,
    adapters: {
      threadList: {
        threadId: 'story-citations',
        threads: [{ status: 'regular', id: 'story-citations', remoteId: 'thread_citations' }],
      },
    },
  })
  return <QueryClientProvider client={client}>
    <AssistantRuntimeProvider runtime={runtime}>
      <TheoremPartRenderers />
      <Thread autoFocus={false} />
    </AssistantRuntimeProvider>
  </QueryClientProvider>
}
afterEach(cleanup)

/** Links in the conversation; the composer's editor keeps a link preview of its own. */
const links = (container: HTMLElement) => container.querySelectorAll('[data-role] a')

function storedCitation(
  url?: string,
  sourceKind: string | undefined = 'document',
  excerpt = 'A retrieved comparison excerpt.',
) {
  return {
    schema: 'theorem.chat.message.v1', messageId: 'search-answer', tenantId: 'tenant',
    threadId: 'thread', originBranchId: 'branch', role: 'assistant', createdAtMs: 1,
    parts: [
      { partId: 'answer', type: 'text', payload: { text: 'Here is what I found.' } },
      { partId: 'source-1', type: 'citation', payload: {
        sourceId: 'hit-1', sourceKind, label: 'Browser comparison',
        provenance: { url, excerpt },
      } },
    ],
  } satisfies Theorem.Message
}

for (const sourceKind of ['web_search', 'web_read']) {
  test(`a ${sourceKind} source draws as a preview or the Sources row, never a chip`, async () => {
    const client = new QueryClient()
    client.setQueryData(['theorem', 'link-preview', 'https://example.com/browsers'], {
      href: 'https://example.com/browsers',
      title: 'Browser comparison',
      siteName: 'Example',
    })
    const stored = storedCitation('https://example.com/browsers', sourceKind)
    const { container } = await render(
      <Harness messages={toAssistantMessages([stored])} client={client} />,
    )
    const preview = await waitFor(() => container.querySelector('[data-slot="link-preview"]'))
    expect(preview.textContent).toContain('Browser comparison')
    expect(container.querySelector('[data-slot="sources-row"]')).toBeNull()
  })
}

for (const url of ['javascript:alert(1)', 'data:text/html,bad', 'file:///etc/passwd', '//example.com', '/relative', 'not a URL', undefined]) {
  test(`a source with an unsafe or missing URL stays listed without a link: ${url}`, async () => {
    const { container } = await render(<Harness messages={toAssistantMessages([storedCitation(url)])} />)
    const row = await waitFor(() => container.querySelector('[data-slot="sources-row"]'))
    expect(row.textContent).toContain('Sources')
    expect(links(container).length).toBe(0)
    // The dropdown lists the source by label, with no navigation.
    const trigger = row.querySelector('button[aria-label="List sources"]')!
    await act(async () => {
      trigger.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await waitFor(() => document.querySelector('[data-slot="source-entry"]'))
    expect(document.body.textContent).toContain('Browser comparison')
    expect(document.querySelector('a[href]')).toBeNull()
  })
}

test('a resolved source draws a full link preview, not a chip', async () => {
  const client = new QueryClient()
  client.setQueryData(['theorem', 'link-preview', 'http://example.com/source'], {
    href: 'http://example.com/source',
    title: 'Browser comparison — Example',
    description: 'A comparison of browsers.',
    siteName: 'Example',
  })
  const stored = storedCitation('http://example.com/source', 'document')
  const { container } = await render(
    <Harness messages={toAssistantMessages([stored])} client={client} />,
  )
  const preview = await waitFor(() => container.querySelector('[data-slot="link-preview"]'))
  expect(preview.textContent).toContain('Browser comparison — Example')
  // The page's own description leads; the passage stays in the Sources dropdown.
  expect(preview.textContent).toContain('A comparison of browsers.')
  const link = preview.querySelector('a[href="http://example.com/source"]')!
  expect(link.getAttribute('href')).toBe('http://example.com/source')
  // No Sources row while every source resolved.
  expect(container.querySelector('[data-slot="sources-row"]')).toBeNull()
})

test('GFM renders supplied Markdown URLs but does not guess URLs for plain source labels', async () => {
  const { container } = await render(<Harness messages={[{
    id: 'markdown', role: 'assistant', content: [{ type: 'text', text: '[PCMag] and [Mozilla](https://www.mozilla.org/)' }],
  }]} />)
  const link = await waitFor(() => container.querySelector('a[href="https://www.mozilla.org/"]'))
  expect(link.textContent).toBe('Mozilla')
  expect(container.textContent).toContain('[PCMag]')
  expect(links(container)).toHaveLength(1)
})

test('two citations of one source draw one preview; the passage stays inspectable', async () => {
  const stored = storedCitation('https://example.com/browsers', 'document')
  stored.parts.push({
    partId: 'source-2',
    type: 'citation',
    payload: {
      sourceId: 'hit-1',
      sourceKind: 'document',
      label: 'Browser comparison',
      provenance: {
        url: 'https://example.com/browsers',
        excerpt: 'A retrieved comparison excerpt.',
      },
    },
  })
  const { container } = await render(
    <Harness messages={toAssistantMessages([stored])} />,
  )
  const row = await waitFor(() => container.querySelector('[data-slot="sources-row"]'))
  expect(row.textContent).toContain('(1)')
})

test('Add to context hands the passage to the composer as a message reference', async () => {
  const { useComposerReferences } = await import('./composer-references')
  useComposerReferences.setState({ references: [] })
  const stored = storedCitation('https://example.com/browsers', 'document')
  const { container } = await render(
    <Harness messages={toAssistantMessages([stored])} />,
  )
  const row = await waitFor(() => container.querySelector('[data-slot="sources-row"]'))
  const trigger = row.querySelector('button[aria-label="List sources"]')!
  await act(async () => {
    trigger.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  const add = await waitFor(() =>
    [...document.querySelectorAll('button, [role="menuitem"]')].find((button) =>
      button.textContent.includes('Add to context'),
    ),
  )
  await act(async () => {
    add.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  const references = useComposerReferences.getState().references
  expect(references).toHaveLength(1)
  expect(references[0]?.excerpt).toBe('A retrieved comparison excerpt.')
  expect(references[0]?.location.resource.kind).toBe('message')
  useComposerReferences.setState({ references: [] })
})
