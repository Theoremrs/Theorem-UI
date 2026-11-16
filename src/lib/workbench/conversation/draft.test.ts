// SOURCING: none — bun:test over ./conversation and ./port with a stub runtime whose thread composer behaves as assistant-ui's does (a send prepares a submission, then hands the thread a message, or returns the draft when an upload fails); no network
import { describe, expect, test } from 'bun:test'
import type { Attachment } from '@assistant-ui/react'
import type { TheoremContextReference } from '@theoremharness/sdk'
import type { DraftAttachment, Effect, HostMessage } from '../wire'
import { createConversation } from './conversation'
import type {
  ConversationRuntime,
  ConversationServices,
  ModelServices,
} from './conversation'
import { createConversationPort } from './port'
import { StubRuntime, assistant } from './test-runtime'

type Mode = 'ok' | 'upload-fails' | 'vanish'

/** What assistant-ui's thread composer does with a draft, as far as the owner reads it. */
class StubComposer {
  text = ''
  attachments: Attachment[] = []
  accept = 'image/*,text/plain'
  submission: unknown
  inTransit: unknown[] = []
  mode: Mode = 'ok'
  sends = 0
  constructor(private stub: StubRuntime) {}

  runtime: NonNullable<ConversationRuntime['composer']> = {
    getState: () => ({
      text: this.text,
      attachments: this.attachments,
      attachmentAccept: this.accept,
      submission: this.submission,
      inTransit: this.inTransit,
    }),
    setText: (text) => {
      this.text = text
      this.stub.emit()
    },
    addAttachment: async (file) => {
      const ok = this.accept
        .split(',')
        .some((rule) =>
          rule.endsWith('/*')
            ? file.type.startsWith(rule.slice(0, -1))
            : file.type.startsWith(rule),
        )
      if (!ok) throw new Error(`File type ${file.type} is not accepted`)
      this.attachments = [
        ...this.attachments,
        {
          id: `att-${this.attachments.length + 1}`,
          type: 'document',
          name: file.name,
          contentType: file.type,
          file,
          status: { type: 'requires-action', reason: 'composer-send' },
        },
      ]
      this.stub.emit()
    },
    removeAttachment: async (id) => {
      this.attachments = this.attachments.filter((a) => a.id !== id)
      this.stub.emit()
    },
    send: () => {
      this.sends += 1
      const text = this.text
      const named = this.attachments
      this.submission = { text }
      this.text = ''
      this.attachments = []
      this.stub.emit()
      queueMicrotask(() => {
        this.submission = undefined
        if (this.mode === 'upload-fails') {
          this.text = text
          this.attachments = named.map((a) => ({
            ...a,
            status: {
              type: 'incomplete',
              reason: 'error',
              message: 'The upload was refused',
            },
          })) as Attachment[]
        } else if (this.mode === 'ok') {
          this.stub.messages.push({
            id: `sent-${this.sends}`,
            role: 'user',
            createdAt: new Date(0),
            content: [{ type: 'text', text }],
            attachments: [],
            metadata: { custom: {} },
          } as never)
        }
        this.stub.emit()
      })
    },
  }
}

const file = (name: string, type: string, size = 3) =>
  new File([new Uint8Array(size)], name, { type })

function setup(extra: Partial<ConversationServices> = {}) {
  const stub = new StubRuntime()
  const composer = new StubComposer(stub)
  stub.runtime.composer = composer.runtime
  const added: TheoremContextReference[][] = []
  const removed: TheoremContextReference[][] = []
  const picks: string[] = []
  let chosen: File[] = []
  const services: ConversationServices = {
    answerApproval: async () => {},
    sendInput: async () => ({ inputId: 'in-1' }),
    references: {
      add: (references) => {
        added.push(references)
        return references
      },
      remove: (references) => void removed.push(references),
    },
    pickFiles: async (accept) => {
      picks.push(accept)
      return chosen
    },
    ...extra,
  }
  const conversation = createConversation({
    runtime: stub.runtime,
    services,
    workspaceId: 'w1',
    schedule: () => () => {},
  })
  const lists: DraftAttachment[][] = []
  conversation.onAttachments((list) => lists.push(list))
  return {
    stub,
    composer,
    conversation,
    added,
    removed,
    picks,
    lists,
    choose: (files: File[]) => (chosen = files),
  }
}

