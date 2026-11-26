// SOURCING: @assistant-ui/react's runtime API (thread.getState / subscribe / append / startRun / cancelRun and threads.switchToThread / switchToNewThread, the same calls components/terminal/terminal-screen.tsx makes) for the transcript and every turn; lib/theorem/approval's approvalChoice for which option an allow or deny sends. Run input and approval answers are not on the runtime (they are Theorem run commands), so they arrive as `services`. No model connection is opened here.

import type {
  Attachment,
  CreateAppendMessage,
  ThreadMessage,
} from '@assistant-ui/react'
import type { TheoremContextReference } from '@theoremharness/sdk'
import type { Actor } from '../wire/Actor'
import type { ApprovalDecision } from '../wire/ApprovalDecision'
import type { DraftAttachment } from '../wire/DraftAttachment'
import type { HostMessage } from '../wire/HostMessage'
import type { ModelChoice } from '../wire/ModelChoice'
import type { SourceReference } from '../wire/SourceReference'
import { contextOf } from '@/lib/face/operations'
import { approvalChoice } from '@/lib/theorem/approval'
import { describeError, hasStatus, pendingSendText } from '@/lib/theorem/client'
import {
  createRunInputQueue,
  inputReceipt,
  pendingInputKey,
} from '@/lib/theorem/run-input'
import type {
  InputReceipt,
  PendingRunInput,
  RunInputHost,
  RunInputQueue,
} from '@/lib/theorem/run-input'
import {
  dismissRunInput,
  registerRunInputQueue,
  retryRunInput,
  stopRunInputs,
  submitRunInput,
  useRunInputs,
} from '@/lib/theorem/run-input-store'
import { workingRuns } from '@/lib/theorem/working-runs'
import type { ThreadTree } from '@/lib/theorem/thread-origin'
import { accepted, failure, refused } from '../environment/result'
import type { Answers, Completion } from '../environment/result'
import { reason as readableReason } from '../environment/workspace-recovery'
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
  /** The thread composer: its draft attachments and the one send that uploads them. Absent: no draft attachments. */
  composer?: {
    getState: () => {
      readonly text: string
      readonly attachments: readonly Attachment[]
      /** The adapter's `accept` list; `*` when the runtime has no attachment adapter. */
      readonly attachmentAccept: string
      /** The message the composer is preparing (uploading its files) before it hands it to the thread. */
      readonly submission?: unknown
      /** Messages handed to the thread that it does not show yet. */
      readonly inTransit?: readonly unknown[] | undefined
    }
    setText: (text: string) => void
    addAttachment: (file: File) => Promise<void>
    removeAttachment: (id: string) => Promise<void>
    send: () => void
  }
  threads: {
    getState: () => { readonly mainThreadId: string }
    subscribe: (listener: () => void) => () => void
    mainItem: {
      getState: () => {
        /** The runtime's own id for the thread now open; the chat's queue is registered under it. */
        readonly id?: string | undefined
        readonly remoteId?: string | undefined
      }
    }
    switchToThread: (threadId: string) => Promise<void>
    switchToNewThread: () => Promise<void>
    /** Reads the open thread again, as it is stored (after its selected branch changed). */
    reloadMainThread?: () => Promise<void>
  }
}

/**
 * The thread as Theorem stores it, for words sent to a run: whether a run works
 * and which one, the input it holds, and the user text already on it. The
 * authoritative half of a send's settlement — what a local stream cannot tell.
 */
export interface RunInputThread {
  active: boolean
  runId?: string
  inputs: readonly InputReceipt[]
  /** User text the thread holds, so a fallback need not send it again. */
  userTexts?: readonly string[]
}

/** What the chat sends to Theorem that the runtime does not carry. A rejection is read as an SDK request error. */
export interface ConversationServices {
  answerApproval: (request: {
    runId: string
    approvalId: string
    toolCallId: string
    choice: { optionId: string } | { decision: ApprovalDecision }
  }) => Promise<void>
  /**
   * Words for a run that is working; they join it and never stop it. The host
   * answers with what Theorem confirmed for this request — the key the send went
   * under names it. A host that reports nothing leaves the thread's own record
   * (`runInput`) to settle whether the run took the words.
   */
  sendInput: (request: {
    runId: string
    /** The idempotency key: the message this one is, never a fresh one per attempt. */
    inputId: string
    text: string
  }) => Promise<InputReceipt | void>
  /**
   * Says which project a thread is to open under before it is switched to (a thread placed in several
   * projects, picked under one of them), or takes that back with no project when the switch fails. Absent:
   * the host opens every thread where it decides.
   */
  openUnder?: (threadId: string, projectId: string | undefined) => void
  /** The thread's branches and standing, read when it opens and when a run ends. Absent: snapshots carry no history. */
  history?: (threadId: string) => Promise<ThreadTree | null>
  /**
   * What Theorem stores about words sent to a run, read to settle one the local
   * stream has not shown: whether the run still works, and what became of the
   * input it was given. Absent: an accepted send cannot be confirmed or settled,
   * so its words stay listed and nothing more is sent for them.
   */
  runInput?: {
    thread: (threadId: string) => Promise<RunInputThread>
    /** A closed run's input receipts, read once it has finished recording them. */
    receipts: (runId: string) => Promise<readonly InputReceipt[]>
  }
  /** Makes a branch the thread's selected one, as the thread list does. */
  selectBranch?: (threadId: string, branchId: string) => Promise<unknown>
  /** Puts context references in the composer's store, which the next turn carries as the React composer's do. */
  references?: {
    /** Returns the references that were not already there. */
    add: (references: TheoremContextReference[]) => TheoremContextReference[]
    remove: (references: TheoremContextReference[]) => void
  }
  /** The browser's file chooser, with the adapter's `accept` list. Resolves to nothing when the person cancels. */
  pickFiles?: (accept: string) => Promise<File[]>
  models?: ModelServices
}

/** One model of Theorem's catalog, as the picker reads it. */
export interface ModelCatalogEntry {
  ref: string
  label: string
  contextTokens?: number
  /** The effort levels a turn can ask this model for; empty when it takes none. */
  effortLevels: readonly string[]
}

