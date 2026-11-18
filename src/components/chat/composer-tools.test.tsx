import { act, useEffect } from 'react'
import type { ReactNode } from 'react'
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from 'bun:test'
import {
  AssistantRuntimeProvider,
  useAui,
  useExternalStoreRuntime,
} from '@assistant-ui/react'
import type { AppendMessage, ThreadMessageLike } from '@assistant-ui/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { Thread } from '../assistant-ui/elements/thread.aui'
import { buttonNamed, cleanup, render, waitFor } from '../../../test/blocks/render'
import {
  codingTurnOptions,
  planningTurnOptions,
  useCodeMode,
  usePlanning,
  useWebSearch,
  webTurnOptions,
} from './composer-tools'
import { DRAFT, generationTurnOptions, useGenerationDefaults, useGenerationOverrides } from '@/lib/theorem/generation'
import { usePickedModels } from '@/lib/theorem/models'
import { useShell } from '@/components/shell/shell-state'

/** What GET /api/environment/v1/tools answers: MCP-shaped native descriptors. */
const CATALOG = {
  tools: [
    {
      name: 'remember',
      description: 'Store a memory for this person. It is recalled later.',
      inputSchema: {},
      annotations: { readOnlyHint: false },
    },
    {
      name: 'recall',
      description: 'Recall prior memory for a query. Ranks by relevance.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    {
      name: 'document_delete',
      description: 'Delete a document.',
      inputSchema: {},
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    {
      name: 'rustyweb_search',
      description: 'Search the web.',
      inputSchema: {},
    },
  ],
}

// The SDK resolves routes against the page's origin, which a bare happy-dom
// page does not have.
const page = (
  window as unknown as { happyDOM: { setURL: (url: string) => void } }
).happyDOM
beforeAll(() => page.setURL('http://localhost:3000/'))
afterAll(() => page.setURL('about:blank'))

let toolsStatus = 200
/** What GET /api/chat/v1/models answers; unset, the route is not served. */
let modelsBody: unknown
let client: QueryClient
let requests: { origin: string; pathname: string; method: string }[]
const realFetch = window.fetch
beforeEach(() => {
  toolsStatus = 200
  modelsBody = undefined
  requests = []
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    requests.push({
      origin: url.origin,
      pathname: url.pathname,
      method: init?.method ?? (input instanceof Request ? input.method : 'GET'),
    })
    if (url.pathname === '/api/environment/v1/tools')
      return toolsStatus === 200
        ? Response.json(CATALOG)
        : Response.json({ title: 'Not found' }, { status: toolsStatus })
    if (url.pathname === '/api/chat/v1/models' && modelsBody)
      return Response.json(modelsBody)
    return Response.json({}, { status: 404 })
  }) as typeof fetch
})
afterEach(async () => {
  await cleanup()
  window.fetch = realFetch
  useWebSearch.setState({ on: false })
  usePlanning.setState({ byThread: {} })
  useCodeMode.setState({ byThread: {} })
  useShell.setState({ sideDrawer: undefined, workbench: undefined, lastCompanion: 'side' })
  useGenerationOverrides.setState({ byThread: {} })
  useGenerationDefaults.setState({ defaults: {} })
  usePickedModels.setState({ selected: undefined, starred: [] })
})

/** The text the composer holds, which is what a send carries. */
let composerText = () => ''
function Draft({ text }: { text: string }) {
  const aui = useAui()
  useEffect(() => {
    composerText = () => aui.composer.getState().text
    aui.composer.setText(text)
    aui.composer.setRunConfig({
      custom: {
        theoremTurnOptions: {
          modelId: 'selected/model',
          contextReferences: [{ resource: 'existing-context' }],
        },
      },
    })
  }, [aui, text])
  return null
}
function Harness({
  text,
  sent,
  messages = [],
}: {
  text: string
  sent: AppendMessage[]
  messages?: ThreadMessageLike[]
}) {
  const runtime = useExternalStoreRuntime({
    messages,
    convertMessage: (message: ThreadMessageLike) => message,
    isRunning: false,
    onNew: async (message) => {
      sent.push(message)
    },
  })
  return (
    <QueryClientProvider client={client}>
      <AssistantRuntimeProvider runtime={runtime}>
        <Draft text={text} />
        <Thread autoFocus={false} />
      </AssistantRuntimeProvider>
    </QueryClientProvider>
  )
}

