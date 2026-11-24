import { afterEach, expect, spyOn, test } from 'bun:test'
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

for (const media of [
  {
    kind: 'absolute',
    image: 'https://images.example.com/tracker.png',
    favicon: 'http://icons.example.com/tracker.ico',
  },
  {
    kind: 'protocol-relative',
    image: '//images.example.com/tracker.png',
    favicon: '//icons.example.com/tracker.ico',
  },
  {
    kind: 'relative',
    image: '/tracker.png',
    favicon: './tracker.ico',
  },
]) {
  test(`${media.kind} preview media cannot create automatic browser requests`, async () => {
    const client = new QueryClient()
    client.setQueryData(
      ['theorem', 'link-preview', 'https://example.com/source'],
      {
        href: 'https://example.com/source',
        title: 'Browser comparison — Example',
        description: 'The page’s own description.',
        siteName: 'Example',
        image: media.image,
        favicon: media.favicon,
      },
    )
    const { container } = await render(
      <Harness
        messages={toAssistantMessages([
          storedCitation('https://example.com/source', 'document'),
        ])}
        client={client}
      />,
    )
    const preview = await waitFor(() =>
      container.querySelector('[data-slot="link-preview"]'),
    )
    expect(preview.querySelectorAll('img')).toHaveLength(0)
    expect(preview.textContent).toContain('Browser comparison — Example')
    expect(preview.textContent).toContain('The page’s own description.')
    expect(
      preview.querySelector('[data-slot="link-preview-site-initial"]')
        ?.textContent,
    ).toBe('E')
    expect(preview.querySelector('a')?.getAttribute('href')).toBe(
      'https://example.com/source',
    )
    const actions = container.querySelector('[data-slot="source-actions"]')
    expect(actions?.textContent).toContain('A retrieved comparison excerpt.')
    expect(actions?.textContent).toContain('Add to context')
  })
}

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

