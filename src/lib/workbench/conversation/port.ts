// SOURCING: none — thin mapping from the wire's conversation effects to ./conversation (the owner), and its snapshots to the wire's conversationSnapshot message; the one conversion here is an attachment reference into the complete attachment the runtime appends
import { refusal, reply } from '../port'
import type { Of, OwnerPort } from '../port'
import type { AttachmentRef, HostMessage, ResourceRef } from '../wire'
import {
  attachmentsMessage,
  modelsMessage,
  snapshotMessage,
} from './conversation'
import type {
  Conversation,
  ConversationSnapshot,
  SideChat,
} from './conversation'

export interface ConversationPortOptions {
  conversation: Conversation
  /** The project the conversation belongs to: the wire names a conversation by project and thread. */
  project: string
}

/** The thread a conversation resource names, which makes an action drawn against another thread stale. */
const threadOf = (resource: ResourceRef): string | undefined =>
  resource.type === 'conversation' ? resource.thread : undefined

/** What the runtime appends for a file the attachment service already holds. */
const attachment = ({ id, name, contentType }: AttachmentRef) => ({
  id,
  type: contentType?.startsWith('image/')
    ? ('image' as const)
    : ('document' as const),
  name,
  ...(contentType ? { contentType } : {}),
  status: { type: 'complete' as const },
  content: [],
})

