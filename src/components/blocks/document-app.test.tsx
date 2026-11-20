import { act } from 'react'
import type { ReactNode } from 'react'
import * as esbuild from 'esbuild-wasm'
import { call } from '@/lib/blocks/sandbox/protocol'
import type { DossierState, PageMethods } from '@/lib/blocks/sandbox/protocol'
import { BLOCK_SANDBOX } from '@/lib/blocks/executor'
import * as hosted from '@/lib/blocks/hosted-app'
import { afterEach, expect, spyOn, test } from 'bun:test'
import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
} from '@assistant-ui/react'
import type { AppendMessage, ThreadMessageLike } from '@assistant-ui/react'
import type { TheoremContextReference } from '@theoremharness/sdk'
import { AppDocument } from '@/lib/theorem/apps'
import { useComposerReferences } from '@/components/chat/composer-references'
import { DOSSIER_METADATA } from '@/lib/theorem/app-dossier'
import { connectAppFrame } from '../../../test/blocks/app-frame'
import { appDocumentFixture } from '../../../test/blocks/app-documents'
import {
  buttonNamed,
  cleanup,
  click,
  render,
  waitFor,
} from '../../../test/blocks/render'
import { DocumentAppView } from './document-app'

const originalHosted = hosted.hostedAppDocument

afterEach(cleanup)

const revision = (container: HTMLElement) =>
  container.querySelector('[data-revision]')?.getAttribute('data-revision')

test('the App view identifies its current revision and sends a precise durable reference', async () => {
  const store = await appDocumentFixture()
  await store.remote('<p>Updated</p>')
  const app = new AppDocument('app-document', store.api, store.change)
  const { container } = await render(
    <DocumentAppView app={app} pinnedPosition={1} />,
  )
  await waitFor(() => buttonNamed(container, 'Ask about this App'))
  expect(revision(container)).toBe('2')
  expect(container.textContent).toContain('Changed since this result')
  expect(container.textContent).not.toMatch(/revision \d/i)
  expect(container.querySelector('iframe')).toBeNull()
  await click(buttonNamed(container, 'Ask about this App')!)
  expect(useComposerReferences.getState().take()).toMatchObject([
    {
      location: {
        revision: '2',
        resource: {
          kind: 'graph-object',
          objectId: 'app-document',
          objectType: 'theorem.app',
        },
      },
    },
  ])
})

test('the App view exposes the actual failed save and retry recovers the same document', async () => {
  const store = await appDocumentFixture()
  const app = new AppDocument('app-document', store.api, store.change)
  const { container } = await render(<DocumentAppView app={app} />)
  await waitFor(() => buttonNamed(container, 'Edit source'))
  const snapshot = app.getSnapshot()!
  store.fail(true)
  await act(() =>
    app.saveSource('<p>Changed</p>', snapshot.revision).catch(() => {}),
  )
  await waitFor(() => container.querySelector('[role="alert"]'))
  expect(container.textContent).toContain('Document store unavailable')
  expect(container.textContent).not.toContain('Saved')
  store.fail(false)
  await act(() => app.saveSource('<p>Changed</p>', snapshot.revision))
  await waitFor(() => !container.querySelector('[role="alert"]'))
  expect(revision(container)).toBe('2')
})