for (const scenario of [
  {
    name: 'two anonymous passages remain separate composer references after reload',
    citations: [
      { provenance: { excerpt: 'First anonymous passage.' } },
      { provenance: { excerpt: 'Second anonymous passage.' } },
    ],
    passages: [['First anonymous passage.'], ['Second anonymous passage.']],
  },
  {
    name: 'a reused URL retains distinct composer references after reload',
    citations: [
      {
        label: 'Original source',
        provenance: {
          url: 'https://example.com/original',
          excerpt: 'Initial evidence.',
        },
      },
      {
        sourceId: 'moving-source',
        provenance: { url: 'https://example.com/original' },
      },
      {
        sourceId: 'moving-source',
        provenance: {
          url: 'https://example.com/updated',
          excerpt: 'Updated evidence.',
        },
      },
      {
        label: 'New source at the original URL',
        provenance: {
          url: 'https://example.com/original',
          excerpt: 'Independent evidence.',
        },
      },
    ],
    passages: [
      ['Initial evidence.', 'Updated evidence.'],
      ['Independent evidence.'],
    ],
  },
  {
    name: 'ambiguous URL-only evidence remains a separate composer reference after reload',
    citations: [
      {
        sourceId: 'first-document',
        label: 'First document',
        provenance: {
          url: 'https://example.com/shared?edition=1#evidence',
          excerpt: 'First identified evidence.',
        },
      },
      {
        sourceId: 'second-document',
        label: 'Second document',
        provenance: {
          url: 'https://example.com/shared?edition=1#evidence',
          excerpt: 'Second identified evidence.',
        },
      },
      {
        label: 'Unattributed document',
        provenance: {
          url: 'https://example.com/shared?edition=1#evidence',
          excerpt: 'Unattributed evidence.',
        },
      },
      {
        label: 'Unattributed document',
        provenance: {
          url: 'https://example.com/shared?edition=1#evidence',
          excerpt: 'More unattributed evidence.',
        },
      },
      {
        sourceId: 'third-document',
        label: 'Third document',
        provenance: {
          url: 'https://example.com/shared?edition=1#evidence',
          excerpt: 'Third identified evidence.',
        },
      },
    ],
    passages: [
      ['First identified evidence.'],
      ['Second identified evidence.'],
      ['Unattributed evidence.', 'More unattributed evidence.'],
      ['Third identified evidence.'],
    ],
  },
  {
    name: 'later ambiguity keeps earlier anonymous passages out of explicit composer references after reload',
    initialCount: 2,
    citations: [
      {
        sourceId: 'first-document',
        label: 'First document',
        provenance: {
          url: 'https://example.com/shared',
          excerpt: 'First identified evidence.',
        },
      },
      {
        label: 'Unattributed document',
        provenance: {
          url: 'https://example.com/shared',
          excerpt: 'Unattributed evidence.',
        },
      },
      {
        sourceId: 'second-document',
        label: 'Second document',
        provenance: {
          url: 'https://example.com/shared',
          excerpt: 'Second identified evidence.',
        },
      },
      {
        label: 'Unattributed document',
        provenance: {
          url: 'https://example.com/shared',
          excerpt: 'More unattributed evidence.',
        },
      },
    ],
    passages: [
      ['First identified evidence.'],
      ['Unattributed evidence.', 'More unattributed evidence.'],
      ['Second identified evidence.'],
    ],
  },
]) {
  const { name, citations, passages } = scenario
  test(name, async () => {
    const { referenceKey, useComposerReferences } =
      await import('./composer-references')
    useComposerReferences.setState({ references: [] })
    const client = new QueryClient()
    for (const citation of citations) {
      if ('url' in citation.provenance)
        client.setQueryData(
          ['theorem', 'link-preview', citation.provenance.url],
          null,
        )
    }
    const content = citations.map((data) => ({
      type: 'data' as const,
      name: 'theorem-citation',
      data,
    }))
    const messages: ThreadMessageLike[] = [
      { id: 'source-evidence', role: 'assistant', content },
    ]
    const initialMessages: ThreadMessageLike[] =
      'initialCount' in scenario
        ? [
            {
              ...messages[0]!,
              content: content.slice(0, scenario.initialCount),
            },
          ]
        : messages
    const referencePassages = () =>
      useComposerReferences
        .getState()
        .references.map((reference) =>
          JSON.parse(reference.excerpt!).citation.passages.map(
            (passage: { excerpt: string }) => passage.excerpt,
          ),
        )
    try {
      const { container, unmount, rerender } = await render(
        <Harness messages={initialMessages} client={client} />,
      )
      const trigger = await waitFor(() =>
        container.querySelector('button[aria-label="List sources"]'),
      )
      await act(async () =>
        trigger.dispatchEvent(new MouseEvent('click', { bubbles: true })),
      )
      await waitFor(() => document.querySelector('[data-slot="source-entry"]'))
      if ('initialCount' in scenario) {
        const entries = document.querySelectorAll('[data-slot="source-entry"]')
        expect(entries).toHaveLength(1)
        expect(entries[0]!.textContent).toContain('Unattributed evidence.')
        await rerender(<Harness messages={messages} client={client} />)
        await waitFor(
          () =>
            document.querySelectorAll('[data-slot="source-entry"]').length ===
            passages.length,
        )
      }
      const addAll = async () => {
        const entries = document.querySelectorAll('[data-slot="source-entry"]')
        expect(entries).toHaveLength(passages.length)
        for (const entry of entries) {
          const add = [...entry.querySelectorAll('button')].find((button) =>
            button.textContent.includes('Add to context'),
          )!
          await act(async () =>
            add.dispatchEvent(new MouseEvent('click', { bubbles: true })),
          )
        }
      }
      await addAll()
      const originalKeys = useComposerReferences
        .getState()
        .references.map(referenceKey)
      expect(originalKeys).toHaveLength(passages.length)
      expect(new Set(originalKeys).size).toBe(passages.length)
      expect(referencePassages()).toEqual(passages)

      await unmount()
      expect(trigger.isConnected).toBe(false)
      expect(document.querySelector('[data-slot="source-entry"]')).toBeNull()
      await act(async () => useComposerReferences.setState({ references: [] }))
      expect(useComposerReferences.getState().references).toHaveLength(0)
      const reloaded = await render(
        <Harness
          messages={JSON.parse(JSON.stringify(messages))}
          client={client}
        />,
      )
      const reloadedTrigger = await waitFor(() =>
        reloaded.container.querySelector('button[aria-label="List sources"]'),
      )
      expect(reloadedTrigger).not.toBe(trigger)
      await act(async () =>
        reloadedTrigger.dispatchEvent(
          new MouseEvent('click', { bubbles: true }),
        ),
      )
      await waitFor(() => document.querySelector('[data-slot="source-entry"]'))
      await addAll()
      const references = useComposerReferences.getState().references
      expect(references).toHaveLength(passages.length)
      expect(references.map(referenceKey)).toEqual(originalKeys)
      expect(referencePassages()).toEqual(passages)
      await addAll()
      expect(useComposerReferences.getState().references).toEqual(references)
    } finally {
      await act(async () => useComposerReferences.setState({ references: [] }))
    }
  })
}