const base = { requestId: 'r1' }

describe('draft attachments', () => {
  test('a file the intake takes joins the draft as ready, and the whole list is delivered', async () => {
    const { conversation, lists } = setup()
    await conversation.addFiles([file('a.png', 'image/png', 7)])
    expect(lists.at(-1)).toEqual([
      {
        id: 'att-1',
        name: 'a.png',
        contentType: 'image/png',
        size: 7,
        state: 'ready',
      },
    ])
  })

  test('a type the intake does not take is a refused entry with the reason, and stays until removed', async () => {
    const { conversation, lists } = setup()
    await conversation.addFiles([file('a.exe', 'application/x-msdownload')])
    const [entry] = lists.at(-1)!
    expect(entry).toMatchObject({
      name: 'a.exe',
      state: 'refused',
      reason: 'File type application/x-msdownload is not accepted',
    })
    expect(
      await conversation.removeAttachment({ ...base, id: entry!.id }),
    ).toMatchObject({ outcome: 'accepted' })
    expect(lists.at(-1)).toEqual([])
  })

  test('a file the composer holds but its adapter failed is refused with the adapter message', async () => {
    const { conversation, composer, lists } = setup()
    await conversation.addFiles([file('a.txt', 'text/plain')])
    composer.attachments = composer.attachments.map((a) => ({
      ...a,
      status: { type: 'incomplete', reason: 'error', message: 'Too large' },
    })) as Attachment[]
    composer.runtime.setText('')
    expect(lists.at(-1)).toMatchObject([
      { state: 'refused', reason: 'Too large' },
    ])
  })

  test('the chooser opens with the adapter accept list and adds each chosen file', async () => {
    const { conversation, picks, choose, lists } = setup()
    choose([file('a.png', 'image/png'), file('b.txt', 'text/plain')])
    const done = await conversation.attachPick(base)
    expect(picks).toEqual(['image/*,text/plain'])
    expect(done).toMatchObject({ outcome: 'accepted', value: { added: 2 } })
    expect(lists.at(-1)!.map((a) => a.name)).toEqual(['a.png', 'b.txt'])
  })

  test('cancelling the chooser is accepted with nothing added', async () => {
    const { conversation, choose, lists } = setup()
    choose([])
    expect(await conversation.attachPick(base)).toMatchObject({
      outcome: 'accepted',
      value: { added: 0 },
    })
    expect(lists).toEqual([])
  })

  test('a runtime with no attachment adapter refuses the chooser', async () => {
    const { conversation, composer } = setup()
    composer.accept = '*'
    expect(await conversation.attachPick(base)).toMatchObject({
      outcome: 'refused',
      code: 'missing_capability',
    })
  })

  test('removing a file the draft does not hold is refused', async () => {
    const { conversation } = setup()
    expect(
      await conversation.removeAttachment({ ...base, id: 'nope' }),
    ).toMatchObject({ outcome: 'refused', code: 'unknown_attachment' })
  })

  test('canAttach needs a composer and a chooser', () => {
    expect(setup().conversation.canAttach).toBe(true)
    expect(setup({ pickFiles: undefined }).conversation.canAttach).toBe(false)
    const stub = new StubRuntime()
    const bare = createConversation({
      runtime: stub.runtime,
      services: {
        answerApproval: async () => {},
        sendInput: async () => ({ inputId: 'in-1' }),
      },
      workspaceId: 'w1',
    })
    expect(bare.canAttach).toBe(false)
    expect(bare.canPickModel).toBe(false)
  })
})