/** What the picker's stores hold, as the owner reads and sets them. Never reaches a model provider. */
export interface ModelServices {
  catalog: () => Promise<{
    models: readonly ModelCatalogEntry[]
    defaultRef?: string
  }>
  /** The model the next turn runs on, when one was picked. */
  selected: () => string | undefined
  select: (ref: string) => void
  /** The effort a turn from this thread asks for: its own, else the account's. `undefined` is the draft thread. */
  effort: (thread: string | undefined) => string | undefined
  setEffort: (thread: string | undefined, level: string) => void
  /** Every level, for a model the catalog does not list. */
  levels: readonly string[]
  /** Called when the pick or any effort changes, wherever it was changed. */
  subscribe: (listener: () => void) => () => void
}

/** What `conversationModels` carries. */
export interface ModelsState {
  models: ModelChoice[]
  selected?: string
  effort?: string
  efforts: string[]
}

/** What a thread's history needs of its tree: the branches, which one is selected, and where the thread came from. */
export interface ConversationHistory {
  rootBranchId: string
  selectedBranchId: string
  /** Every branch but the root, oldest first. */
  forks: {
    branchId: string
    parentBranchId?: string
    forkedAfterMessageId?: string
    createdAtMs: number
  }[]
  /** A run in progress on the authority, which may be another tab's. */
  activeRunId: string | null
  lastRunOutcome?: string
  lastReplyAtMs?: number
  /** The thread this one was forked or continued from. */
  origin?: ThreadTree['origin']
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
  /**
   * Words kept for a run, listed under the composer with their own state: on their way,
   * waiting for the run's next step, settled for the next turn, or kept with a reason to
   * Retry. One queue decides each row's standing; this lists what it announces.
   */
  queued: QueuedInput[]
  /** The thread's versions and branches; absent until Theorem has answered, or for a thread it does not hold yet. */
  history?: ConversationHistory
  /** How full the model's window was at its last request, as the run reported it; absent until a run reports both. */
  context?: { usedTokens: number; windowTokens: number }
  /** The owner's clock when it made the snapshot, so a panel draws a running call's elapsed time without reading a clock. Not sent by the owner today. */
  nowMs?: number
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
      /** Draft attachments to send: exactly the ones the composer holds. Uploaded when the message goes. */
      draftIds?: string[]
      references?: SourceReference[]
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
  /** Drops a queued input the owner keeps, by the id its row carries. */
  dismissInput: (
    request: Request & { clientMessageId: string },
  ) => Promise<Completion<{ clientMessageId: string }>>
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
      references?: SourceReference[]
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
    request: Request & { threadId: string; projectId?: string },
  ) => Promise<Completion<{ conversationId: string }>>
  create: (request: Request) => Promise<Completion<{ conversationId: string }>>
  /**
   * Selects a branch of a stored thread and opens that thread as it is stored. The thread and branch must
   * exist; a branch that is already selected changes nothing. The snapshot that follows carries the new `history`.
   * An answer that was lost is `uncertain` and is not asked again here.
   */
  switchBranch: (
    request: Request & { threadId: string; branchId: string },
  ) => Promise<Completion<{ conversationId: string }>>
  /** Whether branches can be selected here: the host reads and sets them. */
  canSwitchBranch: boolean
  /**
   * A second conversation beside this one, on its own runtime and its own conversation resource.
   * Nothing sent to it reaches this one's runtime. Closing it disposes its conversation and its runtime.
   */
  sideChat: (
    request: Request & {
      scope?: SideChatScope
      /** A side chat's own stored thread to show again, with any run still working there. */
      reopen?: string
    },
  ) => Promise<Completion<SideChat>>
  /**
   * The side chats open now, oldest first, then the ones closed here whose thread can be reopened
   * (`detached`), most recently closed first. Theorem keeps no mark that tells a side chat's thread from
   * any other thread (a forked or continued thread looks the same whoever made it), so this is the
   * session's own record, kept in its storage: a new tab starts with none, and a side chat's durable
   * thread remains in the thread list either way.
   */
  sideChats: () => SideChatInfo[]
  /** Whether this host can make the second runtime a side chat needs. */
  canSideChat: boolean
  /** The files in the draft of the next turn, in the order they were added, then the ones refused. */
  attachments: () => DraftAttachment[]
  /** Delivers the whole list after every change. */
  onAttachments: (
    listener: (attachments: DraftAttachment[]) => void,
  ) => () => void
  /** Opens the file chooser and adds what is chosen. Cancel adds nothing and is not a refusal. */
  attachPick: (request: Request) => Promise<Completion<{ added: number }>>
  /** Adds pasted or dropped files through the same path as the chooser. */
  addFiles: (files: File[]) => Promise<void>
  removeAttachment: (
    request: Request & { id: string },
  ) => Promise<Completion<{ id: string }>>
  /** Whether draft attachments exist here: a composer and a file chooser. */
  canAttach: boolean
  /** Reads the catalog, the pick and the effort, and starts delivering them when they change. */
  models: (request: Request) => Promise<Completion<ModelsState>>
  setModel: (
    request: Request & { ref: string },
  ) => Promise<Completion<ModelsState>>
  setEffort: (
    request: Request & { level: string },
  ) => Promise<Completion<ModelsState>>
  onModels: (listener: (state: ModelsState) => void) => () => void
  /** The runs a working turn's edits come from (its own and its delegations'), by Follow the Agent's rule; empty while none works. */
  followedRuns: () => string[]
  /** Delivers the followed runs when the set changes, never when it is the same again. */
  onFollowedRuns: (listener: (runs: string[]) => void) => () => void
  /** Delivers the runs seen to finish here: ones that left the set while the same thread stayed open. */
  onRunsEnded: (listener: (runs: string[]) => void) => () => void
  /** Whether a model can be picked here. */
  canPickModel: boolean
  dispose: () => void
}

/**
 * What a side chat starts from, as far as Theorem can honour it:
 * - `fresh`: a new thread in the main conversation's project, nothing carried over;
 * - `continued`: a new, empty thread with the main conversation's thread available to it as context;
 * - `forked`: a new thread holding the main conversation's history through its last stored message.
 * `continued` and `forked` name the main conversation's stored thread, so they need one.
 */
export type SideChatScope = 'fresh' | 'continued' | 'forked'

/** How many closed side chats the session keeps to reopen. */
const DETACHED_LIMIT = 20

/** A runtime made for a side chat, and how to end it. */
export interface SideRuntime {
  runtime: ConversationRuntime
  /** The side chat's own stored thread, once it has one (a forked or continued one has it from the start). */
  threadId: () => string | undefined
  /** Ends the runtime; nothing more is sent through it. */
  close: () => void
}