test('a source that arrives while Sources is open retains its focused fallback after metadata resolves', async () => {
  const client = new QueryClient()
  const url = 'https://example.com/streamed-paper'
  client.setQueryData(['theorem', 'link-preview', url], null)
  const initial = storedCitation(undefined, 'document', 'Initial evidence.')
  const { container, rerender } = await render(
    <Harness messages={toAssistantMessages([initial])} client={client} />,
  )
  const trigger = await waitFor(() =>
    container.querySelector('button[aria-label="List sources"]'),
  )
  await act(async () =>
    trigger.dispatchEvent(new MouseEvent('click', { bubbles: true })),
  )
  await waitFor(() => document.querySelector('[data-slot="source-entry"]'))
  const streamed: Theorem.Message = {
    ...initial,
    parts: [
      ...initial.parts,
      {
        partId: 'source-arriving-later',
        type: 'citation',
        payload: {
          sourceId: 'streamed-paper',
          sourceKind: 'document',
          label: 'Streamed research paper',
          provenance: { url, excerpt: 'The newly arriving exact passage.' },
        },
      },
    ],
  }
  await rerender(
    <Harness messages={toAssistantMessages([streamed])} client={client} />,
  )
  const entry = await waitFor(() =>
    document.querySelector(
      '[data-slot="source-entry"][data-source-id="streamed-paper"]',
    ),
  )
  const add = [...entry.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.textContent.includes('Add to context'),
  )!
  await act(async () => add.focus())
  await act(async () =>
    client.setQueryData(['theorem', 'link-preview', url], {
      href: url,
      title: 'Streamed research paper',
      siteName: 'Example',
    }),
  )
  await waitFor(() => container.querySelector('[data-slot="link-preview"]'))
  expect(
    document.querySelector(
      '[data-slot="source-entry"][data-source-id="streamed-paper"]',
    ) === entry,
  ).toBe(true)
  expect(document.activeElement).toBe(add)
  expect(entry.textContent).toContain('The newly arriving exact passage.')
  await act(async () =>
    add.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      }),
    ),
  )
  await waitFor(() => !document.querySelector('[data-slot="source-entry"]'))
  await act(async () =>
    trigger.dispatchEvent(new MouseEvent('click', { bubbles: true })),
  )
  await waitFor(() => document.querySelector('[data-slot="source-entry"]'))
  expect(document.querySelectorAll('[data-slot="source-entry"]')).toHaveLength(
    1,
  )
  expect(
    document.querySelector(
      '[data-slot="source-entry"][data-source-id="streamed-paper"]',
    ),
  ).toBeNull()
})

for (const action of [
  'retain until blur',
  'open retained trigger',
  'focus already elsewhere',
] as const) {
  test(`closed Sources row preserves focus when metadata resolves: ${action}`, async () => {
    const client = new QueryClient()
    const url = 'https://example.com/closed-source'
    client.setQueryData(['theorem', 'link-preview', url], null)
    const { container } = await render(
      <>
        <Harness
          messages={toAssistantMessages([storedCitation(url)])}
          client={client}
        />
        <button type="button" data-testid="outside-source-control">
          Outside control
        </button>
      </>,
    )
    const trigger = await waitFor(() =>
      container.querySelector<HTMLButtonElement>(
        'button[aria-label="List sources"]',
      ),
    )
    const outside = container.querySelector<HTMLButtonElement>(
      '[data-testid="outside-source-control"]',
    )!
    await act(async () => trigger.focus())
    if (action === 'focus already elsewhere')
      await act(async () => outside.focus())
    await act(async () =>
      client.setQueryData(['theorem', 'link-preview', url], {
        href: url,
        title: 'Resolved while closed',
        siteName: 'Example',
      }),
    )
    const preview = await waitFor(() =>
      container.querySelector<HTMLAnchorElement>(
        '[data-slot="link-preview"] a',
      ),
    )
    if (action === 'focus already elsewhere') {
      await waitFor(() => !container.querySelector('[data-slot="sources-row"]'))
      expect(document.activeElement === outside).toBe(true)
      return
    }
    expect(trigger.isConnected).toBe(true)
    expect(document.activeElement === trigger).toBe(true)
    expect(document.querySelector('[data-slot="source-entry"]')).toBeNull()
    if (action === 'retain until blur') {
      await act(async () => outside.focus())
      await waitFor(() => !container.querySelector('[data-slot="sources-row"]'))
      expect(document.activeElement === outside).toBe(true)
    } else {
      await act(async () =>
        trigger.dispatchEvent(new MouseEvent('click', { bubbles: true })),
      )
      await waitFor(() => document.querySelector('[data-slot="source-entry"]'))
      await act(async () => {
        trigger.focus()
        trigger.dispatchEvent(
          new MouseEvent('click', { bubbles: true, detail: 1 }),
        )
      })
      await waitFor(() => !container.querySelector('[data-slot="sources-row"]'))
      await waitFor(() => document.activeElement === preview)
    }
  })
}