/** Renders, then lets the page's queries settle, as they have by the time a person types. */
async function mount(harness: ReactNode) {
  // The model picker's popup links to Settings, so the composer sits in a router.
  const router = createRouter({
    routeTree: createRootRoute({ component: () => harness }),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  await router.load()
  const view = await render(<RouterProvider router={router} />)
  await waitFor(() => view.container.querySelector('.ProseMirror'))
  await waitFor(() => !client.isFetching())
  // Query results reach React on the next tick, after the cache has settled.
  await act(() => new Promise((resolve) => setTimeout(resolve)))
  return view
}

const sentText = (message: AppendMessage) =>
  message.content
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('\n')

const inputOf = (container: HTMLElement) =>
  container.querySelector<HTMLElement>('[aria-label="Message input"]')!

/** Types into the editor as a person does: its line holds the text and the caret ends up after it. */
async function type(input: HTMLElement, value: string) {
  await act(async () => {
    const line = input.querySelector('p')!
    line.textContent = value
    window.getSelection()!.collapse(line.firstChild, value.length)
    input.dispatchEvent(
      new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }),
    )
    // The editor reads what was typed from the page a moment later.
    await Bun.sleep(10)
  })
}

const press = (input: HTMLElement, key: string, modifiers: KeyboardEventInit = {}) =>
  act(async () => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...modifiers }))
  })

const options = () => [
  ...document.querySelectorAll<HTMLElement>('[role="option"]'),
]

test('a slash lists the native tools, with their first sentence and what they change', async () => {
  const { container } = await mount(<Harness text="" sent={[]} />)
  await type(inputOf(container), '/')
  await waitFor(() => options().length === 12)
  expect(container.textContent).toContain('Theorem tools')
  const rows = options().map((option) => option.textContent)
  expect(rows).toEqual([
    'newStart a new chat.',
    'webToggle web search for this conversation.',
    'planToggle Plan mode for this conversation.',
    'codeToggle Code mode and the workbench.',
    'read-aloudRead the latest reply aloud, or stop reading.',
    'connectionsOpen the connections settings.',
    'document_deletedestructiveDelete a document.',
    'recallRecall prior memory for a query.',
    'rememberwritesStore a memory for this person.',
    'rustyweb_searchSearch the web.',
    'output-styleChoose how Theorem writes its replies.',
    'output-settingsResponse detail and optional limits for this conversation.',
  ])
  expect(
    requests.filter(({ pathname }) => pathname.includes('/environment/')),
  ).toEqual([
    {
      origin: window.location.origin,
      pathname: '/api/environment/v1/tools',
      method: 'GET',
    },
  ])
  expect(requests.some(({ pathname }) => pathname.startsWith('/mcp'))).toBe(false)
})

test('the tools heading shows only while the slash list is open', async () => {
  const { container } = await mount(<Harness text="" sent={[]} />)
  expect(container.textContent).not.toContain('Theorem tools')
  await type(inputOf(container), '/')
  await waitFor(() => options().length === 12)
  expect(container.textContent).toContain('Theorem tools')
  await type(inputOf(container), 'Hello')
  await waitFor(() => !options().length)
  expect(container.textContent).not.toContain('Theorem tools')
})

test('typing after the slash narrows the list, best name match first', async () => {
  const { container } = await mount(<Harness text="" sent={[]} />)
  await type(inputOf(container), '/rec')
  await waitFor(() => options().length)
  expect(options()[0]!.textContent).toStartWith('recall')
  await type(inputOf(container), '/web')
  // The web action command ranks first; the search tool follows it.
  await waitFor(() => options()[0]?.textContent.startsWith('web'))
  expect(options().some((option) => option.textContent.startsWith('rustyweb_search'))).toBe(true)
})

