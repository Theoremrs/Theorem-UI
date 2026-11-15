// SOURCING: none — thin mapping from the wire's conversation effects to ./conversation (the owner), and its snapshots to the wire's conversationSnapshot message; the one conversion here is an attachment reference into the complete attachment the runtime appends
import { refusal, reply } from '../port'
import type { Of, OwnerPort } from '../port'
import type { AttachmentRef, HostMessage, ResourceRef } from '../wire'
import { snapshotMessage } from './conversation'
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
} {
  /** Side chats by the id announced when they opened; that id never changes, whatever the thread behind it is called. */
  const sides = new Map<string, { chat: SideChat; stop: () => void }>()
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
          const stop = chat.conversation.subscribe((snapshot) =>
            emit(sideMessage(id, snapshot)),
          )
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
            }),
            opened,
          )
        case 'conversationSend': {
          const { clientMessageId, text, attachments } = effect.payload
          return reply(
            await target.send({
              ...request,
              clientMessageId,
              text,
              ...(attachments.length
                ? { attachments: attachments.map(attachment) }
                : {}),
            }),
            sent,
          )
        }
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
      return () => {
        listeners.delete(listener)
        off()
      }
    },
  }
}