describe('send from the draft', () => {
  const send = (
    conversation: ReturnType<typeof setup>['conversation'],
    over: Record<string, unknown> = {},
  ) =>
    conversation.send({
      ...base,
      clientMessageId: 'c1',
      text: 'see this',
      draftIds: ['att-1'],
      ...over,
    })

  test('the composer uploads and sends; the message it became is the answer, and the same id never sends twice', async () => {
    const { conversation, composer } = setup()
    await conversation.addFiles([file('a.png', 'image/png')])
    const done = await send(conversation)
    expect(done).toMatchObject({
      outcome: 'accepted',
      value: { clientMessageId: 'c1', messageId: 'sent-1' },
    })
    expect(composer.sends).toBe(1)
    expect(await send(conversation)).toMatchObject({ outcome: 'accepted' })
    expect(composer.sends).toBe(1)
  })

  test('what the person had typed in the React composer stays there', async () => {
    const { conversation, composer } = setup()
    await conversation.addFiles([file('a.png', 'image/png')])
    composer.text = 'half a thought'
    await send(conversation)
    expect(composer.text).toBe('half a thought')
  })

  test('an upload that fails is a clean failure: nothing was sent, and the draft keeps its text', async () => {
    const { conversation, composer } = setup()
    await conversation.addFiles([file('a.png', 'image/png')])
    composer.mode = 'upload-fails'
    const done = await send(conversation)
    expect(done).toMatchObject({
      outcome: 'failed',
      reason: 'The upload was refused',
    })
  })

  test('a message that never shows is uncertain, not failed, and is not asked again', async () => {
    const { conversation, composer } = setup()
    await conversation.addFiles([file('a.png', 'image/png')])
    composer.mode = 'vanish'
    expect(await send(conversation)).toMatchObject({ outcome: 'uncertain' })
    composer.mode = 'ok'
    expect(await send(conversation)).toMatchObject({ outcome: 'uncertain' })
    expect(composer.sends).toBe(1)
  })

  test('a send that does not name everything the draft holds is refused', async () => {
    const { conversation } = setup()
    await conversation.addFiles([
      file('a.png', 'image/png'),
      file('b.txt', 'text/plain'),
    ])
    expect(await send(conversation)).toMatchObject({
      outcome: 'refused',
      code: 'attachments_differ',
    })
  })

  test('an unknown id and a refused file are refused with their own codes', async () => {
    const { conversation } = setup()
    expect(await send(conversation, { draftIds: ['zzz'] })).toMatchObject({
      outcome: 'refused',
      code: 'unknown_attachment',
    })
    await conversation.addFiles([file('a.exe', 'application/x-msdownload')])
    const [entry] = conversation.attachments()
    expect(
      await send(conversation, {
        clientMessageId: 'c2',
        draftIds: [entry!.id],
      }),
    ).toMatchObject({ outcome: 'refused', code: 'attachment_refused' })
  })

  test('draft attachments and uploaded ones are not mixed', async () => {
    const { conversation } = setup()
    await conversation.addFiles([file('a.png', 'image/png')])
    expect(
      await send(conversation, {
        attachments: [
          {
            id: 'u',
            type: 'document',
            name: 'u',
            status: { type: 'complete' },
            content: [],
          },
        ],
      }),
    ).toMatchObject({ outcome: 'refused', code: 'attachments_mixed' })
  })

  test('a run that is working refuses the send, as any send', async () => {
    const { conversation, stub } = setup()
    await conversation.addFiles([file('a.png', 'image/png')])
    stub.isRunning = true
    expect(await send(conversation)).toMatchObject({
      outcome: 'refused',
      code: 'run_active',
    })
  })
})

