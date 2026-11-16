import { act } from 'react'
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, waitFor } from '../../../test/blocks/render'
import { installFakeTheorem } from '@/stories/fake-theorem'
import { bootstrap } from '@/lib/theorem/client'
import { useGenerationDefaults } from '@/lib/theorem/generation'
import { OutputStyleSelect } from './output-style-select'

const page = (
  window as unknown as { happyDOM: { setURL: (url: string) => void } }
).happyDOM
beforeAll(() => page.setURL('http://localhost:3000'))
afterAll(() => page.setURL('about:blank'))
let restore = () => {}
afterEach(async () => {
  await cleanup()
  restore()
})

async function mount(threadId?: string, fail = false) {
  const writes: unknown[] = []
  const reads: string[] = []
  const selection = {
    account: null as string | null,
    conversation: null as string | null,
    effective: { style: 'normal', name: 'Normal', source: 'shipped' },
  }
  restore = installFakeTheorem({
    'GET /api/chat/v1/bootstrap': () => ({ csrfToken: 'csrf', tenantId: 't' }),
    'GET /api/chat/v1/response-styles': (_, request) => {
      reads.push(new URL(request.url).search)
      return {
        styles: [
          { id: 'normal', name: 'Normal', description: 'Direct replies.' },
          {
            id: 'explanatory',
            name: 'Explanatory',
            description: 'Explain the reasoning and teach the concepts.',
          },
        ],
        selection,
      }
    },
    'PUT /api/chat/v1/response-styles/selection': async (_, request) => {
      expect(request.headers.get('X-CSRF-Token')).toBe('csrf')
      expect(request.headers.get('Idempotency-Key')).toBeTruthy()
      const body = (await request.json()) as {
        scope: 'account' | 'conversation'
        style: string | null
      }
      writes.push(body)
      if (fail)
        return Response.json({ title: 'Could not save' }, { status: 503 })
      selection[body.scope] = body.style
      return selection
    },
  })
  await bootstrap(true)
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const view = await render(
    <QueryClientProvider client={client}>
      <OutputStyleSelect threadId={threadId} />
    </QueryClientProvider>,
  )
  const trigger = await waitFor(() =>
    view.container.querySelector<HTMLButtonElement>('[role="combobox"]'),
  )
  await act(() => trigger.click())
  const option = await waitFor(() =>
    [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (item) => item.textContent === 'Explanatory',
    ),
  )
  await act(() => option.click())
  await waitFor(() => writes.length)
  return { ...view, reads, writes, trigger }
}

test('settings save the native account style independently of token settings', async () => {
  const before = useGenerationDefaults.getState().defaults
  const { writes, trigger } = await mount()
  expect(writes).toEqual([{ scope: 'account', style: 'explanatory' }])
  await waitFor(() => trigger.textContent === 'Explanatory')
  expect(useGenerationDefaults.getState().defaults).toBe(before)
})

test('a conversation style uses its scoped native selection route', async () => {
  const { reads, writes, trigger } = await mount('thread/one')
  expect(reads[0]).toBe('?threadId=thread%2Fone')
  expect(writes).toEqual([
    { scope: 'conversation', threadId: 'thread/one', style: 'explanatory' },
  ])
  await waitFor(() => trigger.textContent === 'Explanatory')
  await act(() => trigger.click())
  const inherit = await waitFor(() =>
    [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (item) => item.textContent === 'Use my default',
    ),
  )
  await act(() => inherit.click())
  await waitFor(() => writes.length === 2)
  expect(writes[1]).toEqual({
    scope: 'conversation',
    threadId: 'thread/one',
    style: null,
  })
  await waitFor(() => trigger.textContent === 'Use my default')
})

test('a failed style save keeps the confirmed selection and shows the failure', async () => {
  const { container, trigger } = await mount(undefined, true)
  await waitFor(() => container.querySelector('[role="alert"]'))
  expect(container.textContent).toContain('The output style was not saved.')
  expect(trigger.textContent).toBe('Theorem default')
})

test('a malformed style response shows a retryable load failure', async () => {
  restore = installFakeTheorem({
    'GET /api/chat/v1/response-styles': () => ({}),
  })
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const { container } = await render(
    <QueryClientProvider client={client}>
      <OutputStyleSelect />
    </QueryClientProvider>,
  )
  await waitFor(() => container.querySelector('[role="alert"]'))
  expect(container.textContent).toContain('Output styles could not be loaded.')
  expect(container.querySelector('[role="combobox"]')).toBeNull()
})