export function createConversationPort({
  conversation,
  project,
}: ConversationPortOptions): OwnerPort<Of<'conversation'>> & {
  /** The side chats open now: a side chat's id is the one `conversationSideOpened` gave. */
  sideChats: Conversation['sideChats']
  /** Whether side chats can be created here; the adapter grants `conversation.side` on it. */
  canSideChat: boolean
  /** Whether branches can be selected here; the adapter grants `conversation.branch` on it. */
  canSwitchBranch: boolean
  /** Whether files can be attached to the draft; the adapter grants `conversation.attach` on it. */
  canAttach: boolean
  /** Whether a model and an effort can be picked; the adapter grants `conversation.model` on it. */
  canPickModel: boolean
  /** Adds pasted or dropped files to the draft, the way the file chooser's are added. */
  addFiles: Conversation['addFiles']
} {
  /** Side chats by the id announced when they opened; that id never changes, whatever the thread behind it is called. */
  const sides = new Map<string, { chat: SideChat; stop: () => void }>()
  const mainId = () => conversation.snapshot().conversationId
  const listeners = new Set<(message: HostMessage) => void>()

  /** A side chat's snapshot, named by its announced id and carrying its own revision sequence. */
  const sideMessage = (id: string, snapshot: ConversationSnapshot) =>
    snapshotMessage(project, { ...snapshot, conversationId: id })

  const emit = (message: HostMessage) => {
    for (const listener of [...listeners]) listener(message)
  }

  return {
    sideChats: () => conversation.sideChats(),
    canSideChat: conversation.canSideChat,
    canSwitchBranch: conversation.canSwitchBranch,
    canAttach: conversation.canAttach,
    canPickModel: conversation.canPickModel,
    addFiles: (files) => conversation.addFiles(files),

    async perform(effect, requestId) {
      const thread = threadOf(effect.resource)
      const side = thread === undefined ? undefined : sides.get(thread)
      /** The conversation the effect's resource names. A side chat's own owner sees no id: this lookup is the check. */
      const target = side ? side.chat.conversation : conversation
      const request = {
        requestId,
        ...(!side && thread ? { conversationId: thread } : {}),
      }
      const opened = ({ conversationId: id }: { conversationId: string }) => ({
        value: { type: 'conversationOpened', conversationId: id } as const,
      })
      const sent = ({
        clientMessageId,
        messageId,
      }: {
        clientMessageId: string
        messageId?: string
      }) => ({
        value: {
          type: 'conversationSent',
          clientMessageId,
          ...(messageId ? { messageId } : {}),
        } as const,
      })

      switch (effect.kind) {
        case 'conversationSideChat': {
          const done = await conversation.sideChat({
            requestId,
            ...(effect.payload.scope ? { scope: effect.payload.scope } : {}),
          })
          if (done.outcome !== 'accepted') return reply(done)
          const chat = done.value
          const id = chat.conversationId
          const stopSnapshots = chat.conversation.subscribe((snapshot) =>
            emit(sideMessage(id, snapshot)),
          )
          const stopModels = chat.conversation.onModels((state) =>
            emit(modelsMessage(project, id, state)),
          )
          const stop = () => {
            stopSnapshots()
            stopModels()
          }
          sides.set(id, { chat, stop })
          emit(sideMessage(id, chat.conversation.snapshot()))
          return {
            outcome: 'accepted',
            value: { type: 'conversationSideOpened', conversationId: id },
          }
        }
        case 'conversationSideList':
          return {
            outcome: 'accepted',
            value: {
              type: 'conversationSideList',
              chats: conversation.sideChats(),
            },
          }
        case 'conversationSideClose': {
          if (!side)
            return refusal(
              'unknown_conversation',
              `No side chat ${thread ?? ''} is open`,
            )
          side.stop()
          side.chat.close()
          sides.delete(thread!)
          return { outcome: 'accepted' }
        }
        case 'conversationCreate':
        case 'conversationSwitch':
        case 'conversationSwitchBranch':
          if (side)
            return refusal(
              'side_chat',
              'A side chat keeps its own thread; open another side chat instead',
            )
          break
        default:
          if (thread === undefined)
            return refusal(
              'wrong_resource',
              'A conversation effect needs a conversation resource',
            )
      }

      switch (effect.kind) {
        case 'conversationCreate':
          // A new conversation replaces the one the effect was drawn against.
          return reply(await conversation.create({ requestId }), opened)
        case 'conversationSwitch':
          return reply(
            await conversation.switchTo({
              requestId,
              threadId: effect.payload.threadId,
              ...(effect.payload.projectId
                ? { projectId: effect.payload.projectId }
                : {}),
            }),
            opened,
          )
        case 'conversationSwitchBranch':
          return reply(
            await conversation.switchBranch({
              requestId,
              ...(thread ? { conversationId: thread } : {}),
              threadId: effect.payload.threadId,
              branchId: effect.payload.branchId,
            }),
            opened,
          )
        case 'conversationSend': {
          const { clientMessageId, text, attachments, references } =
            effect.payload
          // An id the draft holds is sent from the draft; any other names a file already uploaded.
          const draft = new Set(target.attachments().map(({ id }) => id))
          const named = attachments.filter(({ id }) => draft.has(id))
          const uploaded = attachments.filter(({ id }) => !draft.has(id))
          return reply(
            await target.send({
              ...request,
              clientMessageId,
              text,
              ...(uploaded.length
                ? { attachments: uploaded.map(attachment) }
                : {}),
              ...(named.length ? { draftIds: named.map(({ id }) => id) } : {}),
              ...(references?.length ? { references } : {}),
            }),
            sent,
          )
        }
        case 'conversationAttachPick':
          return reply(await target.attachPick(request))
        case 'conversationAttachRemove':
          return reply(
            await target.removeAttachment({
              ...request,
              id: effect.payload.id,
            }),
          )
        case 'conversationModels':
          return reply(await target.models(request))
        case 'conversationSetModel':
          return reply(
            await target.setModel({ ...request, ref: effect.payload.ref }),
          )
        case 'conversationSetEffort':
          return reply(
            await target.setEffort({ ...request, level: effect.payload.level }),
          )
        case 'conversationInput':
          return reply(
            await target.input({ ...request, ...effect.payload }),
            sent,
          )
        case 'conversationCancel':
          return reply(
            await target.stop({ ...request, ...effect.payload }),
            ({ runId }) => ({
              value: {
                type: 'conversationStopped',
                ...(runId ? { runId } : {}),
              },
            }),
          )
        case 'conversationRetry':
          return reply(
            await target.retry({ ...request, ...effect.payload }),
            ({ messageId }) => ({
              value: { type: 'conversationRetried', messageId },
            }),
          )
        case 'conversationEdit':
          return reply(
            await target.edit({ ...request, ...effect.payload }),
            sent,
          )
        case 'conversationApproval': {
          const { runId, approvalId, decision } = effect.payload
          return reply(
            await target.approve({
              ...request,
              runId,
              approvalId,
              decision,
              actor: { type: 'human' },
            }),
            ({ approvalId: id }) => ({
              value: { type: 'conversationApproved', approvalId: id },
            }),
          )
        }
        default:
          return refusal('unrouted_effect', 'No conversation owner call')
      }
    },

    subscribe(listener) {
      listeners.add(listener)
      listener(snapshotMessage(project, conversation.snapshot()))
      for (const [id, { chat }] of sides)
        listener(sideMessage(id, chat.conversation.snapshot()))
      const off = conversation.subscribe((snapshot) =>
        listener(snapshotMessage(project, snapshot)),
      )
      const offAttachments = conversation.onAttachments((attachments) =>
        listener(attachmentsMessage(project, mainId(), attachments)),
      )
      const offModels = conversation.onModels((state) =>
        listener(modelsMessage(project, mainId(), state)),
      )
      // The core follows these runs' edits; it hears the set once on connect and again each time it changes.
      const followed = (runs: string[]) =>
        listener({ type: 'followedRuns', runs })
      followed(conversation.followedRuns())
      const offRuns = conversation.onFollowedRuns(followed)
      return () => {
        listeners.delete(listener)
        off()
        offAttachments()
        offModels()
        offRuns()
      }
    },
  }
}