describe('references', () => {
  const reference = {
    path: 'src/a.ts',
    range: {
      start: { line: 1, character: 2 },
      end: { line: 3, character: 4 },
    },
    label: 'a.ts:2',
    excerpt: 'let a',
  }

  test('a send puts each reference in the composer store as the SDK shapes it, for the file in the workspace', async () => {
    const { conversation, added } = setup()
    await conversation.send({
      ...base,
      clientMessageId: 'c1',
      text: 'look',
      references: [reference, { path: 'README.md' }],
    })
    expect(added).toEqual([
      [
        {
          location: {
            resource: { kind: 'file', workspaceId: 'w1', path: 'src/a.ts' },
            range: { ...reference.range, unit: 'utf16' },
          },
          excerpt: 'let a',
          label: 'a.ts:2',
        },
        {
          location: {
            resource: { kind: 'file', workspaceId: 'w1', path: 'README.md' },
          },
        },
      ],
    ])
  })

  test('an edit carries them too', async () => {
    const { conversation, added, stub } = setup()
    await conversation.send({ ...base, clientMessageId: 'c1', text: 'one' })
    await conversation.edit({
      ...base,
      messageId: stub.messages[0]!.id,
      clientMessageId: 'c2',
      text: 'two',
      references: [{ path: 'a.ts' }],
    })
    expect(added).toHaveLength(1)
  })

  test('a send that is refused leaves no reference behind', async () => {
    const { conversation, added, removed, stub } = setup()
    stub.isRunning = true
    const done = await conversation.send({
      ...base,
      clientMessageId: 'c1',
      text: 'look',
      references: [{ path: 'a.ts' }],
    })
    expect(done).toMatchObject({ outcome: 'refused', code: 'run_active' })
    expect(added).toEqual([])
    expect(removed).toEqual([])
  })

  test('a send that fails after its references were added takes them out again', async () => {
    const { conversation, added, removed, stub } = setup()
    stub.appendThrows = new Error('offline')
    const done = await conversation.send({
      ...base,
      clientMessageId: 'c1',
      text: 'look',
      references: [{ path: 'a.ts' }],
    })
    expect(done.outcome).toBe('uncertain')
    expect(removed).toEqual([])
    expect(added).toHaveLength(1)
  })

  test('a host that cannot carry references refuses a send that names some', async () => {
    const { conversation } = setup({ references: undefined })
    expect(
      await conversation.send({
        ...base,
        clientMessageId: 'c1',
        text: 'look',
        references: [{ path: 'a.ts' }],
      }),
    ).toMatchObject({ outcome: 'refused', code: 'missing_capability' })
  })
})