test('replacing App source unmounts its old sandbox before granting new capabilities', async () => {
  const store = await appDocumentFixture()
  const app = new AppDocument('app-document', store.api, store.change)
  const original = hosted.hostedAppDocument
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const compile = spyOn(hosted, 'hostedAppDocument').mockImplementation(
    async (html) => {
      if (html.includes('New source')) await gate
      return original(html, esbuild)
    },
  )
  try {
    const { container } = await render(<DocumentAppView app={app} />)
    await waitFor(() => buttonNamed(container, 'Run App'))
    await click(buttonNamed(container, 'Run App')!)
    const old = await waitFor(() => container.querySelector('iframe'), 10_000)
    expect(old.getAttribute('sandbox')).toBe(BLOCK_SANDBOX)
    await store.remote(
      `<meta name="theorem:uses" content='net("example.com")'><p>New source</p>`,
    )
    await act(() => app.load())
    expect(container.querySelector('iframe')).toBeNull()
    expect(old.isConnected).toBe(false)
    await act(async () => release())
    const next = await waitFor(() => container.querySelector('iframe'), 10_000)
    expect(next.src).not.toBe(old.src)
    await click(buttonNamed(container, 'Stop App')!)
    expect(container.querySelector('iframe')).toBeNull()
  } finally {
    release()
    compile.mockRestore()
  }
}, 20_000)

for (const failed of [false, true]) {
  test(`App Ask refuses ${failed ? 'failed' : 'in-flight'} state and drops dirty selection after save`, async () => {
    useComposerReferences.getState().take()
    const store = await appDocumentFixture()
    await store.remote(
      `<meta name="theorem:uses" content='state("rows")'><p>Stateful</p>`,
    )
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const revise = store.api.revise
    store.api.revise = async (request) => {
      await gate
      return revise(request)
    }
    store.fail(failed)
    const app = new AppDocument('app-document', store.api, store.change)
    const compile = spyOn(hosted, 'hostedAppDocument').mockImplementation(
      (html) => originalHosted(html, esbuild),
    )
    let close = () => {}
    try {
      const { container } = await render(<DocumentAppView app={app} />)
      await waitFor(() => buttonNamed(container, 'Run App'))
      await click(buttonNamed(container, 'Run App')!)
      const connected = await connectAppFrame(container)
      close = connected.close
      const select = (text: string) =>
        act(() =>
          call<PageMethods, 'frame.selection'>(
            connected.rpc,
            'frame.selection',
            { text, rowId: 'row' },
          ),
        )
      await select('Saved row')
      expect(buttonNamed(container, 'Ask about selection')).toBeDefined()
      let saving!: Promise<unknown>
      await act(async () => {
        saving = call<PageMethods, 'state.set'>(connected.rpc, 'state.set', {
          name: 'rows',
          key: 'row',
          value: 'Unsaved row',
        }).catch(() => undefined)
        await new Promise((resolve) => setTimeout(resolve, 10))
      })
      expect(buttonNamed(container, 'Ask about selection')).toBeUndefined()
      await select('Unsaved row')
      if (failed) {
        await act(async () => {
          release()
          await saving
        })
        await waitFor(() => buttonNamed(container, 'Retry save'))
      }
      const ask = buttonNamed(container, /Ask about/)!
      expect(ask.disabled).toBe(true)
      expect(container.textContent).toContain(
        'Save the App changes before asking',
      )
      await click(ask)
      expect(useComposerReferences.getState().take()).toEqual([])
      if (failed) {
        store.fail(false)
        await click(buttonNamed(container, 'Retry save')!)
      } else {
        await act(async () => {
          release()
          await saving
        })
      }
      await waitFor(() => !buttonNamed(container, /Ask about/)!.disabled)
      expect(buttonNamed(container, 'Ask about selection')).toBeUndefined()
      await click(buttonNamed(container, 'Ask about this App')!)
      const [reference] = useComposerReferences.getState().take()
      expect(reference).toMatchObject({ location: { revision: '3' } })
      expect(reference?.excerpt).toBeUndefined()
      await select('Saved updated row')
      await click(buttonNamed(container, 'Ask about selection')!)
      expect(useComposerReferences.getState().take()[0]).toMatchObject({
        location: { revision: '3' },
        excerpt: JSON.stringify({
          selection: { text: 'Saved updated row', rowId: 'row' },
        }),
      })
    } finally {
      release()
      close()
      compile.mockRestore()
    }
  }, 20_000)
}