for (const close of ['Escape', 'trigger click', 'outside click'] as const) {
  test(`${close} preserves focus when the resolved Sources trigger disappears`, async () => {
    const client = new QueryClient()
    const url = 'https://example.com/recovering-fallback'
    const firstUrl = 'https://example.com/first-fallback'
    client.setQueryData(['theorem', 'link-preview', url], null)
    client.setQueryData(['theorem', 'link-preview', firstUrl], null)
    const stored = storedCitation(url, 'document', 'Exact recovering evidence.')
    stored.parts.splice(1, 0, {
      partId: 'first-fallback-source',
      type: 'citation',
      payload: {
        sourceId: 'first-fallback',
        sourceKind: 'document',
        label: 'First unresolved paper',
        provenance: { url: firstUrl, excerpt: 'Earlier evidence.' },
      },
    })
    const { container } = await render(
      <>
        <Harness messages={toAssistantMessages([stored])} client={client} />
        <button type="button" data-testid="outside-source-control">
          Outside control
        </button>
      </>,
    )
    const trigger = await waitFor(() =>
      container.querySelector<HTMLButtonElement>(
        'button[aria-label="List sources"]',
      ),
    )
    await act(async () => trigger.focus())
    await act(async () =>
      trigger.dispatchEvent(new MouseEvent('click', { bubbles: true })),
    )
    const entry = await waitFor(() =>
      document.querySelector(
        '[data-slot="source-entry"][data-source-id="hit-1"]',
      ),
    )
    expect(
      [...document.querySelectorAll('[data-slot="source-entry"]')].map(
        (source) => source.getAttribute('data-source-id'),
      ),
    ).toEqual(['first-fallback', 'hit-1'])
    const add = [...entry.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent.includes('Add to context'),
    )!
    await act(async () => add.focus())
    await act(async () => {
      client.setQueryData(['theorem', 'link-preview', url], {
        href: url,
        title: 'Recovered source',
        siteName: 'Example',
      })
      client.setQueryData(['theorem', 'link-preview', firstUrl], {
        href: firstUrl,
        title: 'First recovered source',
        siteName: 'Example',
      })
    })
    const resolvedLink = await waitFor(() =>
      container.querySelector<HTMLAnchorElement>(
        '[data-source-id="hit-1"] [data-slot="link-preview"] a',
      ),
    )
    const firstResolvedLink = await waitFor(() =>
      container.querySelector<HTMLAnchorElement>(
        '[data-source-id="first-fallback"] [data-slot="link-preview"] a',
      ),
    )
    const outside = container.querySelector<HTMLButtonElement>(
      '[data-testid="outside-source-control"]',
    )!
    expect(document.activeElement === add).toBe(true)
    let expectedFocus: HTMLElement
    if (close === 'Escape') {
      expectedFocus = resolvedLink
      await act(async () =>
        add.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'Escape',
            bubbles: true,
            cancelable: true,
          }),
        ),
      )
    } else if (close === 'trigger click') {
      expectedFocus = firstResolvedLink
      await act(async () => {
        trigger.focus()
        trigger.dispatchEvent(
          new MouseEvent('click', { bubbles: true, detail: 1 }),
        )
      })
    } else {
      expectedFocus = outside
      await act(async () => {
        for (const event of ['pointerdown', 'mousedown'])
          outside.dispatchEvent(
            new MouseEvent(event, { bubbles: true, button: 0, detail: 1 }),
          )
        outside.focus()
        for (const event of ['pointerup', 'mouseup', 'click'])
          outside.dispatchEvent(
            new MouseEvent(event, { bubbles: true, button: 0, detail: 1 }),
          )
      })
    }
    await waitFor(() => !container.querySelector('[data-slot="sources-row"]'))
    await waitFor(() => document.activeElement === expectedFocus)
    expect(resolvedLink.href).toBe(url)
  })
}

