import { afterEach, expect, test } from 'bun:test'
import { act } from 'react'
import { AssistantRuntimeProvider, useExternalStoreRuntime } from '@assistant-ui/react'
import type { ThreadMessageLike } from '@assistant-ui/react'
import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router'
import { ModelPicker } from './model-picker'
import { CommandPalette, useCommandPalette } from '../shell/command-palette'
import { modelListQuery, parseModelList, pickedModel, usePickedModels } from '@/lib/theorem/models'
import { catalogQuery } from '@/lib/theorem/catalog'
import { refOf, useRoster } from '@/lib/theorem/roster'
import { cleanup, click, render, waitFor } from '../../../test/blocks/render'

const clients: QueryClient[] = []
afterEach(async () => {
  await cleanup()
  clients.splice(0).forEach((client) => client.clear())
  usePickedModels.setState({ selected: undefined, starred: [] })
  // A roster belongs to the conversation, and every test here opens the same
  // one, so the room a test seated has to leave with it.
  useRoster.setState({ byConversation: {}, current: undefined, reads: {} })
  useCommandPalette.setState({ open: false })
})

/** The composer's runtime, which the effort menu in the picker's popup reads the conversation from. */
function Conversation({ children }: { children: ReactNode }) {
  const runtime = useExternalStoreRuntime({ messages: [] as ThreadMessageLike[], convertMessage: (message: ThreadMessageLike) => message, onNew: async () => {} })
  return <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>
}

async function models(palette: boolean, defaultRef?: string) {
  const client = new QueryClient()
  clients.push(client)
  client.setQueryData(modelListQuery.queryKey, parseModelList({
    models: [
      { ref: 'provider/vendor/available', name: 'Available', context_length: 100000 },
      { ref: 'provider/vendor/second', name: 'Second', context_length: 200000 },
    ],
    defaultError: { code: 'invalid_default', message: 'The configured default is missing.' },
    ...(defaultRef ? { defaultRef } : {}),
  }))
  client.setQueryData(catalogQuery.queryKey, { plugins: [], skills: [] })
  const route = createRootRoute({ component: () => <QueryClientProvider client={client}>{palette ? <CommandPalette /> : <Conversation><ModelPicker /></Conversation>}</QueryClientProvider> })
  const router = createRouter({ routeTree: route, history: createMemoryHistory({ initialEntries: ['/'] }) })
  await router.load()
  return render(<RouterProvider router={router} />)
}

const row = (name: string) =>
  waitFor(() => [...document.querySelectorAll('[role="option"]')].find((item) => String(item.textContent).includes(name)))

/** The room the composer's picker holds, as the conversation's roster has it. */
const seated = () => useRoster.getState().byConversation.DEFAULT_THREAD_ID?.roster.participants ?? []

/** A keystroke on the popup's own search field, which is what the list is walked from. */
const press = (key: string) =>
  act(async () => {
    ;(document.querySelector('[data-slot="combobox-input"]') as HTMLElement).dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  })

test('picker exposes invalid default and selecting a starred model sends the exact provider/model', async () => {
  usePickedModels.getState().setStarred(['provider/vendor/available'])
  const { container } = await models(false)
  await click(container.querySelector('[data-model-picker-trigger]')!)
  await waitFor(() => document.querySelector('[role="alert"]'))
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('The configured default is missing.')
  const option = await waitFor(() => [...document.querySelectorAll('[role="option"]')].find((item) => item.textContent.includes('Available')))
  await click(option)
  expect(pickedModel()).toEqual({ provider: 'provider', model: 'vendor/available' })
  expect(container.textContent).toContain('Available')
})

test('command palette exposes invalid default while keeping available model selection', async () => {
  useCommandPalette.setState({ open: true })
  await models(true)
  await waitFor(() => document.querySelector('[role="alert"]'))
  // The cause in words, not the backend's code for it.
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('The configured default is missing.')
  expect(document.querySelector('[role="alert"]')?.textContent).not.toContain('invalid_default')
  const option = await waitFor(() => [...document.querySelectorAll('[role="option"]')].find((item) => item.textContent.includes('Available')))
  await click(option)
  expect(pickedModel()).toEqual({ provider: 'provider', model: 'vendor/available' })
  expect(useCommandPalette.getState().open).toBe(false)
})