describe('models', () => {
  function models() {
    const state = {
      selected: undefined as string | undefined,
      efforts: new Map<string, string>(),
      listeners: new Set<() => void>(),
    }
    const touch = () => state.listeners.forEach((l) => l())
    const services: ModelServices = {
      catalog: async () => ({
        defaultRef: 'p/small',
        models: [
          {
            ref: 'p/small',
            label: 'Small',
            contextTokens: 8000,
            effortLevels: [],
          },
          {
            ref: 'p/big',
            label: 'Big',
            effortLevels: ['low', 'high'],
          },
        ],
      }),
      selected: () => state.selected,
      select: (ref) => {
        state.selected = ref
        touch()
      },
      effort: (thread) => state.efforts.get(thread ?? ''),
      setEffort: (thread, level) => {
        state.efforts.set(thread ?? '', level)
        touch()
      },
      levels: ['low', 'medium', 'high'],
      subscribe: (listener) => {
        state.listeners.add(listener)
        return () => state.listeners.delete(listener)
      },
    }
    return { state, services }
  }

  test('answers with the catalog, Theorem’s default when nothing was picked, and the efforts that model takes', async () => {
    const { services } = models()
    const { conversation } = setup({ models: services })
    expect(await conversation.models(base)).toMatchObject({
      outcome: 'accepted',
      value: {
        models: [
          { ref: 'p/small', label: 'Small', contextTokens: 8000 },
          { ref: 'p/big', label: 'Big' },
        ],
        selected: 'p/small',
        efforts: [],
      },
    })
  })

  test('picking a model sets what the composer picker sets and sends the message again once', async () => {
    const { services, state } = models()
    const { conversation } = setup({ models: services })
    const seen: unknown[] = []
    conversation.onModels((s) => seen.push(s))
    await conversation.models(base)
    seen.length = 0
    const done = await conversation.setModel({ ...base, ref: 'p/big' })
    expect(state.selected).toBe('p/big')
    expect(done).toMatchObject({
      outcome: 'accepted',
      value: { selected: 'p/big', efforts: ['low', 'high'] },
    })
    expect(seen).toHaveLength(1)
  })

  test('a model the catalog does not list is refused and nothing is set', async () => {
    const { services, state } = models()
    const { conversation } = setup({ models: services })
    expect(
      await conversation.setModel({ ...base, ref: 'p/none' }),
    ).toMatchObject({ outcome: 'refused', code: 'unknown_model' })
    expect(state.selected).toBeUndefined()
  })

  test('an effort is set on the open thread; one the model does not take is refused', async () => {
    const { services, state } = models()
    const { conversation } = setup({ models: services })
    await conversation.setModel({ ...base, ref: 'p/big' })
    expect(
      await conversation.setEffort({ ...base, level: 'high' }),
    ).toMatchObject({ outcome: 'accepted', value: { effort: 'high' } })
    expect(state.efforts.get('remote-1')).toBe('high')
    expect(
      await conversation.setEffort({ ...base, level: 'max' }),
    ).toMatchObject({ outcome: 'refused', code: 'unknown_effort' })
  })

  test('a pick made in the React composer after the first request is delivered here', async () => {
    const { services } = models()
    const { conversation } = setup({ models: services })
    const seen: { selected?: string }[] = []
    conversation.onModels((s) => seen.push(s))
    await conversation.models(base)
    services.select('p/big')
    expect(seen.at(-1)?.selected).toBe('p/big')
  })

  test('a catalog that cannot be read is a failure, not an empty list', async () => {
    const { services } = models()
    const { conversation } = setup({
      models: {
        ...services,
        catalog: async () => {
          throw new Error('down')
        },
      },
    })
    expect(await conversation.models(base)).toMatchObject({
      outcome: 'failed',
      reason: 'down',
    })
  })

  test('without a models service it is refused as missing', async () => {
    const { conversation } = setup()
    expect(await conversation.models(base)).toMatchObject({
      outcome: 'refused',
      code: 'missing_capability',
    })
  })
})

describe('context use', () => {
  const usage = (data: unknown) => ({
    type: 'data',
    name: 'theorem-usage',
    data,
  })

  test('the snapshot carries what the newest run reported of the window', () => {
    const { conversation, stub } = setup()
    stub.messages.push(
      assistant('a1', 'hi', {
        parts: [usage({ contextTokens: 1200, contextWindow: 8000 })],
      }),
    )
    expect(conversation.snapshot().context).toEqual({
      usedTokens: 1200,
      windowTokens: 8000,
    })
  })

  test('without a window there is no context, and no number is made up', () => {
    const { conversation, stub } = setup()
    expect(conversation.snapshot().context).toBeUndefined()
    stub.messages.push(
      assistant('a1', 'hi', { parts: [usage({ contextTokens: 1200 })] }),
    )
    expect('context' in conversation.snapshot()).toBe(false)
  })
})