/** The retained-capture wire PR #1138 emits, two fetches of one URL. */
const retainedSourceRef = (handle: string, version: string) => ({
  handle,
  version,
  extractionVersion: 'extractor/2',
  textBasis: 'utf8-extracted-text',
  textBytes: 4096,
  coverage: { status: 'complete' },
})
/** What an open route answers for a well-formed passage. */
const passageBody = {
  source: retainedSourceRef('source:first', 'blake3:v1'),
  span: { startByte: 0, endByte: 30 },
  excerpt: 'Passage from the first fetch.',
}
const retainedCitation = (
  partId: string,
  handle: string,
  version: string,
  excerpt: string,
  span: { startByte: number; endByte: number },
) => ({
  partId,
  type: 'citation',
  payload: {
    sourceId: `chatsource:retained:${handle}`,
    sourceKind: 'web_read',
    label: 'Shared page, two fetches',
    provenance: {
      url: 'https://example.com/shared',
      excerpt,
      fetchedAt: '1793890000000',
      contentHash: `blake3:${handle}`,
      truncated: false,
      source: retainedSourceRef(handle, version),
      span,
    },
  },
})

function storedMessage(...parts: Record<string, unknown>[]) {
  return {
    schema: 'theorem.chat.message.v1',
    messageId: 'research-answer',
    tenantId: 'tenant',
    threadId: 'thread',
    originBranchId: 'branch',
    role: 'assistant',
    runId: 'run-research',
    createdAtMs: 1,
    parts: [
      {
        partId: 'answer',
        type: 'text',
        payload: { text: 'Here is what I found.' },
      },
      ...parts,
    ],
  } as unknown as Parameters<typeof toAssistantMessages>[0][number]
}

test('two captures of one URL render one card each, labelled by their retained version', async () => {
  const client = new QueryClient()
  client.setQueryData(
    ['theorem', 'link-preview', 'https://example.com/shared'],
    {
      href: 'https://example.com/shared',
      title: 'Shared page',
      siteName: 'Example',
    },
  )
  const stored = storedMessage(
    retainedCitation(
      'cite-first',
      'source:first',
      'blake3:v1',
      'Passage from the first fetch.',
      { startByte: 0, endByte: 30 },
    ),
    retainedCitation(
      'cite-second',
      'source:second',
      'blake3:v2',
      'Passage from the second fetch.',
      { startByte: 210, endByte: 240 },
    ),
    {
      partId: 'cite-discovery',
      type: 'citation',
      payload: {
        sourceId: 'chatsource:run:call:snipped',
        sourceKind: 'web_search',
        label: 'A discovered page',
        provenance: {
          url: 'https://example.com/snippet',
          excerpt: 'Only a snippet was ever seen.',
        },
      },
    },
  )
  const { container } = await render(
    <Harness messages={toAssistantMessages([stored])} client={client} />,
  )
  // Metadata resolves only for the shared URL: the two captures draw full
  // preview cards, while the unresolved discovery stays in the Sources row.
  const listed = await waitFor(() => {
    const found = document.querySelectorAll('[data-source-key]')
    return found.length === 2 ? found : null
  })
  const captureCards = [...listed].map((card) => ({
    id: card.getAttribute('data-source-id'),
    text: card.textContent,
  }))
  expect(captureCards.map((card) => card.id)).toEqual([
    'chatsource:retained:source:first',
    'chatsource:retained:source:second',
  ])
  // Each capture card names its retained version in place.
  expect(captureCards[0]!.text).toContain('Retained capture')
  expect(captureCards[0]!.text).toContain('blake3:v1')
  expect(captureCards[1]!.text).toContain('Retained capture')
  expect(captureCards[1]!.text).toContain('blake3:v2')
  // The capture card pins the exact passage offsets beside the passage, in
  // half-open notation matching the end-exclusive wire.
  expect(container.textContent).toContain('[0, 30)')
  expect(container.textContent).toContain('[210, 240)')

  const trigger = await waitFor(() =>
    container.querySelector('button[aria-label="List sources"]'),
  )
  await act(async () =>
    trigger.dispatchEvent(new MouseEvent('click', { bubbles: true })),
  )
  const entry = await waitFor(() => {
    const found = document.querySelector('[data-slot="source-entry"]')
    return found &&
      found.getAttribute('data-source-id') === 'chatsource:run:call:snipped'
      ? found
      : null
  })
  // Discovery is visibly not a capture: labelled a snippet, no version.
  expect(entry.textContent).toContain('Search snippet')
  expect(entry.textContent).not.toContain('blake3:')
})