// The page's conversation, as an App's dossier reaches it in a test: one thread,
// whose turn the test runs and ends, recording what the App sent. assistant-ui's
// external-store runtime is what the transcript's App mounts against in the app.
const NO_TURN: ThreadMessageLike[] = []

function Conversation({
  threadId,
  running,
  sent,
  children,
}: {
  threadId: string
  running: boolean
  sent: Array<AppendMessage>
  children: ReactNode
}) {
  const runtime = useExternalStoreRuntime({
    messages: NO_TURN,
    isRunning: running,
    onNew: async (message: AppendMessage) => {
      sent.push(message)
    },
    convertMessage: (item: ThreadMessageLike) => item,
    adapters: { threadList: { threadId } },
  })
  return (
    <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>
  )
}

type Frame = Awaited<ReturnType<typeof connectAppFrame>>

/** The App's own account of its questions, as its frame reads it. */
const watch = (frame: Frame) =>
  call<PageMethods, 'dossier.watch'>(frame.rpc, 'dossier.watch', {})

/** What the App is told of its questions, once it says `want`. */
async function untilWatched(
  frame: Frame,
  want: (state: DossierState) => boolean,
): Promise<DossierState> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const state = await watch(frame)
    if (want(state)) return state
    await act(() => new Promise((resolve) => setTimeout(resolve, 10)))
  }
  throw new Error("the App was never told what the test asked it to hold")
}

const letRun = () => act(() => new Promise((resolve) => setTimeout(resolve, 30)))

/** What the dossier writes on the conversation, as the test reads it back. */
type Sent = {
  content: ReadonlyArray<{ type: string; text?: string }>
  metadata?: { custom?: Record<string, unknown> }
  runConfig?: { custom?: Record<string, unknown> }
}

const sentAs = (message: AppendMessage) => message as unknown as Sent

const askedText = (message: AppendMessage) =>
  sentAs(message)
    .content.flatMap((part) => (part.type === 'text' && part.text ? [part.text] : []))
    .join('\n\n')

const askedReferences = (message: AppendMessage) =>
  (sentAs(message).runConfig?.custom?.theoremContextReferences ??
    []) as TheoremContextReference[]

const heldOf = (state: DossierState) =>
  state.messages.filter((message) => message.queued)

/** The App, mounted inside a conversation whose turn the test drives. */
async function appInConversation(
  app: AppDocument,
  sent: Array<AppendMessage>,
  { threadId = 'thread-a', running = true } = {},
) {
  const view = await render(
    <Conversation threadId={threadId} running={running} sent={sent}>
      <DocumentAppView app={app} initiallyRunning />
    </Conversation>,
  )
  return { view, frame: await connectAppFrame(view.container) }
}

