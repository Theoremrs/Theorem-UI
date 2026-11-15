// SOURCING: @assistant-ui/react's runtime API (thread.getState / subscribe / append / startRun / cancelRun and threads.switchToThread / switchToNewThread, the same calls components/terminal/terminal-screen.tsx makes) for the transcript and every turn; lib/theorem/approval's approvalChoice for which option an allow or deny sends. Run input and approval answers are not on the runtime (they are Theorem run commands), so they arrive as `services`. No model connection is opened here.

import type { CreateAppendMessage, ThreadMessage } from '@assistant-ui/react'
import type { Actor } from '../wire/Actor'
import type { ApprovalDecision } from '../wire/ApprovalDecision'
import type { HostMessage } from '../wire/HostMessage'
import { approvalChoice } from '@/lib/theorem/approval'
import { accepted, failure, refused } from '../environment/result'
import type { Answers, Completion } from '../environment/result'
import { runIdOf, transcriptOf } from './transcript'
import type { Transcript } from './transcript'

/** The part of an assistant-ui `AssistantRuntime` this owner reads and drives. */
export interface ConversationRuntime {
  thread: {
    getState: () => {
      readonly messages: readonly ThreadMessage[]
      readonly isRunning: boolean
      readonly isLoading: boolean
      readonly isDisabled: boolean
      readonly capabilities: {
        readonly edit: boolean
        readonly reload: boolean
      }
    }
    subscribe: (listener: () => void) => () => void
    append: (message: CreateAppendMessage) => void
    startRun: (config: { parentId: string | null }) => void
    cancelRun: () => void
  }
  threads: {
    getState: () => { readonly mainThreadId: string }
    subscribe: (listener: () => void) => () => void
    mainItem: { getState: () => { readonly remoteId?: string | undefined } }
    switchToThread: (threadId: string) => Promise<void>
    switchToNewThread: () => Promise<void>
  }
}

/** What the chat sends to Theorem that the runtime does not carry. A rejection is read as an SDK request error. */
export interface ConversationServices {
  answerApproval: (request: {
    runId: string
    approvalId: string
    toolCallId: string
    choice: { optionId: string } | { decision: ApprovalDecision }
  }) => Promise<void>
  /** Words for a run that is working; they join it and never stop it. */
  sendInput: (request: {
    runId: string
    inputId: string
    text: string
  }) => Promise<void>
}

export interface QueuedInput {
  clientMessageId: string
  text: string
  state: 'sending' | 'queued' | 'failed' | 'uncertain'
  reason?: string
}

export interface ConversationSnapshot extends Transcript {
  /** The thread's durable id when it has one, else the runtime's local id. */
  conversationId: string
  /** Goes up by one each time the content changes, across conversation switches. A lower one than already seen is stale. */
  revision: number
  loading: boolean
  /** Input sent while a run worked and not yet shown in the transcript. */
  queued: QueuedInput[]
}

interface Request {
  requestId: string
  /** The conversation the caller drew; a different current one makes the action stale. */
  conversationId?: string
}

export interface Sent {
  clientMessageId: string
  messageId?: string
}