test('the retained-passage open is click-only, names durable ids, and surfaces authority answers instead of guessing', async () => {
  const calls: string[] = []
  // Only the citation route answers an open; the app's own bootstrapping
  // (models, tools, link previews) is not what this test guards.
  const opens = () =>
    calls.filter((url) => new URL(url).pathname.includes('/citations/'))
  const page = (
    window as unknown as { happyDOM: { setURL: (url: string) => void } }
  ).happyDOM
  page.setURL('http://localhost:3000/')
  const original = window.fetch
  window.fetch = ((input: RequestInfo | URL) => {
    calls.push(String(input instanceof Request ? input.url : input))
    return Promise.resolve(
      Response.json(
        {
          type: '/problems/cited_passage_unavailable',
          title: 'The cited passage is no longer available',
          status: 410,
          code: 'cited_passage_unavailable',
          correlationId: 'corr-1',
        },
        { status: 410 },
      ),
    )
  }) as typeof fetch
  const client = new QueryClient()
  // Seed the metadata the card would otherwise query: this test guards the
  // passage open, not the app's unrelated link-preview fetches.
  client.setQueryData(
    ['theorem', 'link-preview', 'https://example.com/shared'],
    null,
  )
  // The projection a newer SDK yields: the durable part ID rides the
  // assistant-ui part identity, exactly as Theorem #1150 preserves it.
  const message: ThreadMessageLike = {
    id: 'assistant-saved',
    role: 'assistant',
    content: [
      {
        type: 'data',
        id: 'cite-part-1',
        name: 'theorem-citation',
        data: {
          sourceId: 'chatsource:retained:source:first',
          sourceKind: 'web_read',
          label: 'Shared page',
          provenance: {
            url: 'https://example.com/shared',
            excerpt: 'Passage from the first fetch.',
            source: retainedSourceRef('source:first', 'blake3:v1'),
            span: { startByte: 0, endByte: 30 },
          },
        },
      },
    ],
  }
  try {
    const { container } = await render(
      <Harness messages={[message]} client={client} />,
    )
    // Reloading or rendering a Sources card opens no passage.
    expect(opens()).toEqual([])
    const trigger = await waitFor(() =>
      container.querySelector('button[aria-label="List sources"]'),
    )
    await act(async () =>
      trigger.dispatchEvent(new MouseEvent('click', { bubbles: true })),
    )
    const open = await waitFor(() => {
      const found = [...document.querySelectorAll('button')].find((button) =>
        button.textContent.includes('Open retained passage'),
      )
      return found ?? null
    })
    expect(opens()).toEqual([])
    await act(async () =>
      open.dispatchEvent(new MouseEvent('click', { bubbles: true })),
    )
    // One click, one request, the durable message and part ids.
    await waitFor(() => opens().length === 1)
    expect(new URL(opens()[0]!).pathname).toBe(
      '/api/chat/v1/threads/thread_citations/messages/assistant-saved/citations/cite-part-1',
    )
    const alert = await waitFor(() =>
      document.querySelector('[data-slot="open-passage-failure"]'),
    )
    // The server's 410 is the reader's answer: gone, not "no evidence".
    expect(alert.textContent).toContain('no longer available')
    expect(document.querySelector('[data-slot="opened-passage"]')).toBeNull()
    // Re-opening is still click-driven; no retry storm on a settled failure.
    const again = [...document.querySelectorAll('button')].find((button) =>
      button.textContent.includes('Open retained passage'),
    )!
    await act(async () =>
      again.dispatchEvent(new MouseEvent('click', { bubbles: true })),
    )
    await waitFor(() => opens().length === 2)
  } finally {
    window.fetch = original
    page.setURL('about:blank')
  }
})

