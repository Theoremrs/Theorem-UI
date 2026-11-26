// SDK 0.5 maps only thread.lastRun to status. Durable error parts also belong
// to older turns, so restore each message's status after the SDK maps its parts.
import { toAssistantMessages } from '@theoremharness/sdk/assistant-ui'
import type { ThreadMessageLike } from '@assistant-ui/react'
import { describeRunFailure } from './client'

export function hasTheoremError(content: ThreadMessageLike['content'], message?: string): boolean {
  return Array.isArray(content) && content.some((part) => {
    if (part.type !== 'data' || part.name !== 'theorem-error') return false
    if (message === undefined) return true
    const data = part.data && typeof part.data === 'object' && !Array.isArray(part.data)
      ? part.data as Record<string, unknown> : {}
    return describeRunFailure(data) === message || data.message === message
  })
}

/**
 * Where a user message's stored context references are put on its metadata:
 * the references the turn was sent with, which a turn sent in this session
 * carries on its run config under the same name.
 */
export const CONTEXT_REFERENCES_METADATA = 'theoremContextReferences'

/** The located references each stored user message was sent with, by message id. */
function sentReferences(messages: Parameters<typeof toAssistantMessages>[0]) {
  const sent = new Map<string, Array<unknown>>()
  for (const message of messages) {
    // The SDK's message type predates the field; the record carries it as stored.
    const references = (message as { contextReferences?: unknown }).contextReferences
    if (message.role === 'user' && Array.isArray(references) && references.length)
      sent.set(message.messageId, references)
  }
  return sent
}

/** What a stored reply says of who wrote it, in a conversation with a room. */
export type ReplyAuthor = {
  participantId: string
  label: string
  actorId?: string
}

/** Where a reply's author is put on its metadata, for the thread to name it by. */
export const AUTHOR_METADATA = 'theoremAuthor'

/**
 * The participant each stored reply was written by, as the message's routing
 * recorded it at admission (the SDK's message type predates the field). A
 * message with no routing, or one a person sent, has no participant author.
 */
function repliesAuthors(messages: Parameters<typeof toAssistantMessages>[0]) {
  const authors = new Map<string, ReplyAuthor>()
  for (const message of messages) {
    const author = (
      message as { routing?: { author?: Record<string, unknown> } }
    ).routing?.author
    if (
      message.role !== 'assistant' ||
      author?.kind !== 'participant' ||
      typeof author.participantId !== 'string' ||
      typeof author.label !== 'string'
    )
      continue
    authors.set(message.messageId, {
      participantId: author.participantId,
      label: author.label,
      ...(typeof author.actorId === 'string' ? { actorId: author.actorId } : {}),
    })
  }
  return authors
}

export function toHistoryMessages(
  ...args: Parameters<typeof toAssistantMessages>
): ReturnType<typeof toAssistantMessages> {
  const authors = repliesAuthors(args[0])
  return withReplyAuthors(historyMessages(...args), authors)
}

function withReplyAuthors(
  messages: ReturnType<typeof toAssistantMessages>,
  authors: ReadonlyMap<string, ReplyAuthor>,
): ReturnType<typeof toAssistantMessages> {
  if (!authors.size) return messages
  return messages.map((message) => {
    const author = message.id ? authors.get(message.id) : undefined
    return author && message.role === 'assistant'
      ? {
          ...message,
          metadata: {
            ...message.metadata,
            custom: { ...message.metadata?.custom, [AUTHOR_METADATA]: author },
          },
        }
      : message
  })
}

function historyMessages(
  ...args: Parameters<typeof toAssistantMessages>
): ReturnType<typeof toAssistantMessages> {
  const sent = sentReferences(args[0])
  return toAssistantMessages(...args).map((message) => {
    const references = message.role === 'user' && message.id ? sent.get(message.id) : undefined
    if (references)
      return {
        ...message,
        metadata: {
          ...message.metadata,
          custom: { ...message.metadata?.custom, [CONTEXT_REFERENCES_METADATA]: references },
        },
      }
    if (message.role !== 'assistant' || !Array.isArray(message.content)) return message
    const failure = message.content.find(
      (part) => part.type === 'data' && part.name === 'theorem-error',
    )
    if (!failure || failure.type !== 'data') return message
    const data = failure.data && typeof failure.data === 'object' && !Array.isArray(failure.data)
      ? failure.data as Record<string, unknown> : {}
    // Preserve the SDK's authoritative cancellation/interrupt classification.
    if (message.status?.type === 'incomplete') return message
    return {
      ...message,
      status: {
        type: 'incomplete',
        reason: data.code === 'interrupted' ? 'other' : 'error',
        error: describeRunFailure(data),
      },
    }
  })
}