/** What makes side-chat runtimes: a second instance of the factory the main runtime came from. */
export interface SideChats {
  /** What the side chats are kept under, such as their project; closed ones reopen only under it. */
  key?: string
  /** `from` is the main conversation's stored thread, present for `continued` and `forked`. */
  open: (request: {
    scope: SideChatScope
    from?: string
    /** A side chat's own stored thread to show again; its history loads and a live run resumes. */
    reopen?: string
  }) => Promise<SideRuntime>
}

export interface SideChat {
  /** The side chat's own conversation, with its own snapshots and actions. */
  conversation: Conversation
  /** Fixed when the side chat opens and never changes; its stored thread has another id once it exists (`SideChatInfo.threadId`). */
  conversationId: string
  scope: SideChatScope
  close: () => void
}

export interface SideChatInfo {
  conversationId: string
  scope: SideChatScope
  /** The main conversation's stored thread it started from; absent for `fresh`. */
  from?: string
  /** The side chat's own stored thread, once it has one. */
  threadId?: string
  /**
   * Closed here while its thread stays, and any run there kept working: open it again with
   * `sideChat({ reopen: threadId })`. Kept in the session's storage, so a reload still lists it.
   */
  detached?: boolean
}

export interface ConversationOptions {
  runtime: ConversationRuntime
  /** Absent when the host has no way to make a second runtime: a side chat is then refused as missing. */
  sideChats?: SideChats
  services: ConversationServices
  workspaceId: string
  /**
   * Where a conversation's accepted-but-undelivered input is kept, so it survives
   * a reload. Defaults to the session's own storage; a host that offers none keeps
   * input for this conversation only.
   */
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
  /**
   * Whose run-input queue this conversation acts through. `shared` (the default): the one
   * the chat binds for this thread, which the workbench's runtime is the runtime of — a main
   * conversation must not settle a thread a second time. `own`: make this conversation the
   * queue for its thread, for a side chat, where the chat binds none.
   */
  runInputs?: 'shared' | 'own'
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

/** The wire message that carries the draft's whole list. */
export function attachmentsMessage(
  project: string,
  conversationId: string,
  attachments: DraftAttachment[],
): Extract<HostMessage, { type: 'conversationAttachments' }> {
  return {
    type: 'conversationAttachments',
    resource: { type: 'conversation', project, thread: conversationId },
    conversationId,
    attachments,
  }
}

/** The wire message that carries the models, the pick and the effort. */
export function modelsMessage(
  project: string,
  conversationId: string,
  state: ModelsState,
): Extract<HostMessage, { type: 'conversationModels' }> {
  return {
    type: 'conversationModels',
    resource: { type: 'conversation', project, thread: conversationId },
    conversationId,
    ...state,
  }
}

/** A workspace file location as the SDK carries it as context. */
export const contextReferenceOf = (
  workspaceId: string,
  { path, range, label, excerpt }: SourceReference,
): TheoremContextReference => ({
  location: {
    resource: { kind: 'file', workspaceId, path },
    ...(range ? { range: { ...range, unit: 'utf16' as const } } : {}),
  },
  ...(excerpt !== undefined ? { excerpt } : {}),
  ...(label !== undefined ? { label } : {}),
})

const toDraft = (attachment: Attachment): DraftAttachment => {
  const { status } = attachment
  const size = (attachment as { file?: File }).file?.size
  return {
    id: attachment.id,
    name: attachment.name,
    ...(attachment.contentType ? { contentType: attachment.contentType } : {}),
    ...(size !== undefined ? { size } : {}),
    state:
      status.type === 'running'
        ? 'adding'
        : status.type === 'incomplete'
          ? 'refused'
          : 'ready',
    ...(status.type === 'incomplete'
      ? { reason: status.message ?? 'The file could not be added' }
      : {}),
  }
}

export function createConversation({
  runtime,
  sideChats,
  services,
  workspaceId,
  storage = globalThis.sessionStorage,
  runInputs = 'shared',
  schedule = nextFrame,
}: ConversationOptions): Conversation {
  const sides = new Set<SideChat>()
  const info = new Map<
    SideChat,
    { base: Omit<SideChatInfo, 'threadId'>; threadId: () => string | undefined }
  >()
  /** Closed side chats, kept so they can be reopened; at most `DETACHED_LIMIT`, newest first. */
  const detachedKey = `theorem.workbench.sideChats.${workspaceId}${sideChats?.key ? `.${sideChats.key}` : ''}`
  /** Threads a reopen is in progress for, so a second one is refused before the first lands. */
  const reopening = new Set<string>()
  const readDetached = (): SideChatInfo[] => {
    try {
      const parsed: unknown = JSON.parse(storage?.getItem(detachedKey) ?? '[]')
      return Array.isArray(parsed)
        ? parsed.filter(
            (entry): entry is SideChatInfo =>
              typeof entry === 'object' &&
              entry !== null &&
              typeof (entry as SideChatInfo).threadId === 'string' &&
              typeof (entry as SideChatInfo).conversationId === 'string',
          )
        : []
    } catch {
      return []
    }
  }
  const writeDetached = (list: SideChatInfo[]) => {
    try {
      if (list.length)
        storage?.setItem(
          detachedKey,
          JSON.stringify(list.slice(0, DETACHED_LIMIT)),
        )
      else storage?.removeItem(detachedKey)
    } catch {
      // Storage full or refused: the side chat's thread is still in the thread list.
    }
  }
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
  /** Approvals an answer went out for; an answer that was accepted or whose result is unknown stands. */
  const answered = new Set<string>()

  const conversationId = () =>
    runtime.threads.mainItem.getState().remoteId ??
    runtime.threads.getState().mainThreadId

  // ---- draft attachments ------------------------------------------------------------------

  const composer = runtime.composer
  /** Files the composer turned away before it held them, by the id the draft names them with. */
  const turnedAway = new Map<string, DraftAttachment>()
  let turnedAwayFor = ''
  const attachmentListeners = new Set<(list: DraftAttachment[]) => void>()
  let attachmentsKey = '[]'

  function draft(): DraftAttachment[] {
    if (!composer) return []
    if (turnedAwayFor !== conversationId()) turnedAway.clear()
    return [
      ...composer.getState().attachments.map(toDraft),
      ...turnedAway.values(),
    ]
  }

  function announceAttachments() {
    if (disposed || attachmentListeners.size === 0) return
    const list = draft()
    const text = JSON.stringify(list)
    if (text === attachmentsKey) return
    attachmentsKey = text
    for (const listener of [...attachmentListeners]) listener(list)
  }

  async function addFiles(files: File[]) {
    if (!composer) return
    for (const file of files) {
      const known = new Set(composer.getState().attachments.map((a) => a.id))
      try {
        await composer.addAttachment(file)
      } catch (error) {
        const held = composer
          .getState()
          .attachments.some((attachment) => !known.has(attachment.id))
        // The composer holds a file that failed in its adapter and says why itself; one it never took is ours to name.
        if (!held) {
          const id = crypto.randomUUID()
          turnedAwayFor = conversationId()
          turnedAway.set(id, {
            id,
            name: file.name,
            ...(file.type ? { contentType: file.type } : {}),
            size: file.size,
            state: 'refused',
            reason: readableReason(error),
          })
        }
      }
      announceAttachments()
    }
  }

  /** Sends the composer's draft: the composer uploads its files, then hands the thread the message. */
  function sendDraft(
    answers: Answers,
    request: { clientMessageId: string; text: string },
    ids: string[],
  ): Promise<Completion<Sent>> | Completion<Sent> {
    if (!composer)
      return refused(
        answers,
        'missing_capability',
        'This conversation holds no draft attachments',
      )
    const held = composer.getState().attachments
    const named = new Set(ids)
    for (const id of named) {
      const turned = turnedAway.get(id)
      const attachment = held.find((a) => a.id === id)
      if (turned)
        return refused(
          answers,
          'attachment_refused',
          `${turned.name} was refused: ${turned.reason ?? 'not accepted'}`,
        )
      if (!attachment)
        return refused(
          answers,
          'unknown_attachment',
          `No attachment ${id} is in the draft`,
        )
      const state = toDraft(attachment)
      if (state.state !== 'ready')
        return refused(
          answers,
          state.state === 'adding' ? 'attachment_adding' : 'attachment_refused',
          state.state === 'adding'
            ? `${attachment.name} is still being added`
            : `${attachment.name} was refused: ${state.reason ?? 'not accepted'}`,
        )
    }
    const extra = held.filter((attachment) => !named.has(attachment.id))
    if (extra.length)
      return refused(
        answers,
        'attachments_differ',
        `The draft also holds ${extra.map((a) => a.name).join(', ')}, which this send does not name; remove them or name them`,
      )
    const before = new Set(
      runtime.thread.getState().messages.map((message) => message.id),
    )
    const previous = composer.getState().text
    try {
      composer.setText(request.text)
      composer.send()
      // `send` takes the text at once; what the person had typed in the React composer goes back.
      if (previous) composer.setText(previous)
    } catch (error) {
      return failure(answers, error, true)
    }
    return new Promise((resolve) => {
      let off = () => {}
      const settle = (completion: Completion<Sent>) => {
        off()
        pendingSends.delete(abandon)
        resolve(remember(request.clientMessageId, completion))
      }
      const abandon = () =>
        settle({
          ...answers,
          outcome: 'uncertain',
          reason: 'The conversation closed before the message was shown',
        })
      const check = () => {
        const state = runtime.thread.getState()
        const fresh = state.messages.find(
          (message) => message.role === 'user' && !before.has(message.id),
        )
        if (fresh) {
          settle(
            accepted(answers, {
              clientMessageId: request.clientMessageId,
              messageId: fresh.id,
            }),
          )
          return
        }
        const now = composer.getState()
        if (now.submission !== undefined || (now.inTransit?.length ?? 0) > 0)
          return
        // Nothing is being prepared and the thread shows nothing new.
        const back = now.attachments.filter((a) => named.has(a.id))
        const failed = back.find((a) => a.status.type === 'incomplete')
        if (failed) {
          // The composer returned the message to its draft: nothing went out.
          if (now.text === request.text) composer.setText(previous)
          settle({
            ...answers,
            outcome: 'failed',
            reason:
              (failed.status.type === 'incomplete' && failed.status.message) ||
              `${failed.name} could not be uploaded`,
          })
          return
        }
        settle({
          ...answers,
          outcome: 'uncertain',
          reason: 'The runtime did not show the message after it was sent',
        })
      }
      pendingSends.add(abandon)
      off = runtime.thread.subscribe(check)
      check()
    })
  }
  const pendingSends = new Set<() => void>()

  // ---- references -------------------------------------------------------------------------

  /** Puts a turn's references where the React composer's are, so the run that follows carries them. */
  function carry(
    answers: Answers,
    references: SourceReference[] | undefined,
  ): { added: TheoremContextReference[] } | Completion<never> {
    if (!references?.length) return { added: [] }
    if (!services.references)
      return refused(
        answers,
        'missing_capability',
        'This host cannot carry context references',
      )
    return {
      added: services.references.add(
        references.map((reference) =>
          contextReferenceOf(workspaceId, reference),
        ),
      ),
    }
  }

  /** A turn that was refused or failed cleanly leaves no reference it added behind. */
  function withdraw(
    added: TheoremContextReference[],
    completion: Completion<Sent>,
  ) {
    if (
      added.length &&
      (completion.outcome === 'refused' || completion.outcome === 'failed')
    )
      services.references?.remove(added)
    return completion
  }

  // ---- models -----------------------------------------------------------------------------

  const modelListeners = new Set<(state: ModelsState) => void>()
  let catalog: Awaited<ReturnType<ModelServices['catalog']>> | undefined
  let modelsWanted = false
  let modelsKey = ''
  /** Held while this owner sets a pick itself, so the one message that follows comes from the setter. */
  let muted = false

  const openThread = () => runtime.threads.mainItem.getState().remoteId

  function modelsState(): ModelsState | undefined {
    const models = services.models
    if (!models || !catalog) return undefined
    const selected = models.selected() ?? catalog.defaultRef
    const entry = catalog.models.find((model) => model.ref === selected)
    const effort = models.effort(openThread())
    return {
      models: catalog.models.map((model) => ({
        ref: model.ref,
        label: model.label,
        ...(model.contextTokens !== undefined
          ? { contextTokens: model.contextTokens }
          : {}),
      })),
      ...(selected ? { selected } : {}),
      ...(effort ? { effort } : {}),
      efforts: [...(entry ? entry.effortLevels : models.levels)],
    }
  }

  function announceModels(force: boolean) {
    if (disposed || !modelsWanted) return
    const state = modelsState()
    if (!state) return
    const text = `${conversationId()}|${JSON.stringify(state)}`
    if (!force && text === modelsKey) return
    modelsKey = text
    for (const listener of [...modelListeners]) listener(state)
  }

  async function readCatalog(answers: Answers) {
    if (!services.models)
      return refused(
        answers,
        'missing_capability',
        'This host does not list models',
      )
    try {
      catalog = await services.models.catalog()
    } catch (error) {
      return failure(answers, error, false)
    }
    return undefined
  }

  /** The tree of the thread `history.thread`, read for the state `history.key` named. */
  let history:
    { thread: string; key: string; tree: ThreadTree | null } | undefined
  let historyKey = ''

  /** Reads the tree again when the thread changes or a run starts or ends. A thread with no durable id has none. */
  function refreshHistory() {
    const load = services.history
    const thread = runtime.threads.mainItem.getState().remoteId
    if (!load || !thread) return
    const state = `${thread}|${runtime.thread.getState().isRunning}`
    if (state === historyKey) return
    historyKey = state
    load(thread).then(
      (tree) => {
        if (disposed || historyKey !== state) return
        history = { thread, key: state, tree }
        changed()
      },
      () => {},
    )
  }

  const historyOf = (): ConversationHistory | undefined => {
    const tree = history?.tree
    if (!tree || history?.thread !== conversationId()) return undefined
    return {
      rootBranchId: tree.rootBranchId,
      selectedBranchId: tree.selectedBranchId,
      forks: tree.forks.map((fork) => ({
        branchId: fork.branchId,
        ...(fork.parentBranchId && { parentBranchId: fork.parentBranchId }),
        ...(fork.forkedAfterMessageId && {
          forkedAfterMessageId: fork.forkedAfterMessageId,
        }),
        createdAtMs: fork.createdAtMs,
      })),
      activeRunId: tree.activeRunId,
      ...(tree.lastRunOutcome && { lastRunOutcome: tree.lastRunOutcome }),
      ...(tree.lastReplyAtMs !== undefined && {
        lastReplyAtMs: tree.lastReplyAtMs,
      }),
      ...(tree.origin && { origin: tree.origin }),
    }
  }

  function build(): ConversationSnapshot {
    refreshHistory()
    const state = runtime.thread.getState()
    const transcript = transcriptOf(state.messages, state.isRunning)
    const used = contextOf(state.messages)
    const body = {
      conversationId: conversationId(),
      loading: state.isLoading,
      ...transcript,
      queued: rowsOf(keptInputs()),
      ...(historyOf() && { history: historyOf() }),
      ...(used?.window !== undefined && {
        context: { usedTokens: used.tokens, windowTokens: used.window },
      }),
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

  // ---- run input -------------------------------------------------------------------------

  // Words sent to a working run are one recoverable transaction: kept before they are sent,
  // listed until the run shows them, and settled — as a next turn, or as one row with Retry —
  // only once both this chat's stream and Theorem's thread have closed. ONE queue per thread
  // decides all of that, and this conversation acts through it rather than beside it. The chat
  // binds one for its own thread (`bindRunInput`, lib/theorem/run-input-runtime), and the
  // workbench drives that same runtime, so a main conversation reads that queue and adds none:
  // a second queue would restore the same record, settle the thread twice, and never hear the
  // composer's own Stop. A side chat has no classic binding, so its owner makes the queue for
  // its thread and keeps it while that thread is the one open.

  /** This conversation's own name: the waiting place and the registration a side chat owns. */
  const stableKey = `workbench:${runtime.threads.getState().mainThreadId}`
  /** The thread now open, which is the key the chat's queue for it is registered under. */
  const threadKey = () =>
    runtime.threads.mainItem.getState().id ??
    runtime.threads.getState().mainThreadId
  const ownInputs = runInputs === 'own'

  /** What this conversation's thread keeps: one queue's decision, read where it lives. */
  const keptInputs = (): readonly PendingRunInput[] =>
    (ownInputs
      ? runInput?.getSnapshot()
      : useRunInputs.getState()[threadKey()]) ?? []
  const submitInputs = (text: string, id: string) =>
    ownInputs
      ? (runInput?.submit(text, id) ?? false)
      : submitRunInput(threadKey(), text, id)
  const replayInputs = (id: string) =>
    ownInputs ? runInput?.retry(id) : retryRunInput(threadKey(), id)
  const dismissInputs = (id: string) =>
    ownInputs ? runInput?.dismiss(id) : dismissRunInput(threadKey(), id)
  const stopInputs = () =>
    ownInputs ? runInput?.stop() : stopRunInputs(threadKey())

  /** The receipt parts this chat shows, each under what Theorem called that input. */
  const shownInputs = (messages: readonly ThreadMessage[]) =>
    messages.flatMap((message) =>
      message.content.flatMap((part) => {
        const receipt =
          part.type === 'data' && part.name === 'theorem-user_input'
            ? inputReceipt(part.data)
            : undefined
        return receipt ? [receipt] : []
      }),
    )
  /**
   * One kept message, as the panel lists it under the composer. The two settled-at-failed rows
   * are told apart the way the contract tells them apart: Theorem's receipt saying the run
   * never took the words, versus a send whose result nobody can confirm.
   */
  const rowOf = (item: PendingRunInput): QueuedInput => ({
    clientMessageId: item.id,
    text: item.text,
    state:
      item.state === 'failed'
        ? // Confirmed not delivered, so it belongs to the next turn: Retry may send these words
          // again. The panel's Retry names a fresh message, which is safe exactly here.
          item.retryAsTurn
          ? 'failed'
          : // Unconfirmed: the words may be on the thread. A fresh request key would be a second
            // message, so this row is listed as uncertain; only a replay of this same request
            // may send it again.
            'uncertain'
        : item.state === 'queued' || item.state === 'next'
          ? 'queued'
          : 'sending',
    ...(item.state === 'failed' && item.error ? { reason: item.error } : {}),
  })
  /**
   * What the composer still owes a person for words the transcript does not show: a row the
   * run has taken needs no second listing, but one that settled does — the run's own record of
   * words it never took is not the person's message, and the Retry they are owed is not
   * satisfied by a transcript part.
   */
  const rowsOf = (items: readonly PendingRunInput[]) =>
    items
      .filter(
        (item) =>
          !item.visible || item.state === 'failed' || item.state === 'next',
      )
      .map(rowOf)

  /** A side chat's own queue, and the stored thread it was made for. */
  let runInput: RunInputQueue | undefined
  let queueFor: string | undefined
  let unregisterInputs: (() => void) | undefined

  const inputHost: RunInputHost = {
    snapshot() {
      const state = runtime.thread.getState()
      return {
        threadId: runtime.threads.mainItem.getState().remoteId,
        // The run input may join, which is the one `input` admits to.
        runId: state.isRunning ? lastRunId() : undefined,
        isRunning: state.isRunning,
        isLoading: state.isLoading,
        inputs: shownInputs(state.messages),
        localUserTexts: state.messages.flatMap((message) =>
          message.role === 'user'
            ? message.content.flatMap((part) =>
                part.type === 'text' ? [part.text] : [],
              )
            : [],
        ),
      }
    },
    async refresh() {
      const read = services.runInput
      const threadId = runtime.threads.mainItem.getState().remoteId
      if (!read || !threadId)
        throw new Error('This conversation has no stored thread to read back')
      const thread = await read.thread(threadId)
      return {
        active: thread.active,
        ...(thread.runId ? { runId: thread.runId } : {}),
        inputs: thread.inputs,
        userTexts: thread.userTexts ?? [],
      }
    },
    // The message is the key it goes under, so a replay sends it and never a fresh
    // one. A host that confirms nothing leaves the thread's own record to settle it.
    async send(runId, text, requestKey) {
      return (
        (await services.sendInput({ runId, inputId: requestKey, text })) ?? {
          inputId: requestKey,
          text,
          status: 'queued' as const,
        }
      )
    },
    async receipts(runId) {
      const read = services.runInput
      if (!read) throw new Error('This host does not read a closed run back')
      return read.receipts(runId)
    },
    // A fallback belongs to its submitted text, not to what the person may since have
    // added to the draft; the turn it starts carries no references of this one.
    append: (text) =>
      runtime.thread.append({
        role: 'user',
        content: [{ type: 'text', text }],
        runConfig: { custom: { theoremRunInput: true } },
      }),
    changed: (items) => {
      useRunInputs.setState({ [stableKey]: items })
      changed()
    },
    describeError,
    attemptId: stableKey,
    // A side chat's waiting place is its own: the main draft's kept words belong to a chat
    // the person may still be opening, and no other conversation may read or clear them.
    pendingKey: pendingInputKey(stableKey),
    // A retried message's text is kept until the send recovery on this thread, or the thread
    // itself, holds it: what a person is owed is that it is not lost, not that it is listed twice.
    savedSend: pendingSendText,
    storage,
  }

  const makeInputs = () => {
    runInput = createRunInputQueue(inputHost)
    unregisterInputs = registerRunInputQueue(stableKey, runInput)
    queueFor = runtime.threads.mainItem.getState().remoteId
    runInput.observe()
  }
  /**
   * A queue belongs to one stored thread, so what thread A kept stays in A's record: a side
   * chat whose thread becomes another one is given a queue of its own, and the words kept for
   * the first stay where the next owner of that thread will find them. A first stored id is
   * not a change — a chat still being created keeps its own words, which is what its waiting
   * place is for.
   */
  const syncInputs = () => {
    if (!ownInputs) return
    const thread = runtime.threads.mainItem.getState().remoteId
    if (!runInput) return makeInputs()
    if (queueFor && thread && thread !== queueFor) {
      unregisterInputs?.()
      unregisterInputs = undefined
      makeInputs()
    }
  }
  syncInputs()
  /** A run that ends in another tab changes nothing here, so a queue is asked again on a clock. */
  const inputWatchdog = ownInputs
    ? setInterval(() => {
        if (runInput?.getSnapshot().length) runInput.observe()
      }, 2_000)
    : undefined
  ;(inputWatchdog as unknown as { unref?: () => void } | undefined)?.unref?.()
  /** The chat's queue announces itself: the snapshot follows its decision, never a copy of it. */
  const offInputs = ownInputs
    ? undefined
    : useRunInputs.subscribe((state, previous) => {
        const thread = threadKey()
        if (state[thread] === previous[thread]) return
        changed()
      })

  const runsListeners = new Set<(runs: string[]) => void>()
  const runsNow = () => {
    const joined = workingRuns(runtime.thread.getState().messages)
    return joined ? joined.split(' ') : []
  }
  const endedListeners = new Set<(runs: string[]) => void>()
  let announcedRuns = runsNow().join(' ')
  let announcedThread = threadKey()
  function announceRuns() {
    if (disposed) return
    const runs = runsNow()
    const thread = threadKey()
    const before = announcedRuns
    const sameThread = thread === announcedThread
    announcedThread = thread
    if (runs.join(' ') === before) return
    announcedRuns = runs.join(' ')
    for (const listener of [...runsListeners]) listener(runs)
    // Runs that left the set while the same thread stayed open finished. A switch to another
    // thread only takes its runs out of view, so it ends nothing.
    const ended = sameThread
      ? (before ? before.split(' ') : []).filter((run) => !runs.includes(run))
      : []
    if (ended.length)
      for (const listener of [...endedListeners]) listener(ended)
  }

  const offThread = runtime.thread.subscribe(() => {
    announceRuns()
    syncInputs()
    runInput?.observe()
    changed()
    announceAttachments()
    announceModels(false)
  })
  const offThreads = runtime.threads.subscribe(() => {
    syncInputs()
    runInput?.observe()
    changed()
    announceAttachments()
    announceModels(false)
  })
  const offModels = services.models?.subscribe(() => {
    if (!muted) announceModels(false)
  })

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

  /**
   * A blank draft is not a message: either the person said words, or something rides on the
   * send — a file it carries, or a draft attachment to upload with it. An edit offers only
   * words, since the message it replaces brings its own attachments.
   */
  const nothingSaid = (
    text: string,
    carried?: {
      attachments?: readonly unknown[] | undefined
      draftIds?: readonly string[] | undefined
    },
  ) =>
    !text.trim() && !carried?.attachments?.length && !carried?.draftIds?.length

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
        if (nothingSaid(request.text, request))
          return refused(
            answers,
            'blank',
            'A message needs words or a file on it',
          )
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
        const carried = carry(answers, request.references)
        if ('outcome' in carried) return carried
        const { added } = carried
        if (request.draftIds?.length) {
          if (request.attachments?.length) {
            if (added.length) services.references?.remove(added)
            return refused(
              answers,
              'attachments_mixed',
              'A send names draft attachments or uploaded ones, not both',
            )
          }
          return Promise.resolve(
            sendDraft(answers, request, request.draftIds),
          ).then((completion) => withdraw(added, completion))
        }
        return withdraw(
          added,
          append(answers, request.clientMessageId, {
            content: [{ type: 'text', text: request.text }],
            attachments: request.attachments,
          }),
        )
      })
    },