// The mark itself is not asserted: other suites mock the icon set to render
// nothing, and bun shares module mocks across files in one run.
test('the fallback is a default model choice, not a special Theorem agent', async () => {
  const { container } = await models(false)

  expect(container.querySelector('[data-model-picker-trigger]')?.textContent).toBe('Default model')
})

test('a picked model shows its own name', async () => {
  usePickedModels.getState().setStarred(['provider/vendor/available'])
  usePickedModels.getState().select('provider/vendor/available')
  const { container } = await models(false)

  expect(container.querySelector('[data-model-picker-trigger]')?.textContent).toBe('Available')
})

test('the default trigger names the model without changing an unpinned send', async () => {
  const { container } = await models(false, 'provider/vendor/available')
  expect(container.querySelector('[data-model-picker-trigger]')?.textContent).toBe('Available (default)')
  expect(pickedModel()).toBeUndefined()
})

test('picking two models seats two participants in the conversation', async () => {
  const { container } = await models(false)
  const trigger = container.querySelector('[data-model-picker-trigger]')!
  await click(trigger)
  await click(await row('Available'))
  await click(await row('Second'))

  expect(seated().map((part) => refOf(part.model))).toEqual([
    'provider/vendor/available',
    'provider/vendor/second',
  ])
  expect(new Set(seated().map((part) => part.participantId)).size).toBe(2)
  // Each is marked in the room, and the button names both, so a screen reader
  // can tell who is in the conversation.
  expect((await row('Available')).getAttribute('aria-checked')).toBe('true')
  expect((await row('Second')).getAttribute('aria-checked')).toBe('true')
  expect(trigger.getAttribute('aria-label')).toBe('Models: Available, Second')
})

test('picking a seated model again gives its seat up', async () => {
  const { container } = await models(false)
  const trigger = container.querySelector('[data-model-picker-trigger]')!
  await click(trigger)
  await click(await row('Available'))
  await click(await row('Second'))
  await click(await row('Second'))

  expect(seated().map((part) => refOf(part.model))).toEqual(['provider/vendor/available'])
  // One seat is one model again, so the button is named as it was before there
  // was a room of more than one.
  expect(trigger.getAttribute('aria-label')).toBe('Model: Available')
  expect(pickedModel()).toEqual({ provider: 'provider', model: 'vendor/available' })
})

test('a seated model is reachable and removable by keyboard alone', async () => {
  const { container } = await models(false)
  await click(container.querySelector('[data-model-picker-trigger]')!)
  await row('Available')
  await act(async () => {
    ;(document.querySelector('[data-slot="combobox-input"]') as HTMLElement).focus()
  })
  // Down onto the model, press it into the room, walk to the next seat, then
  // back and press it out again: no pointer needed at any step.
  await press('ArrowDown')
  await press('Enter')
  expect(seated().map((part) => refOf(part.model))).toEqual(['provider/vendor/available'])

  await press('ArrowDown')
  await press('Enter')
  expect(seated().map((part) => refOf(part.model))).toEqual([
    'provider/vendor/available',
    'provider/vendor/second',
  ])

  await press('ArrowUp')
  await press('Enter')
  expect(seated().map((part) => refOf(part.model))).toEqual(['provider/vendor/second'])
  expect(container.querySelector('[data-model-picker-trigger]')?.getAttribute('aria-label')).toBe('Model: Second')
})

test("giving up every seat leaves the room to Theorem's default", async () => {
  const { container } = await models(false)
  const trigger = container.querySelector('[data-model-picker-trigger]')!
  await click(trigger)
  await click(await row('Available'))
  await click(await row('Available'))

  expect(seated()).toEqual([])
  expect(trigger.textContent).toBe('Default model')
  expect(trigger.getAttribute('aria-label')).toBe('Model: Default model')
  // A draft with no model of its own runs on Theorem's default, not a pick.
  expect(pickedModel()).toBeUndefined()
})