export interface Conversation {
  snapshot: () => ConversationSnapshot
  /** Delivers coalesced snapshots, at most one per frame; a run ending or a switch delivers at once. */
  subscribe: (listener: (snapshot: ConversationSnapshot) => void) => () => void
  /** A turn, when no run is working. The same `clientMessageId` never sends twice. */
  send: (
    request: Request & {
      clientMessageId: string
      text: string
      attachments?: Extract<CreateAppendMessage, object>['attachments']
    },
  ) => Promise<Completion<Sent>>
  /** Words for the run that is working. */
  input: (
    request: Request & {
      clientMessageId: string
      text: string
      /** The run the person saw working; another one working now makes the input stale. */
      runId?: string
    },
  ) => Promise<Completion<Sent>>
  /** `runId` names the run the person saw; absent means whichever run the thread has now. */
  stop: (
    request: Request & { runId?: string },
  ) => Promise<Completion<{ runId?: string }>>
  /** Runs the reply to a user message again as a new branch. */
  retry: (
    request: Request & { messageId: string },
  ) => Promise<Completion<{ messageId: string }>>
  /** Sends changed text for a user message as a new branch. */
  edit: (
    request: Request & {
      messageId: string
      clientMessageId: string
      text: string
    },
  ) => Promise<Completion<Sent>>
  approve: (
    request: Request & {
      approvalId: string
      decision: ApprovalDecision
      actor: Actor
      /** The run that asked; a different one is stale. */
      runId?: string
    },
  ) => Promise<Completion<{ approvalId: string }>>
  switchTo: (
    request: Request & { threadId: string },
  ) => Promise<Completion<{ conversationId: string }>>
  create: (request: Request) => Promise<Completion<{ conversationId: string }>>
  /**
   * A second conversation beside this one, on its own runtime and its own conversation resource.
   * Nothing sent to it reaches this one's runtime. Closing it disposes its conversation and its runtime.
   */
  sideChat: (request: Request) => Promise<Completion<SideChat>>
  dispose: () => void
}

/** A runtime made for a side chat, and how to end it. */
export interface SideRuntime {
  runtime: ConversationRuntime
  /** Ends the runtime; nothing more is sent through it. */
  close: () => void
}

/** What makes side-chat runtimes: a second instance of the factory the main runtime came from. */
export interface SideChats {
  open: () => Promise<SideRuntime>
}

export interface SideChat {
  /** The side chat's own conversation, with its own id, snapshots and actions. */
  conversation: Conversation
  conversationId: string
  close: () => void
}

export interface ConversationOptions {
  runtime: ConversationRuntime
  /** Absent when the host has no way to make a second runtime: a side chat is then refused as missing. */
  sideChats?: SideChats
  services: ConversationServices
  workspaceId: string
  /** Runs `callback` at the next frame and returns its cancel. Defaults to requestAnimationFrame. */
  schedule?: (callback: () => void) => () => void
}

const REMEMBERED = 256

const nextFrame = (callback: () => void) => {
  if (typeof requestAnimationFrame === 'function') {
    const id = requestAnimationFrame(callback)
    return () => cancelAnimationFrame(id)
  }
  const id = setTimeout(callback, 16)
  return () => clearTimeout(id)
}

/** The wire message that carries a snapshot to the Rust side. */
export function snapshotMessage(
  project: string,
  snapshot: ConversationSnapshot,
): Extract<HostMessage, { type: 'conversationSnapshot' }> {
  return {
    type: 'conversationSnapshot',
    resource: {
      type: 'conversation',
      project,
      thread: snapshot.conversationId,
    },
    conversationId: snapshot.conversationId,
    revision: { scheme: 'seq', value: snapshot.revision },
    snapshot: JSON.stringify(snapshot),
  }
}

