import { afterEach, expect, test } from 'bun:test'
import { act } from 'react'
import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
} from '@assistant-ui/react'
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
    messages,
    isRunning: false,
    onNew: async () => {},
    convertMessage: (message: ThreadMessageLike) => message,
    adapters: {
      threadList: {
        threadId: 'story-citations',
        threads: [
          {
            status: 'regular',
            id: 'story-citations',
            remoteId: 'thread_citations',
          },
        ],
      },
    },
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
afterEach(cleanup)

/** Links in the conversation; the composer's editor keeps a link preview of its own. */
const links = (container: HTMLElement) =>
  container.querySelectorAll('[data-role] a')

function storedCitation(
  url?: string,
  sourceKind: string | undefined = 'document',
  excerpt = 'A retrieved comparison excerpt.',
) {
  return {
    schema: 'theorem.chat.message.v1',
    messageId: 'search-answer',
    tenantId: 'tenant',
    threadId: 'thread',
    originBranchId: 'branch',
    role: 'assistant',
    createdAtMs: 1,
    parts: [
      {
        partId: 'answer',
        type: 'text',
        payload: { text: 'Here is what I found.' },
      },
      {
        partId: 'source-1',
        type: 'citation',
        payload: {
          sourceId: 'hit-1',
          sourceKind,
          label: 'Browser comparison',
          provenance: { url, excerpt },
        },
      },
    ],
  } satisfies Theorem.Message
}

for (const sourceKind of ['web_search', 'web_read']) {
  test(`a ${sourceKind} source draws as a preview or the Sources row, never a chip`, async () => {
    const client = new QueryClient()
    client.setQueryData(
      ['theorem', 'link-preview', 'https://example.com/browsers'],
      {
        href: 'https://example.com/browsers',
        title: 'Browser comparison',
        siteName: 'Example',
      },
    )
    const stored = storedCitation('https://example.com/browsers', sourceKind)
    const { container } = await render(
      <Harness messages={toAssistantMessages([stored])} client={client} />,
    )
    const preview = await waitFor(() =>
      container.querySelector('[data-slot="link-preview"]'),
    )
    expect(preview.textContent).toContain('Browser comparison')
    expect(container.querySelector('[data-slot="sources-row"]')).toBeNull()
  })
}