    input(request) {
      const id = request.clientMessageId
      // A row this thread already keeps under that id is the same message, not a new send:
      // the panel's Retry names the row it shows, and the words may then have no run left to
      // join. What becomes of them belongs to the queue — replayed to a run that works, or
      // sent as the next turn — so this goes past the once-a-message rule below, which
      // governs words not offered yet.
      const kept = keptInputs().find((item) => item.id === id)
      if (kept) {
        const { answers, refusal } = begin(request)
        if (refusal) return Promise.resolve(refusal)
        // One id names one message: other words under it are a different message this id
        // cannot carry, and replaying the kept words would send what nobody offered.
        if (kept.text !== request.text)
          return Promise.resolve(
            refused(
              answers,
              'input_not_kept',
              'That message id already names other words',
            ),
          )
        replayInputs(id)
        return Promise.resolve(
          remember(id, accepted(answers, { clientMessageId: id })),
        )
      }
      return once(request, (answers) => {
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
        // New words are kept under this id and sent there and then: what the composer is
        // owed by this answer is that the message is saved for recovery, and how the send
        // turns out belongs to the row.
        if (!submitInputs(request.text, id))
          return refused(
            answers,
            'input_not_kept',
            'These words could not be kept for the run, so nothing was sent for them',
          )
        return remember(id, accepted(answers, { clientMessageId: id }))
      })
    },