test('Enter picks the highlighted tool, and the message names it for the turn', async () => {
  const sent: AppendMessage[] = []
  const { container } = await mount(<Harness text="" sent={sent} />)
  const input = inputOf(container)
  await type(input, '/reca')
  await waitFor(() => options().length === 1)
  await press(input, 'Enter')
  await waitFor(() => !options().length)
  expect(composerText()).toStartWith(':tool[recall]')
  expect(input.textContent).toStartWith(':tool[recall]')
  expect(sent).toHaveLength(0)
  await type(input, `${composerText().trimEnd()} what did we decide`)
  await press(input, 'Enter', { ctrlKey: true })
  await waitFor(() => sent.length)
  expect(sentText(sent[0]!)).toBe(':tool[recall] what did we decide')
})

test('an action command runs and strips its trigger text, leaving no chip', async () => {
  const { container } = await mount(<Harness text="" sent={[]} />)
  const input = inputOf(container)
  const before = useWebSearch.getState().on
  await type(input, '/web')
  await waitFor(() => options()[0]?.textContent.startsWith('web'))
  await press(input, 'Enter')
  await waitFor(() => !options().length)
  expect(useWebSearch.getState().on).toBe(!before)
  // No directive chip is left behind, and the draft holds only whitespace.
  expect(container.querySelector('[data-slot="directive-text-chip"]')).toBeNull()
  expect(composerText().replace(/&#x20;|\s/g, '')).toBe('')
  useWebSearch.setState({ on: before })
})

test('a slash typed at the end of bold text still lists and picks a tool', async () => {
  const { container } = await mount(<Harness text="**hello**" sent={[]} />)
  const input = inputOf(container)
  const bold = await waitFor(() => input.querySelector('strong'))
  await act(async () => {
    bold.firstChild!.textContent = 'hello /rec'
    window.getSelection()!.collapse(bold.firstChild, 'hello /rec'.length)
    input.dispatchEvent(
      new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ' /rec' }),
    )
    await Bun.sleep(10)
  })
  // The caret sits before the closing marks, so the search is "rec", not "rec**".
  expect(composerText()).toBe('**hello /rec**')
  await waitFor(() => options().length)
  expect(options()[0]!.textContent).toStartWith('recall')
  await press(input, 'Enter')
  await waitFor(() => !options().length)
  expect(composerText()).toContain(':tool[recall]')
  expect(composerText()).not.toContain('/rec')
  expect(input.querySelector('strong')!.textContent).toStartWith('hello :tool[recall]')
})

test('Ctrl+Enter submits the document even while a slash suggestion is open', async () => {
  const sent: AppendMessage[] = []
  const { container } = await mount(<Harness text="" sent={sent} />)
  const input = inputOf(container)
  await type(input, '/rec')
  await waitFor(() => options().length)
  await press(input, 'Enter', { ctrlKey: true })
  await waitFor(() => sent.length)
  expect(sent).toHaveLength(1)
  expect(sentText(sent[0]!)).toBe('/rec')
  expect(composerText()).toBe('')
})

test('a slash that names no tool stays text, and Ctrl+Enter sends it', async () => {
  const sent: AppendMessage[] = []
  const { container } = await mount(<Harness text="" sent={sent} />)
  const input = inputOf(container)
  await type(input, '/')
  await waitFor(() => options().length)
  await type(input, '/usr/bin')
  await waitFor(() => !options().length)
  await press(input, 'Enter', { ctrlKey: true })
  await waitFor(() => sent.length)
  expect(sentText(sent[0]!)).toBe('/usr/bin')
})

test('output commands stay available when the tools route is unavailable', async () => {
  toolsStatus = 404
  const { container } = await mount(<Harness text="" sent={[]} />)
  await type(inputOf(container), '/')
  await waitFor(() => options().length === 8)
  expect(container.textContent).toContain('This Theorem does not list its tools yet.')
  expect(options().map((item) => item.textContent)).toEqual([
    'newStart a new chat.',
    'webToggle web search for this conversation.',
    'planToggle Plan mode for this conversation.',
    'codeToggle Code mode and the workbench.',
    'read-aloudRead the latest reply aloud, or stop reading.',
    'connectionsOpen the connections settings.',
    'output-styleChoose how Theorem writes its replies.',
    'output-settingsResponse detail and optional limits for this conversation.',
  ])
})