// The pure URL contract covers every rejected scheme/relative form. These
// representative states verify the same boundary in the interactive fallback.
for (const url of ['javascript:alert(1)', undefined]) {
  test(`a source with an unsafe or missing URL stays listed without a link: ${url}`, async () => {
    const { container } = await render(
      <Harness messages={toAssistantMessages([storedCitation(url)])} />,
    )
    const row = await waitFor(() =>
      container.querySelector('[data-slot="sources-row"]'),
    )
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
  client.setQueryData(
    ['theorem', 'link-preview', 'http://example.com/source'],
    {
      href: 'http://example.com/source',
      title: 'Browser comparison — Example',
      description: 'A comparison of browsers.',
      siteName: 'Example',
    },
  )
  const stored = storedCitation('http://example.com/source', 'document')
  const { container } = await render(
    <Harness messages={toAssistantMessages([stored])} client={client} />,
  )
  const preview = await waitFor(() =>
    container.querySelector('[data-slot="link-preview"]'),
  )
  expect(preview.textContent).toContain('Browser comparison — Example')
  // The page's own description leads; the passage stays in the Sources dropdown.
  expect(preview.textContent).toContain('A comparison of browsers.')
  const link = preview.querySelector('a[href="http://example.com/source"]')!
  expect(link.getAttribute('href')).toBe('http://example.com/source')
  // No Sources row while every source resolved.
  expect(container.querySelector('[data-slot="sources-row"]')).toBeNull()
})

test('a resolved preview keeps the passage and source actions reachable', async () => {
  const client = new QueryClient()
  client.setQueryData(
    ['theorem', 'link-preview', 'http://example.com/source'],
    {
      href: 'http://example.com/source',
      title: 'Browser comparison — Example',
      description: 'The page’s own description.',
      siteName: 'Example',
    },
  )
  const stored = storedCitation('http://example.com/source', 'document')
  const { container } = await render(
    <Harness messages={toAssistantMessages([stored])} client={client} />,
  )
  await waitFor(() => container.querySelector('[data-slot="link-preview"]'))
  // The page description leads the card, but the supporting passage and the
  // actions are still present beside it.
  const actions = container.querySelector('[data-slot="source-actions"]')
  expect(actions).not.toBeNull()
  expect(actions?.textContent).toContain('A retrieved comparison excerpt.')
  expect(actions?.textContent).toContain('Add to context')
  expect(actions?.textContent).toContain('Copy passage')
})

test('GFM renders supplied Markdown URLs but does not guess URLs for plain source labels', async () => {
  const { container } = await render(
    <Harness
      messages={[
        {
          id: 'markdown',
          role: 'assistant',
          content: [
            {
              type: 'text',
              text: '[PCMag] and [Mozilla](https://www.mozilla.org/)',
            },
          ],
        },
      ]}
    />,
  )
  const link = await waitFor(() =>
    container.querySelector('a[href="https://www.mozilla.org/"]'),
  )
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
  const row = await waitFor(() =>
    container.querySelector('[data-slot="sources-row"]'),
  )
  expect(row.textContent).toContain('(1)')
})

test('Add to context hands the passage to the composer as a message reference', async () => {
  const { useComposerReferences } = await import('./composer-references')
  useComposerReferences.setState({ references: [] })
  const stored = storedCitation('https://example.com/browsers', 'document')
  const { container } = await render(
    <Harness messages={toAssistantMessages([stored])} />,
  )
  const row = await waitFor(() =>
    container.querySelector('[data-slot="sources-row"]'),
  )
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
  expect(JSON.parse(references[0]!.excerpt!)).toMatchObject({
    schema: 'theorem.citation-context.v1',
    citation: {
      sourceId: 'hit-1',
      url: 'https://example.com/browsers',
      passages: [{ excerpt: 'A retrieved comparison excerpt.' }],
    },
  })
  expect(references[0]?.location.resource).toEqual({
    kind: 'message',
    threadId: 'thread_citations',
    messageId: 'search-answer',
  })
  useComposerReferences.setState({ references: [] })
})

test('source IDs containing delimiters remain in the fallback', async () => {
  const stored = storedCitation(undefined, 'document')
  const citation = stored.parts[1]!
  if (citation.type === 'citation')
    citation.payload.sourceId = 'paper|revision:1'
  const { container } = await render(
    <Harness messages={toAssistantMessages([stored])} />,
  )
  const row = await waitFor(() =>
    container.querySelector('[data-slot="sources-row"]'),
  )
  expect(row.textContent).toContain('(1)')
  await act(async () => {
    row
      .querySelector('button[aria-label="List sources"]')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  const entry = await waitFor(() =>
    document.querySelector('[data-slot="source-entry"]'),
  )
  expect(entry.getAttribute('data-source-id')).toBe('paper|revision:1')
  // Sources is a dialog containing normal links and buttons, not a command
  // menu whose roving arrow-key focus skips passage/context controls.
  expect(entry.closest('[role="dialog"]')).not.toBeNull()
  expect(
    [...entry.querySelectorAll<HTMLButtonElement>('button')].every(
      (button) => button.tabIndex === 0,
    ),
  ).toBe(true)
})

test('streaming enriches one source, preserves its focused fallback, and reload retains its passages', async () => {
  const client = new QueryClient()
  client.setQueryData(
    ['theorem', 'link-preview', 'https://example.com/browsers'],
    {
      href: 'https://example.com/browsers',
      title: 'Browser comparison',
      siteName: 'Example',
    },
  )
  const initial = storedCitation(undefined, 'document', '')
  const { container, rerender, unmount } = await render(
    <Harness messages={toAssistantMessages([initial])} client={client} />,
  )
  const row = await waitFor(() =>
    container.querySelector('[data-slot="sources-row"]'),
  )
  await act(async () => {
    row
      .querySelector('button[aria-label="List sources"]')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  const originalEntry = await waitFor(() =>
    document.querySelector('[data-slot="source-entry"]'),
  )
  const add = [
    ...originalEntry.querySelectorAll<HTMLButtonElement>('button'),
  ].find((button) => button.textContent.includes('Add to context'))!
  await act(async () => add.focus())

  const complete: Theorem.Message = {
    ...initial,
    parts: [
      ...initial.parts,
      {
        partId: 'source-later',
        type: 'citation',
        payload: {
          sourceId: 'hit-1',
          sourceKind: 'document',
          label: 'Browser comparison',
          provenance: {
            url: 'https://example.com/browsers',
            excerpt: 'First exact passage.',
            page: 1,
          },
        },
      },
      {
        partId: 'source-final',
        type: 'citation',
        payload: {
          sourceId: 'hit-1',
          sourceKind: 'document',
          label: 'Browser comparison',
          provenance: {
            url: 'https://example.com/browsers',
            excerpt: 'Second exact passage.',
            page: 2,
          },
        },
      },
    ],
  }
  await rerender(
    <Harness messages={toAssistantMessages([complete])} client={client} />,
  )
  await waitFor(() => container.querySelector('[data-slot="link-preview"]'))
  expect(container.querySelectorAll('[data-slot="link-preview"]')).toHaveLength(
    1,
  )
  const enrichedEntry = document.querySelector('[data-slot="source-entry"]')!
  expect(enrichedEntry).toBe(originalEntry)
  expect(document.activeElement).toBe(add)
  expect(
    enrichedEntry.querySelectorAll('[data-slot="source-passage"]'),
  ).toHaveLength(2)
  expect(enrichedEntry.textContent).toContain('First exact passage.')
  expect(enrichedEntry.textContent).toContain('Second exact passage.')
  expect(enrichedEntry.querySelector('a')?.getAttribute('href')).toBe(
    'https://example.com/browsers',
  )

  // A fresh runtime reconstructed from the stored transcript has the same
  // one source and the same evidence; no supplemental source store is needed.
  await unmount()
  const reloaded = await render(
    <Harness
      messages={toAssistantMessages([JSON.parse(JSON.stringify(complete))])}
      client={client}
    />,
  )
  await waitFor(() =>
    reloaded.container.querySelector('[data-slot="link-preview"]'),
  )
  expect(
    reloaded.container.querySelectorAll('[data-slot="link-preview"]'),
  ).toHaveLength(1)
  expect(
    reloaded.container.querySelectorAll('[data-slot="source-passage"]'),
  ).toHaveLength(2)
  expect(
    reloaded.container.querySelector('[data-slot="sources-row"]'),
  ).toBeNull()
})

test('every supporting passage opens in full and Escape returns to its trigger', async () => {
  const excerpt = 'Exact supporting text. '.repeat(12)
  const stored = storedCitation(undefined, 'document', excerpt)
  const { container } = await render(
    <Harness messages={toAssistantMessages([stored])} />,
  )
  const row = await waitFor(() =>
    container.querySelector('[data-slot="sources-row"]'),
  )
  await act(async () => {
    row
      .querySelector('button[aria-label="List sources"]')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  const trigger = await waitFor(() =>
    document.querySelector<HTMLButtonElement>(
      'button[aria-label="Read the supporting passage of Browser comparison"]',
    ),
  )
  expect(trigger.textContent).not.toBe(excerpt)
  await act(async () => {
    trigger.focus()
    trigger.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  const passage = await waitFor(() =>
    document.querySelector<HTMLElement>('blockquote'),
  )
  expect(passage.textContent).toBe(excerpt)
  expect(passage.tabIndex).toBe(0)
  await act(async () => {
    passage.focus()
    passage.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      }),
    )
  })
  await waitFor(() => !document.querySelector('blockquote'))
  await waitFor(() => document.activeElement === trigger)
  expect(document.querySelector('[data-slot="source-entry"]')).not.toBeNull()
})