export function createConversation({
  runtime,
  sideChats,
  services,
  workspaceId,
  schedule = nextFrame,
}: ConversationOptions): Conversation {
  const sides = new Set<SideChat>()
  const listeners = new Set<(snapshot: ConversationSnapshot) => void>()
  let disposed = false
  let pending: (() => void) | undefined
  let revision = 0
  let lastBody = ''
  let last: ConversationSnapshot | undefined
  let delivered = 0
  let deliveredKey = ''

  /** What was sent from here, by client message id: a repeated id returns the first answer. */
  const sends = new Map<string, Completion<Sent>>()
  const inFlight = new Map<string, Promise<Completion<Sent>>>()
  const outbox = new Map<string, QueuedInput>()
  /** Approvals an answer went out for; an answer that was accepted or whose result is unknown stands. */
  const answered = new Set<string>()

  const conversationId = () =>
    runtime.threads.mainItem.getState().remoteId ??
    runtime.threads.getState().mainThreadId

  function build(): ConversationSnapshot {
    const state = runtime.thread.getState()
    const transcript = transcriptOf(state.messages, state.isRunning)
    const shown = new Set(
      transcript.messages.flatMap((m) =>
        m.parts.flatMap((p) =>
          p.type === 'input' && p.inputId ? [p.inputId] : [],
        ),
      ),
    )
    const body = {
      conversationId: conversationId(),
      loading: state.isLoading,
      ...transcript,
      queued: [...outbox.values()].filter((q) => !shown.has(q.clientMessageId)),
    }
    const text = JSON.stringify(body)
    if (text !== lastBody || !last) {
      lastBody = text
      revision += 1
      last = { ...body, revision }
    }
    return last
  }

  function flush() {
    pending?.()
    pending = undefined
    if (disposed) return
    const snapshot = build()
    deliveredKey = key()
    if (snapshot.revision === delivered) return
    delivered = snapshot.revision
    for (const listener of [...listeners]) {
      try {
        listener(snapshot)
      } catch (error) {
        queueMicrotask(() => {
          throw error
        })
      }
    }
  }

  /** What changes the meaning of a snapshot, not just its text: a run starting or ending, or another thread. */
  const key = () => `${conversationId()}|${runtime.thread.getState().isRunning}`

  function changed() {
    if (disposed || listeners.size === 0) return
    if (key() !== deliveredKey) flush()
    else if (!pending)
      pending = schedule(() => {
        pending = undefined
        flush()
      })
  }

  const offThread = runtime.thread.subscribe(changed)
  const offThreads = runtime.threads.subscribe(changed)

  function begin(request: Request) {
    const answers: Answers = { workspaceId, requestId: request.requestId }
    if (disposed)
      return {
        answers,
        refusal: refused(answers, 'disposed', 'The conversation is closed'),
      }
    if (request.conversationId && request.conversationId !== conversationId())
      return {
        answers,
        refusal: refused(
          answers,
          'stale_conversation',
          'That conversation is no longer the open one',
        ),
      }
    return { answers, refusal: undefined }
  }

  const remember = (id: string, completion: Completion<Sent>) => {
    sends.set(id, completion)
    if (sends.size > REMEMBERED) sends.delete(sends.keys().next().value!)
    return completion
  }

  const found = (clientMessageId: string) =>
    runtime.thread
      .getState()
      .messages.find(
        (m) =>
          (m.metadata.custom as { clientMessageId?: unknown } | undefined)
            ?.clientMessageId === clientMessageId,
      )

  /** Appends a user message and says whether the thread took it. A throw before it shows is unknown: it may have gone out. */
  function append(
    answers: Answers,
    clientMessageId: string,
    message: Extract<CreateAppendMessage, object>,
  ): Completion<Sent> {
    try {
      runtime.thread.append({
        ...message,
        role: 'user',
        startRun: true,
        metadata: { custom: { clientMessageId } },
      })
    } catch (error) {
      return remember(clientMessageId, failure(answers, error, true))
    }
    const shown = found(clientMessageId)
    return remember(
      clientMessageId,
      shown
        ? accepted(answers, { clientMessageId, messageId: shown.id })
        : {
            ...answers,
            outcome: 'uncertain',
            reason: 'The runtime did not show the message after it was sent',
          },
    )
  }

  const once = (
    request: Request & { clientMessageId: string },
    send: (answers: Answers) => Promise<Completion<Sent>> | Completion<Sent>,
  ): Promise<Completion<Sent>> => {
    const { answers, refusal } = begin(request)
    if (refusal) return Promise.resolve(refusal)
    const id = request.clientMessageId
    const before = sends.get(id)
    if (before) return Promise.resolve({ ...before, ...answers })
    const shown = found(id)
    if (shown)
      return Promise.resolve(
        accepted(answers, { clientMessageId: id, messageId: shown.id }),
      )
    const running = inFlight.get(id)
    if (running) return running.then((c) => ({ ...c, ...answers }))
    const attempt = Promise.resolve(send(answers)).finally(() =>
      inFlight.delete(id),
    )
    inFlight.set(id, attempt)
    return attempt
  }

  const userMessage = (messageId: string) => {
    const messages = runtime.thread.getState().messages
    const at = messages.findIndex((m) => m.id === messageId)
    const message = messages[at]
    return message?.role === 'user'
      ? { message, parentId: messages[at - 1]?.id ?? null }
      : undefined
  }

  /** The run working now: the latest message's run id. */
  function lastRunId() {
    const messages = runtime.thread.getState().messages
    const message = messages.at(-1)
    return message ? runIdOf(message) : undefined
  }

  return {
    snapshot: () => build(),

    subscribe(listener) {
      if (disposed) return () => {}
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },

    send(request) {
      return once(request, (answers) => {
        const state = runtime.thread.getState()
        if (state.isRunning)
          return refused(
            answers,
            'run_active',
            'A run is working; send input to it or stop it first',
          )
        if (state.isDisabled || state.isLoading)
          return refused(
            answers,
            'unavailable',
            'The conversation cannot take a message right now',
          )
        return append(answers, request.clientMessageId, {
          content: [{ type: 'text', text: request.text }],
          attachments: request.attachments,
        })
      })
    },

    input(request) {
      return once(request, async (answers) => {
        const id = request.clientMessageId
        const runId = runtime.thread.getState().isRunning
          ? lastRunId()
          : undefined
        if (!runId)
          return refused(answers, 'no_active_run', 'No run is working')
        if (request.runId !== undefined && request.runId !== runId)
          return refused(
            answers,
            'stale_run',
            'That run is no longer the one working',
          )
        outbox.set(id, {
          clientMessageId: id,
          text: request.text,
          state: 'sending',
        })
        changed()
        try {
          await services.sendInput({ runId, inputId: id, text: request.text })
        } catch (error) {
          const result = failure(answers, error, true)
          outbox.set(id, {
            clientMessageId: id,
            text: request.text,
            state: result.outcome === 'uncertain' ? 'uncertain' : 'failed',
            reason: 'reason' in result ? result.reason : undefined,
          })
          changed()
          // A refusal sent nothing and may be tried again with the same id.
          return result.outcome === 'uncertain' ? remember(id, result) : result
        }
        outbox.set(id, {
          clientMessageId: id,
          text: request.text,
          state: 'queued',
        })
        changed()
        return remember(id, accepted(answers, { clientMessageId: id }))
      })
    },

    async stop(request) {
      const { answers, refusal } = begin(request)
      if (refusal) return refusal
      const state = runtime.thread.getState()
      if (!state.isRunning)
        return refused(answers, 'not_running', 'No run is working')
      const runId = lastRunId()
      if (request.runId !== undefined && request.runId !== runId)
        return refused(
          answers,
          'stale_run',
          'That run is no longer the one working',
        )
      try {
        runtime.thread.cancelRun()
      } catch (error) {
        return failure(answers, error, true)
      }
      return accepted(answers, { runId })
    },

    async retry(request) {
      const { answers, refusal } = begin(request)
      if (refusal) return refusal
      const state = runtime.thread.getState()
      if (state.isRunning)
        return refused(answers, 'run_active', 'A run is working')
      if (!state.capabilities.reload)
        return refused(
          answers,
          'missing_capability',
          'This conversation cannot run a reply again',
        )
      const at = state.messages.findIndex((m) => m.id === request.messageId)
      const target = state.messages[at]
      if (!target)
        return refused(
          answers,
          'not_found',
          'That message is not in the thread',
        )
      const parent =
        target.role === 'assistant' ? state.messages[at - 1] : target
      if (!parent || parent.role !== 'user')
        return refused(
          answers,
          'not_found',
          'That reply has no message to answer',
        )
      try {
        runtime.thread.startRun({ parentId: parent.id })
      } catch (error) {
        return failure(answers, error, true)
      }
      return accepted(answers, { messageId: parent.id })
    },

    edit(request) {
      return once(request, (answers) => {
        const state = runtime.thread.getState()
        if (state.isRunning)
          return refused(answers, 'run_active', 'A run is working')
        if (!state.capabilities.edit)
          return refused(
            answers,
            'missing_capability',
            'This conversation cannot edit a sent message',
          )
        const target = userMessage(request.messageId)
        if (!target)
          return refused(
            answers,
            'not_found',
            'That user message is not in the thread',
          )
        return append(answers, request.clientMessageId, {
          parentId: target.parentId,
          sourceId: target.message.id,
          content: [{ type: 'text', text: request.text }],
        })
      })
    },

    async approve(request) {
      const { answers, refusal } = begin(request)
      if (refusal) return refusal
      if (request.actor.type !== 'human')
        return refused(
          answers,
          'human_only',
          'A model cannot answer an approval',
        )
      const now = transcriptOf(
        runtime.thread.getState().messages,
        runtime.thread.getState().isRunning,
      ).approval
      if (answered.has(request.approvalId))
        return refused(
          answers,
          'already_answered',
          'That approval was answered',
        )
      if (!now || now.approvalId !== request.approvalId)
        return refused(
          answers,
          'approval_not_pending',
          'That approval is not waiting for an answer',
        )
      if (request.runId !== undefined && request.runId !== now.runId)
        return refused(
          answers,
          'stale_run',
          'That approval belongs to another run',
        )
      const choice = approvalChoice(now.options, request.decision === 'allow')
      if (!choice)
        return refused(
          answers,
          'no_option',
          'The approval offers no option for that answer',
        )
      answered.add(request.approvalId)
      try {
        await services.answerApproval({
          runId: now.runId,
          approvalId: now.approvalId,
          toolCallId: now.toolCallId,
          choice,
        })
      } catch (error) {
        const result = failure(answers, error, true)
        // A refusal applied nothing, so the person may answer again.
        if (result.outcome === 'refused') answered.delete(request.approvalId)
        return result
      }
      return accepted(answers, { approvalId: request.approvalId })
    },

    async switchTo(request) {
      const { answers, refusal } = begin(request)
      if (refusal) return refusal
      try {
        await runtime.threads.switchToThread(request.threadId)
      } catch (error) {
        return failure(answers, error, false)
      }
      return accepted(answers, { conversationId: conversationId() })
    },

    async create(request) {
      const { answers, refusal } = begin(request)
      if (refusal) return refusal
      try {
        await runtime.threads.switchToNewThread()
      } catch (error) {
        return failure(answers, error, false)
      }
      return accepted(answers, { conversationId: conversationId() })
    },

    async sideChat(request) {
      const { answers, refusal } = begin(request)
      if (refusal) return refusal
      if (!sideChats)
        return refused(
          answers,
          'missing_capability',
          'This host makes no second runtime for a side chat',
        )
      let side: SideRuntime
      try {
        side = await sideChats.open()
      } catch (error) {
        return failure(answers, error, false)
      }
      if (disposed) {
        side.close()
        return refused(answers, 'disposed', 'The conversation is closed')
      }
      const conversation = createConversation({
        runtime: side.runtime,
        services,
        workspaceId,
        schedule,
      })
      let closed = false
      const chat: SideChat = {
        conversation,
        conversationId: conversation.snapshot().conversationId,
        close() {
          if (closed) return
          closed = true
          sides.delete(chat)
          conversation.dispose()
          side.close()
        },
      }
      sides.add(chat)
      return accepted(answers, chat)
    },

    dispose() {
      if (disposed) return
      disposed = true
      for (const chat of [...sides]) chat.close()
      pending?.()
      pending = undefined
      offThread()
      offThreads()
      listeners.clear()
    },
  }
}
