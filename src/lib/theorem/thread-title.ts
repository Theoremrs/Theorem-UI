// SOURCING: SDK history projection; titles share its canonical text-part mapping.
import { useAuiState } from '@assistant-ui/react'
import { create } from 'zustand'
import type { ThreadMessageLike } from '@assistant-ui/react'
import { toAssistantMessages } from '@theoremharness/sdk/assistant-ui'
import type { Theorem } from './client'

export function isUntitledTitle(title: string | undefined): boolean {
  return !title?.trim() || title.trim().toLowerCase() === 'new chat'
}

export function threadTitle(
  snapshot: Pick<Theorem.ThreadSnapshot, 'thread' | 'messages'>,
  fallback: readonly ThreadMessageLike[] = [],
): string {
  if (!isUntitledTitle(snapshot.thread.title)) return snapshot.thread.title
  const messages = snapshot.messages.some((message) => message.role === 'user')
    ? toAssistantMessages(snapshot.messages, snapshot.thread)
    : fallback
  const content = messages.find((message) => message.role === 'user')?.content
  const text =
    typeof content === 'string'
      ? content
      : (content
          ?.map((part) => (part.type === 'text' ? part.text : ''))
          .join(' ') ?? '')
  return titleFrom(text)
}

function titleFrom(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim()
  if (line.length <= 60) return line || 'New chat'
  const cut = line.slice(0, 60)
  const space = cut.lastIndexOf(' ')
  return `${space > 30 ? cut.slice(0, space) : cut}...`
}

type RecoveredTitle = { revision: number; title: string }
const useRecoveredTitles = create<{ titles: Map<string, RecoveredTitle> }>(
  () => ({
    titles: new Map(),
  }),
)

export function recoveredTitle(thread: Theorem.Thread) {
  const recovered = useRecoveredTitles.getState().titles.get(thread.threadId)
  return recovered?.revision === thread.revision ? recovered.title : undefined
}

export function rememberTitle(thread: Theorem.Thread, title: string) {
  const cached = useRecoveredTitles.getState().titles
  const old = cached.get(thread.threadId)
  if (old && old.revision > thread.revision) return
  if (old?.revision === thread.revision && old.title === title) return
  const titles = new Map(cached)
  titles.delete(thread.threadId)
  titles.set(thread.threadId, { revision: thread.revision, title })
  if (titles.size > 512) titles.delete(titles.keys().next().value!)
  useRecoveredTitles.setState({ titles })
}

/** Show a recovered title as soon as it arrives, without a second list request. */
export function useThreadDisplayTitle() {
  const title = useAuiState((state) => state.threadListItem.title)
  const id = useAuiState((state) => state.threadListItem.remoteId)
  const recovered = useRecoveredTitles((state) =>
    id ? state.titles.get(id)?.title : undefined,
  )
  return isUntitledTitle(title) && recovered ? recovered : title
}