    async dismissInput(request) {
      const { answers, refusal } = begin(request)
      if (refusal) return refusal
      const id = request.clientMessageId
      dismissInputs(id)
      return accepted(answers, { clientMessageId: id })
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
      // A person's Stop must not answer itself: what the run never took stays listed
      // with Retry instead of becoming another response. The queue this thread works
      // through is the one told, whichever surface it belongs to.
      stopInputs()
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
        if (nothingSaid(request.text))
          return refused(
            answers,
            'blank',
            'An edit needs the words it replaces them with',
          )
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
        const carried = carry(answers, request.references)
        if ('outcome' in carried) return carried
        return withdraw(
          carried.added,
          append(answers, request.clientMessageId, {
            parentId: target.parentId,
            sourceId: target.message.id,
            content: [{ type: 'text', text: request.text }],
            // The edited message keeps the attachments of the one it replaces;
            // the runtime resolves them by id as it did on the first send.
            attachments: target.message.attachments,
          }),
        )
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
      const { threadId, projectId } = request
      if (projectId) services.openUnder?.(threadId, projectId)
      try {
        await runtime.threads.switchToThread(threadId)
      } catch (error) {
        if (projectId) services.openUnder?.(threadId, undefined)
        return failure(answers, error, false)
      }
      return accepted(answers, { conversationId: conversationId() })
    },