test('a sent message shows the tool it asked for as a chip', async () => {
  const { container } = await mount(
    <Harness
      text=""
      sent={[]}
      messages={[
        {
          id: 'u1',
          role: 'user',
          content: [{ type: 'text', text: ':tool[recall] what did we decide' }],
        },
      ]}
    />,
  )
  const chip = await waitFor(() =>
    container.querySelector('[data-slot="directive-text-chip"]'),
  )
  expect(chip.textContent).toBe('recall')
  expect(chip.getAttribute('aria-label')).toBe('tool: recall')
  expect(container.textContent).not.toContain(':tool[')
})

for (const method of ['click', 'Ctrl+Enter'] as const) {
  test(`composer ${method} sends exactly one message with its run config`, async () => {
    const sent: AppendMessage[] = []
    const { container } = await mount(
      <Harness text="Compare Chrome and Firefox" sent={sent} />,
    )
    const input = inputOf(container)
    const send = container.querySelector<HTMLButtonElement>(
      '[aria-label="Send message"]',
    )!
    await waitFor(() => !send.disabled)
    await act(() => (method === 'click' ? send.click() : press(input, 'Enter', { ctrlKey: true })))
    await waitFor(() => sent.length)
    expect(sent).toHaveLength(1)
    expect(sent[0]!.runConfig).toEqual({
      custom: {
        theoremTurnOptions: {
          modelId: 'selected/model',
          contextReferences: [{ resource: 'existing-context' }],
        },
      },
    })
    expect(sentText(sent[0]!)).toBe('Compare Chrome and Firefox')
    expect(composerText()).toBe('')
    expect(input.textContent).toBe('')
  })
}

test('blank composer stays disabled, and Shift+Enter starts a new line without sending', async () => {
  const sent: AppendMessage[] = []
  const { container } = await mount(<Harness text="" sent={sent} />)
  expect(
    container.querySelector<HTMLButtonElement>('[aria-label="Send message"]')!
      .disabled,
  ).toBe(true)
  const input = inputOf(container)
  await press(input, 'Enter')
  expect(sent).toHaveLength(0)
  expect(composerText()).toBe('')
  expect(input.textContent).toBe('')
  await type(input, 'Draft')
  await act(async () => {
    input.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        shiftKey: true,
        bubbles: true,
      }),
    )
  })
  expect(sent).toHaveLength(0)
  // The line break is in the editor; an empty last line is not part of the message.
  expect(input.querySelector('p br')).not.toBeNull()
  expect(composerText()).toBe('Draft')
})

test('the arrow keys move through the tools, and Escape closes the list and keeps the text', async () => {
  const { container } = await mount(<Harness text="" sent={[]} />)
  const input = inputOf(container)
  await type(input, '/')
  await waitFor(() => options().length === 12)
  expect(input.getAttribute('aria-expanded')).toBe('true')
  const first = input.getAttribute('aria-activedescendant')
  await press(input, 'ArrowDown')
  await waitFor(() => input.getAttribute('aria-activedescendant') !== first)
  // The list opens on the action commands; step down to recall, the second tool.
  for (let step = 0; step < 6; step++) await press(input, 'ArrowDown')
  await press(input, 'Enter')
  await waitFor(() => !options().length)
  expect(composerText()).toStartWith(':tool[recall]')

  await type(input, 'see /')
  await waitFor(() => options().length === 12)
  await press(input, 'Escape')
  await waitFor(() => !options().length)
  expect(input.hasAttribute('aria-expanded')).toBe(false)
  expect(composerText()).toBe('see /')
})

const findItem = (text: string) =>
  [...document.querySelectorAll<HTMLElement>('[role^="menuitem"]')].find((item) =>
    item.textContent.includes(text),
  )

/**
 * Opens the composer's + menu and finds one of its items by its text; `under`
 * names the submenu it sits in, which opens first.
 */
async function plusItem(container: HTMLElement, text: string, under?: string) {
  if (!document.querySelector('[role="menu"]'))
    await act(() =>
      container.querySelector<HTMLButtonElement>('[aria-label="More options"]')!.click(),
    )
  if (under && !findItem(text)) {
    const trigger = await waitFor(() => findItem(under))
    await act(() => trigger.click())
  }
  return waitFor(() => findItem(text))
}
const chipOf = (container: HTMLElement, mode: string) =>
  container.querySelector<HTMLButtonElement>(`[data-composer-chip="${mode}"]`)

