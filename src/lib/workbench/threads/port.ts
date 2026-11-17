// SOURCING: none — thin mapping from the wire's threads effects to ./threads (the owner): one owner call per effect, and the owner's listing as the wire's `threadsChanged` message; the four operations the SDK has no call for (pin, tag, unread mark, title regeneration) are refused as unsupported, since the host does not grant them
import { refusal, reply } from '../port'
import type { Of, OwnerPort } from '../port'
import type { Threads } from './threads'

export type ThreadsPort = OwnerPort<Of<'threads'>>

export function createThreadsPort(
  threads: Pick<
    Threads,
    | 'list'
    | 'create'
    | 'rename'
    | 'archive'
    | 'delete'
    | 'markdown'
    | 'subscribe'
  >,
): ThreadsPort {
  return {
    async perform(effect) {
      switch (effect.kind) {
        case 'threadsList':
          return reply(await threads.list(), (listing) => ({
            value: { type: 'threads', ...listing },
          }))
        case 'threadsCreate':
          return reply(
            await threads.create(effect.payload.projectId),
            (created) => ({ value: { type: 'threadCreated', ...created } }),
          )
        case 'threadsRename':
          return reply(
            await threads.rename(effect.payload.threadId, effect.payload.title),
          )
        case 'threadsArchive':
          return reply(
            await threads.archive(
              effect.payload.threadId,
              effect.payload.archived,
            ),
          )
        case 'threadsDelete':
          return reply(await threads.delete(effect.payload.threadId))
        case 'threadsMarkdown':
          return reply(
            await threads.markdown(effect.payload.threadId),
            (markdown) => ({ value: { type: 'threadMarkdown', ...markdown } }),
          )
        case 'threadsPin':
        case 'threadsTag':
        case 'threadsUnread':
        case 'threadsRetitle':
          return refusal(
            'unsupported',
            'This account cannot pin, tag, mark unread or retitle a thread',
          )
      }
    },
    subscribe(listener) {
      return threads.subscribe((listing) =>
        listener({ type: 'threadsChanged', listing }),
      )
    },
  }
}