    async switchBranch(request) {
      const { answers, refusal } = begin(request)
      if (refusal) return refusal
      const { threadId, branchId } = request
      if (!services.history || !services.selectBranch)
        return refused(
          answers,
          'missing_capability',
          'This host does not read or set a thread’s branches',
        )
      const read = async (): Promise<ThreadTree | null | Completion<never>> => {
        try {
          return await services.history!(threadId)
        } catch (error) {
          return hasStatus(error, 404)
            ? refused(answers, 'unknown_thread', `No thread ${threadId}`)
            : failure(answers, error, false)
        }
      }
      const before = await read()
      if (before && 'outcome' in before) return before
      if (!before)
        return refused(answers, 'unknown_thread', `No thread ${threadId}`)
      if (
        branchId !== before.rootBranchId &&
        !before.forks.some((fork) => fork.branchId === branchId)
      )
        return refused(
          answers,
          'unknown_branch',
          `Thread ${threadId} has no branch ${branchId}`,
        )
      if (before.selectedBranchId !== branchId) {
        try {
          await services.selectBranch(threadId, branchId)
        } catch (error) {
          // A refusal by status is a clean no; anything else may have been applied.
          return failure(answers, error, true)
        }
      }
      const opened = runtime.threads.mainItem.getState().remoteId
      try {
        if (opened === threadId && runtime.threads.reloadMainThread)
          await runtime.threads.reloadMainThread()
        else if (opened !== threadId)
          await runtime.threads.switchToThread(threadId)
      } catch (error) {
        return failure(answers, error, true)
      }
      // The tree after the switch, delivered now: the snapshot's history is the new selection.
      const after = await read()
      if (after && !('outcome' in after)) {
        const thread = conversationId()
        historyKey = `${thread}|${runtime.thread.getState().isRunning}`
        history = { thread, key: historyKey, tree: after }
      }
      flush()
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
      const main = runtime.threads.mainItem.getState().remoteId
      const reopen = request.reopen
      // A reopened chat keeps the scope and origin it was opened with, whatever thread the
      // main conversation shows now.
      const closedHere =
        reopen !== undefined
          ? readDetached().find((entry) => entry.threadId === reopen)
          : undefined
      const scope = closedHere?.scope ?? request.scope ?? 'fresh'
      const from = reopen !== undefined ? closedHere?.from : main
      if (reopen !== undefined && (!reopen || reopen === main))
        return refused(
          answers,
          'invalid_request',
          "A side chat reopens its own stored thread, never the main conversation's",
        )
      if (
        reopen !== undefined &&
        (reopening.has(reopen) ||
          [...info.values()].some((i) => i.threadId() === reopen))
      )
        return refused(
          answers,
          'conflict',
          'That side chat is already open',
        )
      if (reopen !== undefined && !closedHere)
        return refused(
          answers,
          'unknown_side_chat',
          'Only a side chat closed here can be reopened',
        )
      if (!reopen && scope !== 'fresh' && !from)
        return refused(
          answers,
          'not_stored',
          `A ${scope} side chat starts from the main conversation's stored thread, and this one has none yet`,
        )
      let side: SideRuntime
      if (reopen) reopening.add(reopen)
      try {
        side = await sideChats.open({
          scope,
          ...(from ? { from } : {}),
          ...(reopen ? { reopen } : {}),
        })
      } catch (error) {
        return failure(answers, error, false)
      } finally {
        if (reopen) reopening.delete(reopen)
      }
      if (disposed) {
        side.close()
        return refused(answers, 'disposed', 'The conversation is closed')
      }
      const conversation = createConversation({
        runtime: side.runtime,
        services,
        workspaceId,
        storage,
        // No classic queue is bound on a side chat's runtime, so this owner makes the one.
        runInputs: 'own',
        schedule,
      })
      let closed = false
      const chat: SideChat = {
        conversation,
        conversationId: conversation.snapshot().conversationId,
        scope,
        close() {
          if (closed) return
          closed = true
          const kept = info.get(chat)
          const stored = kept?.threadId()
          if (kept && stored)
            writeDetached([
              {
                ...kept.base,
                threadId: stored,
                detached: true,
              },
              ...readDetached().filter((entry) => entry.threadId !== stored),
            ])
          sides.delete(chat)
          info.delete(chat)
          conversation.dispose()
          side.close()
        },
      }
      if (reopen)
        writeDetached(readDetached().filter((entry) => entry.threadId !== reopen))
      sides.add(chat)
      info.set(chat, {
        base: {
          conversationId: chat.conversationId,
          scope,
          ...(scope !== 'fresh' && from ? { from } : {}),
        },
        threadId: side.threadId,
      })
      return accepted(answers, chat)
    },