test('Web search in the + menu requests research without restricting the other tools', async () => {
  const sent: AppendMessage[] = []
  const { container } = await mount(
    <Harness text="Latest Rust release" sent={sent} />,
  )
  // Nothing is on until it is chosen, and no permanent button stands for it.
  expect(chipOf(container, 'web')).toBeNull()
  expect(container.querySelector('[aria-label="Web search"]')).toBeNull()
  const web = await plusItem(container, 'Web search')
  expect(web.getAttribute('aria-checked')).toBe('false')
  expect(webTurnOptions()).toEqual({})

  await act(() => web.click())
  expect(webTurnOptions()).toEqual({ webResearch: true })
  await waitFor(() => chipOf(container, 'web'))

  // A send leaves it on and the message as typed: the scope, not a line of text, asks for the web.
  await press(document.querySelector<HTMLElement>('[role="menu"]')!, 'Escape')
  const send = container.querySelector<HTMLButtonElement>(
    '[aria-label="Send message"]',
  )!
  await waitFor(() => !send.disabled)
  await act(() => send.click())
  await waitFor(() => sent.length)
  expect(sentText(sent[0]!)).toBe('Latest Rust release')
  expect(chipOf(container, 'web')).not.toBeNull()

  // The chip turns it off.
  await act(() => chipOf(container, 'web')!.click())
  expect(webTurnOptions()).toEqual({})
  await waitFor(() => !chipOf(container, 'web'))
})

test('Plan in the + menu makes the next turns planning turns, and stays on across a send', async () => {
  const sent: AppendMessage[] = []
  const { container } = await mount(<Harness text="Plan my move to Denver" sent={sent} />)
  expect(chipOf(container, 'plan')).toBeNull()
  expect(usePlanning.getState().byThread).toEqual({})

  await act(async () => (await plusItem(container, 'Plan', 'Skills')).click())
  await waitFor(() => chipOf(container, 'plan'))
  // Plan is this conversation's: the menu keeps it under the thread it sits in.
  const [thread] = Object.keys(usePlanning.getState().byThread)
  expect(planningTurnOptions(thread!, undefined)).toEqual({ planning: true })
  expect((await plusItem(container, 'Plan', 'Skills')).getAttribute('aria-checked')).toBe('true')

  // The message goes as typed; the turn option, not a line of text, asks for the plan.
  await press(document.querySelector<HTMLElement>('[role="menu"]')!, 'Escape')
  const send = container.querySelector<HTMLButtonElement>('[aria-label="Send message"]')!
  await waitFor(() => !send.disabled)
  await act(() => send.click())
  await waitFor(() => sent.length)
  expect(sentText(sent[0]!)).toBe('Plan my move to Denver')
  expect(chipOf(container, 'plan')).not.toBeNull()

  // The runtime turns it off once a plan is written.
  await act(async () => usePlanning.getState().set(thread!, false))
  await waitFor(() => !chipOf(container, 'plan'))
})

test('Code mode in the + menu opens the workbench in the page and sends the next turns as coding tasks', async () => {
  const sent: AppendMessage[] = []
  const { container } = await mount(<Harness text="Fix the flaky test" sent={sent} />)
  expect(chipOf(container, 'code')).toBeNull()
  const code = await plusItem(container, 'Code mode')
  expect(code.getAttribute('aria-checked')).toBe('false')

  await act(() => code.click())
  await waitFor(() => chipOf(container, 'code'))
  // Docked beside the conversation, the companion last used, not a drawer.
  expect(useShell.getState().workbench).toBe('side')
  expect(useShell.getState().sideDrawer).toBeUndefined()
  const [thread] = Object.keys(useCodeMode.getState().byThread)
  expect(codingTurnOptions(thread!, undefined)).toEqual({ executionMode: 'coding' })

  // The message goes as typed, and the mode stays on across the send.
  await press(document.querySelector<HTMLElement>('[role="menu"]')!, 'Escape')
  const send = container.querySelector<HTMLButtonElement>('[aria-label="Send message"]')!
  await waitFor(() => !send.disabled)
  await act(() => send.click())
  await waitFor(() => sent.length)
  expect(sentText(sent[0]!)).toBe('Fix the flaky test')
  expect(chipOf(container, 'code')).not.toBeNull()

  // The chip turns it off and leaves the workbench where it is.
  await act(() => chipOf(container, 'code')!.click())
  await waitFor(() => !chipOf(container, 'code'))
  expect(codingTurnOptions(thread!, undefined)).toEqual({})
  expect(useShell.getState().workbench).toBe('side')
})

