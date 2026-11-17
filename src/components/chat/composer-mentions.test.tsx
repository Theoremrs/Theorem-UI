// SOURCING: bun:test over the "@" list (./composer-mentions) mounted in the real Thread and its Milkdown composer with React into happy-dom, driven the way composer-tools.test drives the "/" list. window.fetch is the in-memory CRM fixture (data model, life context, records over /graphql) plus a stubbed Index query route that records each binding it is asked, as no Theorem is running. Synthetic records and documents only
import { act, useEffect } from 'react'
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test'
import {
  AssistantRuntimeProvider,
  useAui,
  useExternalStoreRuntime,
} from '@assistant-ui/react'
import type { ThreadMessageLike } from '@assistant-ui/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Thread } from '../assistant-ui/elements/thread.aui'
import { cleanup, render, waitFor } from '../../../test/blocks/render'
import { createFixtureServer, fixtureFetch } from '@/components/crm/fixture'
import type { Binding, IndexItem } from '@/components/index/contract'
import { useComposerReferences } from './composer-references'
import {
  MENTION_FORMATTER,
  citeMention,
  pruneMentionCites,
  useMentionCites,
  mentionMatcher,
  mentionRank,
  mentionReference,
} from './composer-mentions'

const page = (
  window as unknown as { happyDOM: { setURL: (url: string) => void } }
).happyDOM
beforeAll(() => page.setURL('http://localhost:3000/'))
afterAll(() => page.setURL('about:blank'))

const KILN_NOTES: IndexItem = {
  documentId: 'doc:kiln-visit',
  title: 'Notes on the kiln visit',
  documentKind: 'note',
  revision: { position: 3, contentDigest: 'sha256:kiln' },
  collectionIds: [],
} as unknown as IndexItem

let client: QueryClient
let asked: Binding[]
const realFetch = window.fetch
beforeEach(() => {
  asked = []
  useComposerReferences.setState({ references: [] })
  useMentionCites.setState({ byKey: {} })
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const crm = fixtureFetch(createFixtureServer())
  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(
      input instanceof Request ? input.url : String(input),
      'http://localhost:3000',
    )
    if (url.pathname === '/api/index/v1/query') {
      const { binding } = JSON.parse(String(init?.body)) as {
        binding: Binding
      }
      asked.push(binding)
      return Response.json({ kind: 'items', items: [KILN_NOTES], total: 1 })
    }
    return crm(input, init)
  }) as typeof fetch
})
afterEach(async () => {
  await cleanup()
  window.fetch = realFetch
  useComposerReferences.setState({ references: [] })
})

let composerText = () => ''
function Draft() {
  const aui = useAui()
  useEffect(() => {
    composerText = () => aui.composer.getState().text
  }, [aui])
  return null
}

function Harness() {
  const runtime = useExternalStoreRuntime({
    messages: [] as ThreadMessageLike[],
    convertMessage: (message: ThreadMessageLike) => message,
    isRunning: false,
    onNew: async () => undefined,
  })
  return (
    <QueryClientProvider client={client}>
      <AssistantRuntimeProvider runtime={runtime}>
        <Draft />
        <Thread autoFocus={false} />
      </AssistantRuntimeProvider>
    </QueryClientProvider>
  )
}

async function mount() {
  const view = await render(<Harness />)
  await waitFor(() => view.container.querySelector('.ProseMirror'))
  await waitFor(() => !client.isFetching())
  await act(() => new Promise((resolve) => setTimeout(resolve)))
  return view
}

const inputOf = (container: HTMLElement) =>
  container.querySelector<HTMLElement>('[aria-label="Message input"]')!

async function type(input: HTMLElement, value: string) {
  await act(async () => {
    const line = input.querySelector('p')!
    line.textContent = value
    window.getSelection()!.collapse(line.firstChild, value.length)
    input.dispatchEvent(
      new InputEvent('input', {
        bubbles: true,
        inputType: 'insertText',
        data: value,
      }),
    )
    await Bun.sleep(10)
  })
}

const press = (
  input: HTMLElement,
  key: string,
  modifiers: KeyboardEventInit = {},
) =>
  act(async () => {
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key, bubbles: true, ...modifiers }),
    )
  })

const NOOR = {
  id: 'record:Person/person:noor',
  type: 'record',
  label: 'Noor',
  metadata: { cite: 'record', objectType: 'Person', objectId: 'person:noor' },
}
const keys = () =>
  useComposerReferences
    .getState()
    .references.map(
      (r) => (r.location.resource as { objectId: string }).objectId,
    )

const options = () => [
  ...document.querySelectorAll<HTMLElement>('[role="option"]'),
]

