// SOURCING: none — thin mapping from the wire's conversation effects to ./conversation (the owner), and its snapshots to the wire's conversationSnapshot message; the one conversion here is an attachment reference into the complete attachment the runtime appends
import { reply } from '../port'
import type { Of, OwnerPort } from '../port'
import type { AttachmentRef, ResourceRef } from '../wire'
import { snapshotMessage } from './conversation'
import type { Conversation } from './conversation'

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
}: ConversationPortOptions): OwnerPort<Of<'conversation'>> {
  return {
    async perform(effect, requestId) {
      const conversationId = threadOf(effect.resource)
      const request = {
        requestId,
        ...(conversationId ? { conversationId } : {}),
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
            await conversation.send({
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
            await conversation.input({ ...request, ...effect.payload }),
            sent,
          )
        case 'conversationCancel':
          return reply(
            await conversation.stop({ ...request, ...effect.payload }),
            ({ runId }) => ({
              value: {
                type: 'conversationStopped',
                ...(runId ? { runId } : {}),
              },
            }),
          )
        case 'conversationRetry':
          return reply(
            await conversation.retry({ ...request, ...effect.payload }),
            ({ messageId }) => ({
              value: { type: 'conversationRetried', messageId },
            }),
          )
        case 'conversationEdit':
          return reply(
            await conversation.edit({ ...request, ...effect.payload }),
            sent,
          )
        case 'conversationApproval': {
          const { runId, approvalId, decision } = effect.payload
          return reply(
            await conversation.approve({
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
      }
    },
    subscribe(listener) {
      listener(snapshotMessage(project, conversation.snapshot()))
      return conversation.subscribe((snapshot) =>
        listener(snapshotMessage(project, snapshot)),
      )
    },
  }
}
