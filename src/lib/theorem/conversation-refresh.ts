import { ExportedMessageRepository } from '@assistant-ui/react'
import type { ThreadMessage, ThreadRuntime } from '@assistant-ui/react'
import type { Theorem } from './client'
import { toHistoryMessages } from './message-history'

function localRunId(message: ThreadMessage): string | undefined {
  const runId = message.metadata.custom.theoremRunId
  return message.role === 'assistant' && typeof runId === 'string' && runId
    ? runId
    : undefined
}

type Gap = {
  parentId: string
  successorId?: string
  messages: Theorem.Message[]
}

/** Find durable additions before exporting the local repository. */
function historyGaps(
  visible: readonly ThreadMessage[],
  durable: readonly Theorem.Message[],
): Gap[] {
  const byId = new Map(
    durable.map((message, index) => [message.messageId, index]),
  )
  const byRun = new Map<string, number>()
  durable.forEach((message, index) => {
    if (
      message.role === 'assistant' &&
      message.runId &&
      !byRun.has(message.runId)
    )
      byRun.set(message.runId, index)
  })
  const indexOf = (message: ThreadMessage) => {
    const run = localRunId(message)
    const exact = byId.get(message.id)
    const byAssistantRun = run ? byRun.get(run) : undefined
    // Keep the first durable match (which can be a streamed assistant's run).
    return exact !== undefined && byAssistantRun !== undefined
      ? Math.min(exact, byAssistantRun)
      : (exact ?? byAssistantRun)
  }
  const head = visible.at(-1)!
  const headIndex = indexOf(head)
  if (headIndex === undefined) return []
  const present = new Set(visible.map((message) => message.id))
  const presentRuns = new Set(
    visible.flatMap((message) => localRunId(message) ?? []),
  )
  const gaps: Gap[] = []
  visible.slice(0, -1).forEach((anchor, offset) => {
    if (anchor.role !== 'assistant') return
    const index = indexOf(anchor)
    if (index === undefined) return
    let parentId = durable[index]!.messageId
    const missing: Theorem.Message[] = []
    for (let next = index + 1; next < durable.length; next++) {
      const candidate = durable[next]!
      if (
        candidate.role !== 'assistant' ||
        candidate.parentMessageId !== parentId ||
        present.has(candidate.messageId) ||
        (candidate.runId && presentRuns.has(candidate.runId))
      )
        break
      missing.push(candidate)
      parentId = candidate.messageId
    }
    if (missing.length)
      gaps.push({
        parentId: anchor.id,
        successorId: visible[offset + 1]!.id,
        messages: missing,
      })
  })
  if (headIndex + 1 < durable.length)
    gaps.push({ parentId: head.id, messages: durable.slice(headIndex + 1) })
  return gaps
}

/** Use assistant-ui's existing repository conversion and preserve local entries. */
function graftMessages(
  entries: Map<string, ExportedMessageRepository['messages'][number]>,
  parentId: string,
  messages: readonly Theorem.Message[],
  snapshot: Theorem.ThreadSnapshot,
): string {
  const additions = ExportedMessageRepository.fromArray(
    toHistoryMessages([...messages], snapshot.thread),
  )
  for (const entry of additions.messages) {
    entries.set(entry.message.id, {
      ...(entries.get(entry.message.id) ?? entry),
      parentId,
    })
    parentId = entry.message.id
  }
  return parentId
}

/** Keep local IDs, configuration and side branches while filling durable gaps. */
function reconcileHistory(
  repository: ExportedMessageRepository,
  gaps: readonly Gap[],
  snapshot: Theorem.ThreadSnapshot,
): ExportedMessageRepository | undefined {
  const entries = new Map(
    repository.messages.map((entry) => [entry.message.id, entry]),
  )
  let headId = repository.headId
  let changed = false
  for (const gap of gaps) {
    if (!entries.has(gap.parentId)) continue
    const successor = gap.successorId ? entries.get(gap.successorId) : undefined
    if (gap.successorId && !successor) continue
    const parentId = graftMessages(
      entries,
      gap.parentId,
      gap.messages,
      snapshot,
    )
    if (successor) entries.set(successor.message.id, { ...successor, parentId })
    else headId = parentId
    changed = true
  }
  if (changed) return { headId, messages: [...entries.values()] }
}

export type RefreshCursor = {
  snapshot?: string
  messages?: readonly ThreadMessage[]
}

/** Import a completed background answer only while the visible conversation is unchanged. */
export async function refreshConversation(
  thread: Pick<ThreadRuntime, 'getState' | 'export' | 'import'>,
  load: () => Promise<Theorem.ThreadSnapshot>,
  cursor?: RefreshCursor,
  active: () => boolean = () => true,
): Promise<boolean> {
  const before = thread.getState()
  if (before.isRunning || before.isLoading) return false
  const snapshot = await load()
  const now = thread.getState()
  if (
    !active() ||
    now.isRunning ||
    now.isLoading ||
    now.messages !== before.messages ||
    snapshot.liveRun
  )
    return false
  if (!now.messages.length) return false
  const { threadId, selectedBranchId, revision } = snapshot.thread
  const version = JSON.stringify([
    threadId,
    selectedBranchId,
    snapshot.viewedBranchId,
    revision,
  ])
  if (cursor?.snapshot === version && cursor.messages === now.messages)
    return false
  const gaps = historyGaps(now.messages, snapshot.messages)
  const extended = gaps.length
    ? reconcileHistory(thread.export(), gaps, snapshot)
    : undefined
  if (extended) thread.import(extended)
  if (cursor) {
    cursor.snapshot = version
    cursor.messages = thread.getState().messages
  }
  return !!extended
}