describe('mentionMatcher', () => {
  const match = (text: string, cursor = text.length) =>
    mentionMatcher(text, '@', cursor)
  test('opens at the start of the text or after a space, up to the caret', () => {
    expect(match('@no')).toEqual({ query: 'no', offset: 0, endOffset: 3 })
    expect(match('ask @')).toEqual({ query: '', offset: 4, endOffset: 5 })
    expect(match('ask @noor about it', 9)).toEqual({
      query: 'noor',
      offset: 4,
      endOffset: 9,
    })
  })
  test('stays shut inside a word, such as an email address', () => {
    expect(match('write to avery@example')).toBeNull()
    expect(match('ask @noor about it')).toBeNull()
  })
})

describe('mentionRank', () => {
  test('a title that starts with the query, then a word that does, then anywhere', () => {
    expect(mentionRank('Noor', 'no')).toBe(0)
    expect(mentionRank('Send Noor the list', 'noor')).toBe(1)
    expect(mentionRank('Kiln Street Studio', 'reet')).toBe(2)
    expect(mentionRank('Avery Quinn', 'noor')).toBeUndefined()
    expect(mentionRank('Avery Quinn', '')).toBe(2)
  })
})

describe('mentionReference', () => {
  test('a record by its type, a document as a graph object, unpinned', () => {
    expect(
      mentionReference({
        id: 'record:Person/person:noor',
        type: 'record',
        label: 'Noor',
        metadata: {
          cite: 'record',
          objectType: 'Person',
          objectId: 'person:noor',
        },
      }),
    ).toEqual({
      location: {
        resource: {
          kind: 'record',
          objectId: 'person:noor',
          objectType: 'Person',
        },
      },
      label: 'Noor',
    })
    expect(
      mentionReference({
        id: 'document:doc:kiln-visit',
        type: 'document',
        label: 'Notes on the kiln visit',
        metadata: {
          cite: 'document',
          objectType: 'note',
          objectId: 'doc:kiln-visit',
        },
      }),
    ).toEqual({
      location: {
        resource: {
          kind: 'graph-object',
          objectId: 'doc:kiln-visit',
          objectType: 'note',
        },
      },
      label: 'Notes on the kiln visit',
    })
    expect(
      mentionReference({ id: 'x', type: 'tool', label: 'recall' }),
    ).toBeUndefined()
  })
  test('the message reads @ and the title', () => {
    expect(
      MENTION_FORMATTER.serialize({ id: 'x', type: 'record', label: 'Noor' }),
    ).toBe('@Noor')
  })
})

describe('pruneMentionCites', () => {
  test('a chip goes once its words have been in the message and are gone', () => {
    citeMention(NOOR)
    // Before the words arrive, the chip stays.
    pruneMentionCites('@noo')
    expect(keys()).toEqual(['person:noor'])
    pruneMentionCites('ask @Noor about the glaze')
    expect(keys()).toEqual(['person:noor'])
    pruneMentionCites('ask about the glaze')
    expect(keys()).toEqual([])
    expect(useMentionCites.getState().byKey).toEqual({})
  })

  test('Markdown escaping in the message still counts as the words', () => {
    const plan = {
      ...NOOR,
      id: 'document:doc:q3',
      type: 'document',
      label: 'Q3_plan',
      metadata: { cite: 'document', objectType: 'note', objectId: 'doc:q3' },
    }
    citeMention(plan)
    pruneMentionCites('see @Q3\\_plan')
    pruneMentionCites('see @Q3\\_plan today')
    expect(keys()).toEqual(['doc:q3'])
  })

  test('a chip something else added is never taken away by the words', () => {
    useComposerReferences.getState().add({
      location: {
        resource: {
          kind: 'record',
          objectId: 'person:noor',
          objectType: 'Person',
        },
      },
      label: 'Noor',
    })
    citeMention(NOOR)
    pruneMentionCites('@Noor')
    pruneMentionCites('')
    expect(keys()).toEqual(['person:noor'])
  })

  test('a chip the person removed is forgotten, and its words stay text', () => {
    citeMention(NOOR)
    pruneMentionCites('@Noor')
    useComposerReferences.getState().remove('record:Person/person:noor')
    pruneMentionCites('@Noor')
    expect(useMentionCites.getState().byKey).toEqual({})
  })
})