test('the + menu reads Web search, Connectors, Skills, Code mode, then Manage tools', async () => {
  const { container } = await mount(<Harness text="" sent={[]} />)
  await plusItem(container, 'Web search')
  const texts = [...document.querySelectorAll('[role="menu"] [role^="menuitem"]')].map(
    (item) => item.textContent.trim(),
  )
  expect(texts).toEqual(['Web search', 'Connectors', 'Skills', 'Code mode', 'Manage tools'])
  // Manage tools is a link to the tool and MCP settings, not a submenu.
  const manage = await plusItem(container, 'Manage tools')
  expect(manage.tagName).toBe('A')
  expect(manage.getAttribute('href')).toBe('/settings/connections')
  expect(manage.getAttribute('aria-haspopup')).toBeNull()
})

const FLASH = {
  ref: 'openrouter/deepseek/deepseek-v4-flash-0731',
  name: 'DeepSeek V4 Flash',
  source: 'catalog',
  effort_levels: ['low', 'high', 'max'],
  effort_default: 'low',
}
const OPUS = { ref: 'anthropic/claude-opus-5', name: 'Claude Opus 5', source: 'catalog' }

/** Effort lives in the model picker's popup: opens the picker unless it is open. */
async function openPicker(container: HTMLElement) {
  const picker = await waitFor(() =>
    container.querySelector<HTMLButtonElement>('[data-model-picker-trigger]'),
  )
  if (!document.querySelector('.appearance-model-popup')) await act(() => picker.click())
  await waitFor(() => document.querySelector('.appearance-model-popup'))
}
const effortNow = () =>
  document.querySelector<HTMLButtonElement>('[aria-label="Reasoning effort"]')
async function effortTrigger(container: HTMLElement) {
  await openPicker(container)
  return waitFor(effortNow)
}

test("the effort menu offers the default model's levels, and a pick goes out with the next send", async () => {
  modelsBody = { defaultRef: FLASH.ref, models: [FLASH, OPUS], openrouter: { status: 'live' } }
  const sent: AppendMessage[] = []
  const { container } = await mount(<Harness text="Think hard" sent={sent} />)
  const trigger = await effortTrigger(container)
  expect(trigger.textContent).toBe('Effort')
  await act(() => trigger.click())
  const items = await waitFor(() => {
    const found = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')]
    return found.length ? found : undefined
  })
  expect(items.map((item) => item.textContent)).toEqual(['DefaultLow', 'Low', 'High', 'Max'])
  expect(generationTurnOptions().effort).toBeUndefined()

  await act(() => items[2]!.click())
  expect(generationTurnOptions().effort).toBe('high')
  expect(useGenerationOverrides.getState().byThread[DRAFT]).toEqual({ effort: 'high' })
  await openPicker(container)
  await waitFor(() => effortNow()?.textContent === 'High')
})

test('a model whose route sends no effort has no effort menu, and a level already chosen still goes out', async () => {
  modelsBody = { defaultRef: OPUS.ref, models: [FLASH, OPUS], openrouter: { status: 'live' } }
  useGenerationOverrides.setState({ byThread: { [DRAFT]: { effort: 'high' } } })
  const { container } = await mount(<Harness text="Hello" sent={[]} />)
  await openPicker(container)
  expect(effortNow()).toBeNull()
  // Theorem maps a level the model does not list; the browser neither drops nor refuses it.
  expect(generationTurnOptions().effort).toBe('high')
})

const NARROW = { ref: 'openrouter/vendor/narrow', name: 'Narrow', source: 'catalog', effort_levels: ['low', 'high'], effort_default: 'low' }
const mapped = (requested: string, effective: string): ThreadMessageLike[] => [{
  role: 'assistant', id: 'last',
  content: [{ type: 'data', name: 'theorem-limits', data: { limits: { effort: { requested, effective, reason: 'the model lists low, high' } } } }],
}]