test('the open control waits for the run to persist its message, then names the server ID, not the local one', async () => {
  const calls: string[] = []
  const opens = () =>
    calls.filter((url) => new URL(url).pathname.includes('/citations/'))
  const page = (
    window as unknown as { happyDOM: { setURL: (url: string) => void } }
  ).happyDOM
  page.setURL('http://localhost:3000/')
  const original = window.fetch
  window.fetch = ((input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input)
    calls.push(url)
    // Only the citation route answers here; unrelated app queries fail as
    // they do in the neighbouring tests, so the header renders without them.
    if (new URL(url).pathname.includes('/citations/'))
      return Promise.resolve(Response.json(passageBody))
    return Promise.resolve(
      Response.json({ code: 'fixture', status: 500 }, { status: 500 }),
    )
  }) as typeof fetch
  const client = new QueryClient()
  client.setQueryData(
    ['theorem', 'link-preview', 'https://example.com/shared'],
    null,
  )
  const citation: ThreadMessageLike['content'] = [
    {
      type: 'data',
      id: 'cite-part-1',
      name: 'theorem-citation',
      data: {
        sourceId: 'chatsource:retained:source:first',
        sourceKind: 'web_read',
        label: 'Shared page',
        provenance: {
          url: 'https://example.com/shared',
          excerpt: 'Passage from the first fetch.',
          source: retainedSourceRef('source:first', 'blake3:v1'),
          span: { startByte: 0, endByte: 30 },
        },
      },
    },
  ]
  try {
    // While the reply streams, the assistant-ui message id is local: the
    // adapter's per-step metadata (theoremCursor) marks that. No control,
    // no request aimed at a synthetic id.
    const streaming: ThreadMessageLike = {
      id: 'local-aui-uuid',
      role: 'assistant',
      content: citation,
      metadata: { custom: { theoremRunId: 'run-9', theoremCursor: 1 } },
    }
    const live = await render(
      <Harness messages={[streaming]} client={client} />,
    )
    const liveTrigger = await waitFor(() =>
      live.container.querySelector('button[aria-label="List sources"]'),
    )
    await act(async () =>
      liveTrigger.dispatchEvent(new MouseEvent('click', { bubbles: true })),
    )
    await waitFor(() => document.querySelector('[data-slot="source-entry"]'))
    expect(
      [...document.querySelectorAll('button')].some((button) =>
        button.textContent.includes('Open retained passage'),
      ),
    ).toBe(false)
    expect(opens()).toEqual([])
    await live.unmount()

    // The run persists: metadata now names the saved message. The control
    // opens against THAT durable id — not the assistant-ui local one.
    const persisted: ThreadMessageLike = {
      id: 'local-aui-uuid',
      role: 'assistant',
      content: citation,
      metadata: {
        custom: {
          theoremRunId: 'run-9',
          theoremCursor: 2,
          theoremMessageId: 'chatmsg_real',
        },
      },
    }
    const saved = await render(
      <Harness messages={[persisted]} client={client} />,
    )
    const savedTrigger = await waitFor(() =>
      saved.container.querySelector('button[aria-label="List sources"]'),
    )
    await act(async () =>
      savedTrigger.dispatchEvent(new MouseEvent('click', { bubbles: true })),
    )
    const open = await waitFor(() => {
      const found = [...document.querySelectorAll('button')].find((button) =>
        button.textContent.includes('Open retained passage'),
      )
      return found ?? null
    })
    await act(async () =>
      open.dispatchEvent(new MouseEvent('click', { bubbles: true })),
    )
    await waitFor(() => opens().length === 1)
    expect(new URL(opens()[0]!).pathname).toBe(
      '/api/chat/v1/threads/thread_citations/messages/chatmsg_real/citations/cite-part-1',
    )
    expect(saved.container.textContent).not.toContain('local-aui-uuid')
  } finally {
    window.fetch = original
    page.setURL('about:blank')
  }
})

