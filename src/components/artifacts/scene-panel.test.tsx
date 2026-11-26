// SOURCING: bun:test over the real ArtifactPanel and scene renderer inside an
// assistant-ui external-store runtime with a thread-list adapter, so the panel
// has the conversation the dock gives it. happy-dom loads no frame pages, so
// the scene frame is given a stand-in window, as scene-part.test.tsx does.
import { afterAll, afterEach, expect, mock, spyOn, test } from 'bun:test'
import { act } from 'react'
import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
} from '@assistant-ui/react'
import type { ThreadMessage, ThreadMessageLike } from '@assistant-ui/react'
import { cleanup, render } from '../../../test/workspace'
import { SCENE_CONTRACT, SCENE_PART } from '@/components/chat/scene-model'
import { useComposerReferences } from '@/components/chat/composer-references'
import { messageIdOf, readSceneArtifact } from './artifact-model'
import type { TheoremArtifact } from './artifact-model'

void mock.module('@/components/icons', () => ({
  Icon: new Proxy({}, { get: () => () => null }),
}))
const { ArtifactPanel } = await import('./artifact-panel')

const part = {
  contractVersion: SCENE_CONTRACT,
  sceneId: 'cpu',
  title: 'How does a CPU work?',
  fallbackText: 'A simplified RISC-V processor.',
  packageHash: 'a'.repeat(64),
  scenePackage: { id: 'cpu', atoms: [] },
}

const thread: ThreadMessageLike[] = [
  { id: 'q1', role: 'user', content: [{ type: 'text', text: 'How?' }] },
  {
    id: 'reply-1',
    role: 'assistant',
    status: { type: 'complete', reason: 'stop' },
    content: [{ type: 'data', name: SCENE_PART, data: part }],
  },
]

type PageWindow = { sent: unknown[]; postMessage: (message: unknown) => void }
const pages = new WeakMap<HTMLIFrameElement, PageWindow>()
const contentWindow = Object.getOwnPropertyDescriptor(
  HTMLIFrameElement.prototype,
  'contentWindow',
)
Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', {
  configurable: true,
  get(this: HTMLIFrameElement) {
    let page = pages.get(this)
    if (!page) {
      const sent: unknown[] = []
      page = { sent, postMessage: (message) => void sent.push(message) }
      pages.set(this, page)
    }
    return page
  },
})
const report = console.error.bind(console)
const quiet = spyOn(console, 'error').mockImplementation((...args) => {
  if (!String(args[0]).includes('Iframe page loading is disabled'))
    report(...args)
})
afterAll(() => {
  quiet.mockRestore()
  if (contentWindow)
    Object.defineProperty(
      HTMLIFrameElement.prototype,
      'contentWindow',
      contentWindow,
    )
  else Reflect.deleteProperty(HTMLIFrameElement.prototype, 'contentWindow')
})
afterEach(() => {
  cleanup()
  useComposerReferences.setState({ references: [] })
})

const sentTurns: unknown[] = []

/** Kept from another chat: its revisions and the conversation they came from. */
type Elsewhere = { versions: readonly TheoremArtifact[]; threadId: string }

function Dock({ elsewhere }: { elsewhere?: Elsewhere }) {
  const runtime = useExternalStoreRuntime({
    messages: thread,
    isRunning: false,
    onNew: async (message) => void sentTurns.push(message),
    convertMessage: (item: ThreadMessageLike) => item,
    adapters: {
      threadList: {
        threadId: 't1',
        threads: [{ status: 'regular', id: 't1', remoteId: 'thread_remote_1' }],
      },
    },
  })
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ArtifactPanel
        artifactId="scene:cpu"
        versions={elsewhere?.versions}
        threadId={elsewhere?.threadId}
        onClose={() => {}}
      />
    </AssistantRuntimeProvider>
  )
}

async function panel(elsewhere?: Elsewhere) {
  const rendered = await render(<Dock elsewhere={elsewhere} />)
  const frame = rendered.container.querySelector('iframe')
  if (!frame?.contentWindow) throw new Error('no scene frame in the panel')
  const page = frame.contentWindow as unknown as PageWindow
  const fromPage = (data: unknown) =>
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data,
          source: page as unknown as Window,
        }),
      )
    })
  const button = (name: string) =>
    [...rendered.container.querySelectorAll('button')].find(
      (b) => b.textContent === name,
    )
  return { ...rendered, page, fromPage, button }
}

test('the reply that carries a revision is found by the artifact it reads to', () => {
  const messages = thread as unknown as ThreadMessage[]
  expect(
    messageIdOf(messages, {
      artifactId: 'scene:cpu',
      revision: 'a'.repeat(64),
    }),
  ).toBe('reply-1')
  expect(
    messageIdOf(messages, { artifactId: 'scene:cpu', revision: 'other' }),
  ).toBeUndefined()
  expect(
    messageIdOf(messages, {
      artifactId: 'scene:gpu',
      revision: 'a'.repeat(64),
    }),
  ).toBeUndefined()
})

test('a scene in the panel keeps Ask, referring to the reply that carries it', async () => {
  const { page, fromPage } = await panel()
  fromPage({ type: 'sceneos:host-ready' })
  expect(page.sent[0]).toMatchObject({ type: 'sceneos:mount', ask: true })
  fromPage({ type: 'sceneos:mounted', ok: true })

  const alu = { id: 'alu', label: 'ALU' }
  fromPage({ type: 'sceneos:ask', entity: alu })
  const [reference] = useComposerReferences.getState().references
  expect(reference).toMatchObject({
    label: 'How does a CPU work?: ALU',
    location: {
      resource: {
        kind: 'message',
        threadId: 'thread_remote_1',
        messageId: 'reply-1',
      },
    },
  })
})

test('a scene in the panel that fails offers Fix, which asks in this thread', async () => {
  const { fromPage, button } = await panel()
  fromPage({ type: 'sceneos:host-ready' })
  fromPage({
    type: 'sceneos:mounted',
    ok: false,
    error: {
      stage: 'mount',
      message: 'ctx.canvas is null',
      line: 3,
      column: 1,
    },
  })
  const fix = button('Fix')
  expect(fix).toBeDefined()
  await act(async () => fix?.click())
  expect(sentTurns).toHaveLength(1)
})

test('a scene kept from another chat offers neither Ask nor Fix, so nothing reaches the chat on screen', async () => {
  const kept = readSceneArtifact(part)
  if (!kept) throw new Error('the scene part did not read')
  const turns = sentTurns.length
  const { page, fromPage, button, container } = await panel({
    versions: [kept],
    threadId: 'thread_origin',
  })
  expect(container.textContent).toContain('From another chat')
  fromPage({ type: 'sceneos:host-ready' })
  expect(page.sent[0]).toMatchObject({ type: 'sceneos:mount', ask: false })
  fromPage({
    type: 'sceneos:mounted',
    ok: false,
    error: {
      stage: 'mount',
      message: 'ctx.canvas is null',
      line: 3,
      column: 1,
    },
  })
  expect(button('Fix')).toBeUndefined()
  fromPage({ type: 'sceneos:ask', entity: { id: 'alu', label: 'ALU' } })
  expect(useComposerReferences.getState().references).toHaveLength(0)
  expect(sentTurns).toHaveLength(turns)
})