test('a level the model does not list is kept and sent, and the menu names the level the last reply ran at', async () => {
  modelsBody = { defaultRef: NARROW.ref, models: [NARROW], openrouter: { status: 'live' } }
  useGenerationOverrides.setState({ byThread: { [DRAFT]: { effort: 'max' } } })
  const { container } = await mount(<Harness text="Hello" sent={[]} messages={mapped('max', 'high')} />)
  const trigger = await effortTrigger(container)
  expect(trigger.textContent).toBe('High')
  expect(generationTurnOptions().effort).toBe('max')
  await act(() => trigger.click())
  const items = await waitFor(() => {
    const found = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')]
    return found.length ? found : undefined
  })
  expect(items.map((item) => item.textContent)).toEqual(['DefaultLow', 'Low', 'High', 'Max'])
})

test('the account default effort stands in the menu until the conversation chooses its own', async () => {
  modelsBody = { defaultRef: NARROW.ref, models: [NARROW], openrouter: { status: 'live' } }
  useGenerationDefaults.setState({ defaults: { effort: 'high' } })
  const { container } = await mount(<Harness text="Hello" sent={[]} />)
  const trigger = await effortTrigger(container)
  expect(trigger.textContent).toBe('High')
  expect(useGenerationOverrides.getState().byThread[DRAFT]).toBeUndefined()
  expect(generationTurnOptions().effort).toBe('high')
})

test("a conversation's own response limits can be dropped from the effort menu, keeping its effort", async () => {
  modelsBody = { defaultRef: FLASH.ref, models: [FLASH, OPUS], openrouter: { status: 'live' } }
  useGenerationOverrides.setState({
    byThread: { [DRAFT]: { effort: 'high', responseDetail: 'concise', runBudget: { maxSteps: 4 } } },
  })
  const { container } = await mount(<Harness text="Hello" sent={[]} />)
  const trigger = await effortTrigger(container)
  await act(() => trigger.click())
  const reset = await waitFor(() =>
    [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (item) => item.textContent === 'Use account response limits',
    ),
  )
  await act(() => reset.click())
  expect(useGenerationOverrides.getState().byThread[DRAFT]).toEqual({ effort: 'high' })
})

test('the effort menu offers no limits reset while the conversation has none of its own', async () => {
  modelsBody = { defaultRef: FLASH.ref, models: [FLASH, OPUS], openrouter: { status: 'live' } }
  useGenerationOverrides.setState({ byThread: { [DRAFT]: { effort: 'high' } } })
  const { container } = await mount(<Harness text="Hello" sent={[]} />)
  const trigger = await effortTrigger(container)
  await act(() => trigger.click())
  await waitFor(() => document.querySelector('[role="menuitemradio"]'))
  expect(document.querySelector('[role="menuitem"]')).toBeNull()
})

test('output settings open only through a slash command and preserve conversation overrides', async () => {
  const { container } = await mount(<Harness text="Hello" sent={[]} messages={[{
    role: 'assistant', id: 'last',
    content: [{ type: 'data', name: 'theorem-limits', data: { limits: { maxOutputTokensPerCall: { value: 8000, source: 'default' } } } }],
  }]} />)
  expect(container.querySelector('[aria-label="Response length and detail"]')).toBeNull()
  const input = inputOf(container)
  await type(input, 'Hello /output-settings')
  await waitFor(() => options().length === 1)
  await press(input, 'Enter')
  await waitFor(() => document.querySelector('[role="dialog"]'))
  expect(composerText().trim()).toBe('Hello')
  const panel = await waitFor(() => document.querySelector('[data-slot="response-control"]'))
  // What the newest run ran under is shown beneath the fields.
  expect(panel.textContent).toContain('Last reply ran under')
  expect(panel.textContent).toContain("Theorem's default")
  expect(buttonNamed(panel, 'Reset')).toBeUndefined()

  await act(() => buttonNamed(panel, 'Concise')!.click())
  expect(useGenerationOverrides.getState().byThread[DRAFT]).toEqual({ responseDetail: 'concise' })
  expect(generationTurnOptions().responseDetail).toBe('concise')
  await waitFor(() => buttonNamed(panel, 'Reset'))

  await act(() => buttonNamed(panel, 'Reset')!.click())
  expect(useGenerationOverrides.getState().byThread[DRAFT]).toBeUndefined()
  await waitFor(() => !buttonNamed(panel, 'Reset'))
})