    attachments: () => draft(),
    onAttachments(listener) {
      attachmentListeners.add(listener)
      return () => {
        attachmentListeners.delete(listener)
      }
    },
    addFiles,
    canAttach: composer !== undefined && services.pickFiles !== undefined,

    async attachPick(request) {
      const { answers, refusal } = begin(request)
      if (refusal) return refusal
      if (!composer || !services.pickFiles)
        return refused(
          answers,
          'missing_capability',
          'This conversation takes no attachments',
        )
      const accept = composer.getState().attachmentAccept
      if (accept === '*')
        return refused(
          answers,
          'missing_capability',
          'This conversation has no attachment intake',
        )
      let files: File[]
      try {
        files = await services.pickFiles(accept)
      } catch (error) {
        return failure(answers, error, false)
      }
      // A cancelled chooser chose nothing; that is an answer, not a refusal.
      await addFiles(files)
      return accepted(answers, { added: files.length })
    },

    async removeAttachment(request) {
      const { answers, refusal } = begin(request)
      if (refusal) return refusal
      if (!composer)
        return refused(
          answers,
          'missing_capability',
          'This conversation takes no attachments',
        )
      if (turnedAway.delete(request.id)) {
        announceAttachments()
        return accepted(answers, { id: request.id })
      }
      if (!composer.getState().attachments.some((a) => a.id === request.id))
        return refused(
          answers,
          'unknown_attachment',
          `No attachment ${request.id} is in the draft`,
        )
      try {
        await composer.removeAttachment(request.id)
      } catch (error) {
        return failure(answers, error, false)
      }
      announceAttachments()
      return accepted(answers, { id: request.id })
    },