describe('the @ list in the composer', () => {
  test('nothing is searched until an @ is typed', async () => {
    const { container } = await mount()
    await type(inputOf(container), 'hello')
    await act(() => Bun.sleep(200))
    expect(asked).toEqual([])
    expect(options()).toHaveLength(0)
  })

  test('lists matching records first, then the documents the Index finds', async () => {
    const { container } = await mount()
    await type(inputOf(container), '@noo')
    await waitFor(() =>
      options().some((o) => o.textContent.includes('Notes on the kiln visit')),
    )
    // One search, for what was typed, not a recent-documents search first.
    expect(asked).toEqual([{ kind: 'items', query: { q: 'noo', limit: 5 } }])
    expect(container.textContent).toContain('Records and documents')
    const rows = options().map((o) => o.textContent)
    expect(rows[0]).toBe('NoorPerson')
    expect(rows.at(-1)).toBe('Notes on the kiln visitDocument')
    expect(rows.some((row) => row.includes('Avery Quinn'))).toBe(false)
  })

  test('an @ alone offers the most recently changed documents', async () => {
    const { container } = await mount()
    await type(inputOf(container), '@')
    await waitFor(() =>
      options().some((o) => o.textContent.includes('Notes on the kiln visit')),
    )
    expect(asked).toEqual([
      { kind: 'items', query: { sort: 'updated', limit: 5 } },
    ])
  })

  test('a pick writes @Title and adds the record to the turn', async () => {
    const { container } = await mount()
    const input = inputOf(container)
    await type(input, '@noo')
    await waitFor(() => options()[0]?.textContent === 'NoorPerson')
    await press(input, 'Enter')
    await waitFor(() => !options().length)
    expect(composerText()).toStartWith('@Noor')
    expect(useComposerReferences.getState().references).toEqual([
      {
        location: {
          resource: {
            kind: 'record',
            objectId: 'person:noor',
            objectType: 'Person',
          },
        },
        label: 'Noor',
      },
    ])
    // The chip above the input names it, as "Ask about" does.
    const chips = await waitFor(() =>
      container.querySelector('ul[aria-label="Context"]'),
    )
    expect(chips.textContent).toContain('Noor')
  })

  test('a document pick adds the document for Theorem to read', async () => {
    const { container } = await mount()
    const input = inputOf(container)
    await type(input, '@kiln visit')
    // A space ends a mention: with the caret after "visit" nothing is open.
    expect(options()).toHaveLength(0)
    await type(input, '@kiln')
    await waitFor(() =>
      options().some((o) => o.textContent.includes('Notes on the kiln visit')),
    )
    const at = options().findIndex((o) =>
      o.textContent.includes('Notes on the kiln visit'),
    )
    for (let step = 0; step < at; step++) await press(input, 'ArrowDown')
    await press(input, 'Enter')
    await waitFor(() => !options().length)
    expect(composerText()).toStartWith('@Notes on the kiln visit')
    expect(useComposerReferences.getState().references).toEqual([
      {
        location: {
          resource: {
            kind: 'graph-object',
            objectId: 'doc:kiln-visit',
            objectType: 'note',
          },
        },
        label: 'Notes on the kiln visit',
      },
    ])
  })

  test('deleting the @ words in the composer removes their chip', async () => {
    const { container } = await mount()
    const input = inputOf(container)
    await type(input, '@noo')
    await waitFor(() => options()[0]?.textContent === 'NoorPerson')
    await press(input, 'Enter')
    await waitFor(() => !options().length)
    await waitFor(() => container.querySelector('ul[aria-label="Context"]'))
    expect(keys()).toEqual(['person:noor'])
    await type(input, 'ask about the glaze')
    await waitFor(() => !container.querySelector('ul[aria-label="Context"]'))
    expect(keys()).toEqual([])
  })

  test('clearing the whole message removes the chips its @ words added', async () => {
    const { container } = await mount()
    const input = inputOf(container)
    await type(input, '@noo')
    await waitFor(() => options()[0]?.textContent === 'NoorPerson')
    await press(input, 'Enter')
    await waitFor(() => !options().length)
    expect(keys()).toEqual(['person:noor'])
    await act(async () => {
      input.querySelector('p')!.textContent = ''
      input.dispatchEvent(
        new InputEvent('input', { bubbles: true, inputType: 'deleteContent' }),
      )
      await Bun.sleep(10)
    })
    await waitFor(() => composerText().trim() === '')
    await waitFor(() => keys().length === 0)
  })

  test('sending keeps the cited record for the turn', async () => {
    const { container } = await mount()
    const input = inputOf(container)
    await type(input, '@noo')
    await waitFor(() => options()[0]?.textContent === 'NoorPerson')
    await press(input, 'Enter')
    await waitFor(() => !options().length)
    expect(composerText()).toStartWith('@Noor')
    await press(input, 'Enter', { ctrlKey: true })
    await waitFor(() => composerText() === '')
    await act(() => Bun.sleep(50))
    // The runtime takes it with the turn; the cleared text is not a delete.
    expect(keys()).toEqual(['person:noor'])
    expect(useMentionCites.getState().byKey).toEqual({})
  })

  test('an email address opens no list', async () => {
    const { container } = await mount()
    await type(inputOf(container), 'write to avery@exa')
    await act(() => Bun.sleep(200))
    expect(options()).toHaveLength(0)
    expect(asked).toEqual([])
  })
})