test('questions held while the turn runs survive the revision flip and go, in order, when it ends', async () => {
  const store = await appDocumentFixture()
  await store.remote('<p>Shortlist</p>')
  const app = new AppDocument('app-document', store.api, store.change)
  const sent: Array<AppendMessage> = []
  const compile = spyOn(hosted, 'hostedAppDocument').mockImplementation((html) =>
    originalHosted(html, esbuild),
  )
  const frames: Array<Frame> = []
  try {
    const asked = await appInConversation(app, sent)
    frames.push(asked.frame)
    const askedRevision = app.getSnapshot()!.revision.position
    for (const text of ['Why is the top row red?', 'Add a column for price']) {
      await call<PageMethods, 'dossier.ask'>(asked.frame.rpc, 'dossier.ask', {
        text,
        context: {},
      })
    }
    // Asking while the turn runs holds the questions: it does not stop the turn.
    expect(sent).toEqual([])

    // The agent adds a revision in a new message. The transcript's old card flips
    // to latest=false and its App view unmounts; the new message mounts a fresh
    // view of the same App in the same conversation.
    await store.remote('<p>Shortlist, revised</p>')
    await asked.view.unmount()
    const flip = await appInConversation(app, sent)
    frames.push(flip.frame)

    // What one mount was holding belongs to the App and its conversation, so the
    // next mount still has it: it shows them as held, in the order they were asked.
    const held = await untilWatched(flip.frame, (state) => heldOf(state).length === 2)
    expect(heldOf(held).map((message) => message.text)).toEqual([
      'Why is the top row red?',
      'Add a column for price',
    ])

    // The turn ends: they go, in order, each naming the revision it was asked
    // about rather than the one the new mount shows.
    await flip.view.rerender(
      <Conversation threadId="thread-a" running={false} sent={sent}>
        <DocumentAppView app={app} initiallyRunning />
      </Conversation>,
    )
    await waitFor(() => (sent.length === 2 ? sent : null))
    expect(sent.map(askedText)).toEqual([
      'Why is the top row red?',
      'Add a column for price',
    ])
    for (const message of sent)
      expect(sentAs(message).metadata?.custom?.[DOSSIER_METADATA]).toMatchObject({
        documentId: 'app-document',
      })
    expect(
      sent.map((message) => askedReferences(message)[0]?.location.revision),
    ).toEqual([String(askedRevision), String(askedRevision)])
    // Gone, so nothing is left held.
    const after = await untilWatched(flip.frame, (state) => heldOf(state).length === 0)
    expect(after.messages).toEqual([])
  } finally {
    for (const frame of frames) frame.close()
    compile.mockRestore()
  }
}, 30_000)

test('a question asked in one conversation is never sent to another: it waits for the one it was asked in', async () => {
  const store = await appDocumentFixture()
  await store.remote('<p>Shortlist</p>')
  const app = new AppDocument('app-document', store.api, store.change)
  const sent: Array<AppendMessage> = []
  const compile = spyOn(hosted, 'hostedAppDocument').mockImplementation((html) =>
    originalHosted(html, esbuild),
  )
  const frames: Array<Frame> = []
  try {
    const asked = await appInConversation(app, sent)
    frames.push(asked.frame)
    await call<PageMethods, 'dossier.ask'>(asked.frame.rpc, 'dossier.ask', {
      text: 'Why is the top row red?',
      context: {},
    })
    expect(sent).toEqual([])

    // The old view unmounts as the revision flip takes it, and the App is next
    // open in a different conversation, whose turn has ended.
    await asked.view.unmount()
    const elsewhere = await appInConversation(app, sent, { threadId: 'thread-b' })
    frames.push(elsewhere.frame)
    await letRun()
    // It is not this conversation's question: nothing goes here, and this App
    // view does not show it as one of its own.
    expect(sent).toEqual([])
    expect(heldOf(await watch(elsewhere.frame))).toEqual([])

    // The conversation it was asked in is open again: now it goes, there.
    await elsewhere.view.rerender(
      <Conversation threadId="thread-a" running={true} sent={sent}>
        <DocumentAppView app={app} initiallyRunning />
      </Conversation>,
    )
    const waiting = await untilWatched(elsewhere.frame, (state) => heldOf(state).length === 1)
    expect(heldOf(waiting).map((message) => message.text)).toEqual([
      'Why is the top row red?',
    ])
    await elsewhere.view.rerender(
      <Conversation threadId="thread-a" running={false} sent={sent}>
        <DocumentAppView app={app} initiallyRunning />
      </Conversation>,
    )
    const [one] = await waitFor(() => (sent.length === 1 ? sent : null))
    expect(askedText(one!)).toBe('Why is the top row red?')
  } finally {
    for (const frame of frames) frame.close()
    compile.mockRestore()
  }
}, 30_000)