    async models(request) {
      const { answers, refusal } = begin(request)
      if (refusal) return refusal
      const unread = await readCatalog(answers)
      if (unread) return unread
      modelsWanted = true
      const state = modelsState()!
      announceModels(true)
      return accepted(answers, state)
    },

    async setModel(request) {
      const { answers, refusal } = begin(request)
      if (refusal) return refusal
      const unread = await readCatalog(answers)
      if (unread) return unread
      if (!catalog!.models.some((model) => model.ref === request.ref))
        return refused(
          answers,
          'unknown_model',
          `The catalog has no model ${request.ref}`,
        )
      modelsWanted = true
      muted = true
      try {
        services.models!.select(request.ref)
      } finally {
        muted = false
      }
      announceModels(true)
      return accepted(answers, modelsState()!)
    },

    async setEffort(request) {
      const { answers, refusal } = begin(request)
      if (refusal) return refusal
      const unread = await readCatalog(answers)
      if (unread) return unread
      const before = modelsState()!
      if (!before.efforts.includes(request.level))
        return refused(
          answers,
          'unknown_effort',
          `${request.level} is not an effort level of the selected model`,
        )
      modelsWanted = true
      muted = true
      try {
        services.models!.setEffort(openThread(), request.level)
      } finally {
        muted = false
      }
      announceModels(true)
      return accepted(answers, modelsState()!)
    },

    followedRuns: runsNow,
    onFollowedRuns(listener) {
      runsListeners.add(listener)
      return () => void runsListeners.delete(listener)
    },
    onRunsEnded(listener) {
      endedListeners.add(listener)
      return () => void endedListeners.delete(listener)
    },
    onModels(listener) {
      modelListeners.add(listener)
      return () => {
        modelListeners.delete(listener)
      }
    },
    canPickModel: services.models !== undefined,

    canSideChat: sideChats !== undefined,
    canSwitchBranch:
      services.history !== undefined && services.selectBranch !== undefined,

    sideChats: () => {
      const open = [...sides].map((chat) => {
        const { base, threadId } = info.get(chat)!
        const stored = threadId()
        return { ...base, ...(stored ? { threadId: stored } : {}) }
      })
      const shown = new Set(open.map((chat) => chat.threadId))
      return [
        ...open,
        ...readDetached().filter((entry) => !shown.has(entry.threadId)),
      ]
    },

    dispose() {
      if (disposed) return
      disposed = true
      for (const abandon of [...pendingSends]) abandon()
      for (const chat of [...sides]) chat.close()
      pending?.()
      pending = undefined
      if (inputWatchdog) clearInterval(inputWatchdog)
      // A queue this owner made outlives nothing but this owner: closing it leaves the kept
      // words to the next owner of this thread, and takes this conversation's rows down.
      // A queue the chat made for its thread is the chat's to close, not this owner's.
      unregisterInputs?.()
      offThread()
      offThreads()
      offInputs?.()
      offModels?.()
      listeners.clear()
      attachmentListeners.clear()
      modelListeners.clear()
      runsListeners.clear()
      endedListeners.clear()
    },
  }
}