describe('port', () => {
  function ported(extra: Partial<ConversationServices> = {}) {
    const made = setup(extra)
    const port = createConversationPort({
      conversation: made.conversation,
      project: 'p1',
    })
    const messages: HostMessage[] = []
    port.subscribe!((m) => messages.push(m))
    let id = 0
    const perform = (kind: Effect['kind'], payload?: unknown) =>
      port.perform(
        {
          id: (id += 1),
          resource: { type: 'conversation', project: 'p1', thread: 'remote-1' },
          kind,
          ...(payload === undefined ? {} : { payload }),
        } as never,
        `req-${id}`,
      )
    return { ...made, port, perform, messages }
  }

  test('attach pick answers accepted, and the draft list goes out as a host message', async () => {
    const { perform, choose, messages, port } = ported()
    choose([file('a.png', 'image/png')])
    expect(await perform('conversationAttachPick')).toEqual({
      outcome: 'accepted',
    })
    expect(
      messages.findLast((m) => m.type === 'conversationAttachments'),
    ).toEqual({
      type: 'conversationAttachments',
      resource: { type: 'conversation', project: 'p1', thread: 'remote-1' },
      conversationId: 'remote-1',
      attachments: [
        {
          id: 'att-1',
          name: 'a.png',
          contentType: 'image/png',
          size: 3,
          state: 'ready',
        },
      ],
    })
    expect(port.canAttach).toBe(true)
  })

  test('attach remove routes the id', async () => {
    const { perform, choose, conversation } = ported()
    choose([file('a.png', 'image/png')])
    await perform('conversationAttachPick')
    expect(await perform('conversationAttachRemove', { id: 'att-1' })).toEqual({
      outcome: 'accepted',
    })
    expect(conversation.attachments()).toEqual([])
  })

  test('a send names draft ids and carries references', async () => {
    const { perform, choose, added } = ported()
    choose([file('a.png', 'image/png')])
    await perform('conversationAttachPick')
    const done = await perform('conversationSend', {
      clientMessageId: 'c1',
      text: 'hi',
      attachments: [{ id: 'att-1', name: 'a.png' }],
      references: [{ path: 'a.ts' }],
    })
    expect(done).toMatchObject({
      outcome: 'accepted',
      value: { type: 'conversationSent', clientMessageId: 'c1' },
    })
    expect(added).toHaveLength(1)
  })

  test('a send naming an id the draft does not hold sends it as an uploaded file, as before', async () => {
    const { perform, stub } = ported()
    await perform('conversationSend', {
      clientMessageId: 'c1',
      text: 'hi',
      attachments: [{ id: 'up-1', name: 'a.png', contentType: 'image/png' }],
    })
    expect(stub.appends[0]).toMatchObject({
      attachments: [
        { id: 'up-1', type: 'image', status: { type: 'complete' } },
      ],
    })
  })

  test('models, set model and set effort route, and the models message follows each', async () => {
    const models = {
      catalog: async () => ({
        models: [{ ref: 'p/big', label: 'Big', effortLevels: ['low', 'high'] }],
      }),
      selected: () => undefined as string | undefined,
      select: () => {},
      effort: () => undefined as string | undefined,
      setEffort: () => {},
      levels: ['low'],
      subscribe: () => () => {},
    } satisfies ModelServices
    const { perform, messages, port } = ported({ models })
    expect(await perform('conversationModels')).toEqual({ outcome: 'accepted' })
    expect(messages.findLast((m) => m.type === 'conversationModels')).toEqual({
      type: 'conversationModels',
      resource: { type: 'conversation', project: 'p1', thread: 'remote-1' },
      conversationId: 'remote-1',
      models: [{ ref: 'p/big', label: 'Big' }],
      efforts: ['low'],
    })
    expect(await perform('conversationSetModel', { ref: 'p/big' })).toEqual({
      outcome: 'accepted',
    })
    expect(await perform('conversationSetEffort', { level: 'low' })).toEqual({
      outcome: 'accepted',
    })
    expect(
      messages.filter((m) => m.type === 'conversationModels'),
    ).toHaveLength(3)
    expect(
      await perform('conversationSetModel', { ref: 'nope' }),
    ).toMatchObject({ outcome: 'refused', code: 'unknown_model' })
    expect(port.canPickModel).toBe(true)
  })
})