test('two views of one App in one conversation send a held question once', async () => {
  const store = await appDocumentFixture()
  await store.remote('<p>Shortlist</p>')
  const app = new AppDocument('app-document', store.api, store.change)
  // The transcript's card and the dock's panel are one App in one conversation,
  // under one runtime, so the turn ending commits both of them together.
  const sent: Array<AppendMessage> = []
  const bothViews = (
    running: boolean,
  ) => (
    <Conversation threadId="thread-a" running={running} sent={sent}>
      <div data-slot="card">
        <DocumentAppView app={app} initiallyRunning />
      </div>
      <div data-slot="panel">
        <DocumentAppView app={app} initiallyRunning />
      </div>
    </Conversation>
  )
  const compile = spyOn(hosted, 'hostedAppDocument').mockImplementation((html) =>
    originalHosted(html, esbuild),
  )
  const frames: Array<Frame> = []
  try {
    const view = await render(bothViews(true))
    const inCard = await connectAppFrame(
      view.container.querySelector('[data-slot="card"]') as HTMLElement,
    )
    const inPanel = await connectAppFrame(
      view.container.querySelector('[data-slot="panel"]') as HTMLElement,
    )
    frames.push(inCard, inPanel)
    // Asked from one of them, and held there.
    await call<PageMethods, 'dossier.ask'>(inCard.rpc, 'dossier.ask', {
      text: 'Why is the top row red?',
      context: {},
    })
    expect(sent).toEqual([])
    // The turn ends: both views drain in the same commit, and it goes once.
    await view.rerender(bothViews(false))
    await letRun()
    expect(sent).toHaveLength(1)
    expect(askedText(sent[0]!)).toBe('Why is the top row red?')
  } finally {
    for (const frame of frames) frame.close()
    compile.mockRestore()
  }
}, 30_000)

test('a question that cannot be sent stays, marked with why, through every remount of the App', async () => {
  const store = await appDocumentFixture()
  await store.remote('<p>Shortlist</p>')
  const app = new AppDocument('app-document', store.api, store.change)
  const sent: Array<AppendMessage> = []
  const compile = spyOn(hosted, 'hostedAppDocument').mockImplementation((html) =>
    originalHosted(html, esbuild),
  )
  const frames: Array<Frame> = []
  // A subject that cannot fit the reference's limit: the question is asked of a
  // source whose commit is larger than a reference may hold.
  const context = {
    subject: {
      kind: 'source',
      source: { kind: 'commit', repository: 'r', commit: 'c'.repeat(9_000) },
    },
  }
  try {
    const asked = await appInConversation(app, sent)
    frames.push(asked.frame)
    await call<PageMethods, 'dossier.ask'>(asked.frame.rpc, 'dossier.ask', {
      text: 'What broke in this commit?',
      context,
    })
    expect(sent).toEqual([])

    // The revision flip: a fresh view, same conversation and App, now idle.
    await asked.view.unmount()
    const first = await appInConversation(app, sent, { running: false })
    frames.push(first.frame)
    const refusedState = await untilWatched(
      first.frame,
      (state) => state.messages.some((message) => message.undelivered !== undefined),
    )
    // Nothing vanished and nothing was sent: it is kept, with why it could not go.
    expect(sent).toEqual([])
    const [refused] = refusedState.messages
    expect(refusedState.messages).toHaveLength(1)
    expect(refused?.text).toBe('What broke in this commit?')
    expect(refused?.role).toBe('user')
    expect(refused?.status).toBe('incomplete')
    expect(refused?.undelivered).toContain('more than the 8192')
    expect(refused?.queued).toBeUndefined()

    // Another flip: still there, still marked, still not sent again.
    await first.view.unmount()
    const second = await appInConversation(app, sent, { running: false })
    frames.push(second.frame)
    await letRun()
    const keptState = await watch(second.frame)
    expect(sent).toEqual([])
    expect(keptState.messages).toHaveLength(1)
    const [kept] = keptState.messages
    expect(kept?.text).toBe('What broke in this commit?')
    expect(kept?.status).toBe('incomplete')
    expect(kept?.undelivered).toContain('more than the 8192')
  } finally {
    for (const frame of frames) frame.close()
    compile.mockRestore()
  }
}, 30_000)
