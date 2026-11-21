// SOURCING: bun:test over the "@" list's review findings: which cites a message still holds (./composer-mentions pruneMentionCites, switchMentionConversation) and the list mounted in the real Thread as composer-mentions.test mounts it, with window.fetch the in-memory CRM fixture plus a stubbed Index query route, as no Theorem is running. Synthetic records and documents only
import { act } from 'react'
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
  citeMention,
  pruneMentionCites,
  switchMentionConversation,
  useMentionCites,
} from './composer-mentions'

const page = (
  window as unknown as { happyDOM: { setURL: (url: string) => void } }
).happyDOM
beforeAll(() => page.setURL('http://localhost:3000/'))
afterAll(() => page.setURL('about:blank'))

const record = (id: string, label: string) => ({
  id: `record:Person/${id}`,
  type: 'record',
  label,
  metadata: { cite: 'record', objectType: 'Person', objectId: id },
})
const NOOR = record('person:noor', 'Noor')
const NOOR_HADDAD = record('person:noor-haddad', 'Noor Haddad')

const keys = () =>
  useComposerReferences
    .getState()
    .references.map(
      (r) => (r.location.resource as { objectId: string }).objectId,
    )

beforeEach(() => {
  useComposerReferences.setState({ references: [] })
  useMentionCites.setState({ byKey: {} })
})

describe('which mention a message still holds', () => {
  test('deleting @Noor keeps @Noor Haddad and drops only the Noor reference', () => {
    citeMention(NOOR)
    citeMention(NOOR_HADDAD)
    pruneMentionCites('ask @Noor and @Noor Haddad')
    expect(keys()).toEqual(['person:noor', 'person:noor-haddad'])
    // The first words are gone; the second name still starts with them.
    pruneMentionCites('ask @Noor Haddad')
    expect(keys()).toEqual(['person:noor-haddad'])
  })

  test('words inside a longer word are not the mention', () => {
    citeMention(NOOR)
    pruneMentionCites('@Noor')
    pruneMentionCites('@Noorish')
    expect(keys()).toEqual([])
  })

  test('two records with the same name need two mentions', () => {
    const other = record('person:noor-2', 'Noor')
    citeMention(NOOR)
    citeMention(other)
    pruneMentionCites('@Noor and @Noor')
    expect(keys()).toHaveLength(2)
    pruneMentionCites('@Noor')
    expect(keys()).toHaveLength(1)
  })
})

describe('switching conversations', () => {
  test("another conversation's draft never prunes this one's mention", () => {
    citeMention(NOOR)
    pruneMentionCites('ask @Noor')
    switchMentionConversation('a', 'b')
    // Conversation b has its own text, with no @Noor in it.
    pruneMentionCites('a different draft')
    pruneMentionCites('')
    expect(keys()).toEqual(['person:noor'])
    switchMentionConversation('b', 'a')
    pruneMentionCites('ask @Noor')
    expect(keys()).toEqual(['person:noor'])
    // Deleting the words in a still removes the reference.
    pruneMentionCites('ask')
    expect(keys()).toEqual([])
  })
})

const KILN: IndexItem = {
  documentId: 'doc:kiln-visit',
  title: 'Notes on the kiln visit',
  documentKind: 'note',
  revision: { position: 3, contentDigest: 'sha256:kiln' },
  collectionIds: [],
} as unknown as IndexItem

let client: QueryClient
let asked: Binding[]
let failRecords = false
let documentFor: (q: string | undefined) => IndexItem[]
const realFetch = window.fetch
beforeEach(() => {
  asked = []
  failRecords = false
  documentFor = () => [KILN]
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, retryDelay: 0 } },
  })
  const crm = fixtureFetch(createFixtureServer())
  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(
      input instanceof Request ? input.url : String(input),
      'http://localhost:3000',
    )
    if (url.pathname === '/api/index/v1/query') {
      const { binding } = JSON.parse(String(init?.body)) as { binding: Binding }
      asked.push(binding)
      const q = (binding as { query?: { q?: string } }).query?.q
      const items = documentFor(q)
      return Response.json({ kind: 'items', items, total: items.length })
    }
    const raw =
      input instanceof Request
        ? await input.clone().text()
        : String(init?.body ?? '')
    if (failRecords && raw.includes('find_many'))
      return Response.json({ errors: [{ message: 'unavailable' }] })
    return crm(input, init)
  }) as typeof fetch
})
afterEach(async () => {
  await cleanup()
  window.fetch = realFetch
})

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

const options = () => [
  ...document.querySelectorAll<HTMLElement>('[role="option"]'),
]

describe('the @ list in the composer', () => {
  test('opening it searches a bounded page of records, not every record', async () => {
    const server = createFixtureServer()
    const crm = fixtureFetch(server)
    const inner = window.fetch
    window.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
      String(input).includes('graphql') ||
      (input instanceof Request && input.url.includes('graphql'))
        ? crm(input, init)
        : inner(input, init)) as typeof fetch
    const { container } = await mount()
    server.state.verbs.length = 0
    await type(inputOf(container), '@noo')
    await waitFor(() => options().some((o) => o.textContent === 'NoorPerson'))
    const reads = server.state.verbs.filter((v) => v.verb === 'find_many')
    expect(reads.length).toBeGreaterThan(0)
    for (const read of reads) {
      expect(read.input.limit).toBeLessThanOrEqual(20)
      expect(read.input.offset).toBeUndefined()
    }
  })

  test('a document found for an earlier query is not offered for the next', async () => {
    documentFor = (q) => (q === 'noo' ? [KILN] : [])
    const { container } = await mount()
    const input = inputOf(container)
    await type(input, '@noo')
    await waitFor(() =>
      options().some((o) => o.textContent.includes('Notes on the kiln visit')),
    )
    // The next query is typed and its search has not been answered yet.
    documentFor = () => []
    await type(input, '@noor h')
    expect(
      options().some((o) => o.textContent.includes('Notes on the kiln visit')),
    ).toBe(false)
    await act(() => Bun.sleep(300))
    expect(
      options().some((o) => o.textContent.includes('Notes on the kiln visit')),
    ).toBe(false)
  })

  test('a failed record search is said, not shown as an empty list, and can be tried again', async () => {
    documentFor = () => []
    failRecords = true
    const { container } = await mount()
    await type(inputOf(container), '@noo')
    const alert = await waitFor(() =>
      document.querySelector<HTMLElement>('[role="alert"]'),
    )
    expect(alert.textContent).toContain('could not be searched')
    expect(document.body.textContent).not.toContain(
      'No matching records or documents',
    )
    failRecords = false
    const retry = [...alert.querySelectorAll('button')].find((b) =>
      b.textContent.includes('Try again'),
    )!
    await act(async () => {
      retry.click()
      await Bun.sleep(50)
    })
    await waitFor(() => options().some((o) => o.textContent === 'NoorPerson'))
  })
})