test('with a projection that carries no part identity, no open control appears and nothing is fetched', async () => {
  const calls: string[] = []
  const opens = () =>
    calls.filter((url) => new URL(url).pathname.includes('/citations/'))
  const original = window.fetch
  window.fetch = ((input: RequestInfo | URL) => {
    calls.push(String(input instanceof Request ? input.url : input))
    return Promise.resolve(
      Response.json({ href: 'https://example.com/shared' }),
    )
  }) as typeof fetch
  const client = new QueryClient()
  client.setQueryData(
    ['theorem', 'link-preview', 'https://example.com/shared'],
    null,
  )
  // The vendored SDK hydrates citations without part ids: the control stays
  // absent instead of guessing a part, and the card never reaches the network.
  const stored = storedMessage(
    retainedCitation(
      'cite-first',
      'source:first',
      'blake3:v1',
      'Passage from the first fetch.',
      { startByte: 0, endByte: 30 },
    ),
  )
  try {
    const { container } = await render(
      <Harness messages={toAssistantMessages([stored])} client={client} />,
    )
    expect(calls).toEqual([])
    const trigger = await waitFor(() =>
      container.querySelector('button[aria-label="List sources"]'),
    )
    await act(async () =>
      trigger.dispatchEvent(new MouseEvent('click', { bubbles: true })),
    )
    const entry = await waitFor(() =>
      document.querySelector('[data-slot="source-entry"]'),
    )
    // The evidence label still distinguishes the capture; only the open
    // control is absent, because no part identity is known.
    expect(entry.textContent).toContain('Retained capture')
    expect(
      [...document.querySelectorAll('button')].some((button) =>
        button.textContent.includes('Open retained passage'),
      ),
    ).toBe(false)
    expect(opens()).toEqual([])
  } finally {
    window.fetch = original
  }
})

test('a reload of the durable message redraws the exact capture without any request, and Add to context keeps handle, version and span', async () => {
  const fetches: string[] = []
  const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async (
    input: RequestInfo | URL,
  ) => {
    fetches.push(String(input instanceof Request ? input.url : input))
    return Response.json({})
  }) as typeof fetch)
  const client = new QueryClient({
    // The cache must stay exactly as the durable history seeded it: no
    // background refetch may masquerade as the reload path under test.
    defaultOptions: { queries: { staleTime: Infinity, retry: false } },
  })
  client.setQueryData(
    ['theorem', 'link-preview', 'https://example.com/shared'],
    {
      href: 'https://example.com/shared',
      title: 'Shared page',
      siteName: 'Example',
    },
  )
  const stored = storedMessage(
    retainedCitation(
      'cite-first',
      'source:first',
      'blake3:v1',
      'Passage from the first fetch.',
      { startByte: 0, endByte: 30 },
    ),
  )
  const messages = toAssistantMessages([stored])
  try {
    const { unmount } = await render(
      <Harness messages={messages} client={client} />,
    )
    await unmount()
    // A page reload rebuilds from the durable projection: same cards, and no
    // new search, model call or opener request for the retained handle.
    const { container } = await render(
      <Harness messages={toAssistantMessages([stored])} client={client} />,
    )
    expect(fetches).toEqual([])
    // The reload draws the same card from the durable message alone.
    const entry = await waitFor(() =>
      container.querySelector(
        '[data-source-id="chatsource:retained:source:first"]',
      ),
    )
    expect(entry.textContent).toContain('Retained capture')
    expect(entry.textContent).toContain('blake3:v1')
    const { useComposerReferences } = await import('./composer-references')
    useComposerReferences.setState({ references: [] })
    const add = [...entry.querySelectorAll('button')].find((button) =>
      button.textContent.includes('Add to context'),
    )!
    await act(async () =>
      add.dispatchEvent(new MouseEvent('click', { bubbles: true })),
    )
    const [reference] = useComposerReferences.getState().references
    const carried = JSON.parse(reference!.excerpt!).citation
    expect(carried.sourceId).toBe('chatsource:retained:source:first')
    expect(carried.provenance.source).toEqual(
      retainedSourceRef('source:first', 'blake3:v1'),
    )
    expect(carried.passages[0].span).toEqual({ startByte: 0, endByte: 30 })
    // Adding to context is local: it never opens the handle over the wire.
    expect(fetches).toEqual([])
  } finally {
    fetchSpy.mockRestore()
  }
})
