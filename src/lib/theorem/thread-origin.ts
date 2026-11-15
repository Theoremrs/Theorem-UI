// SOURCING: @theoremharness/sdk threads.get and the thread origin it stores (forked or continued); the plain half of thread-tree.ts, split out so a caller that is not a React hook can start a thread from another
import { theorem } from './client'
import type { Theorem } from './client'

/** A message as the chat shows it. One sent this session has a local id, and the run that wrote it. */
export type ForkPoint = { messageId: string; runId?: string }

export type ThreadFrom =
  | { kind: 'forked'; threadId: string; at?: ForkPoint }
  | { kind: 'continued'; threadId: string }

/**
 * The durable message a fork copies through: the one named, on whichever of
 * the thread's branches holds it, or the selected branch's last message.
 */
async function forkOrigin(
  { thread, messages, branches }: Theorem.ThreadSnapshot,
  at: ForkPoint | undefined,
): Promise<Theorem.ThreadOrigin.Forked> {
  const origin = (branchId: string, messageId: string) =>
    ({
      kind: 'forked',
      threadId: thread.threadId,
      branchId,
      messageId,
    }) as const
  if (!at) {
    const last = messages.at(-1)
    if (!last) throw new Error('This thread has no messages to fork.')
    return origin(thread.selectedBranchId, last.messageId)
  }
  const matches = (message: Theorem.Message) =>
    message.messageId === at.messageId ||
    (at.runId !== undefined &&
      message.role === 'assistant' &&
      message.runId === at.runId)
  const found = messages.findLast(matches)
  if (found) return origin(thread.selectedBranchId, found.messageId)
  for (const { branchId } of branches) {
    if (branchId === thread.selectedBranchId) continue
    const branch = await theorem().chat.threads.get({
      threadId: thread.threadId,
      branchId,
    })
    const message = branch.messages.findLast(matches)
    if (message) return origin(branchId, message.messageId)
  }
  throw new Error('That message is not stored yet.')
}

/**
 * What a thread started from another one is created with: the source's project, the origin that
 * names where it came from, and the title a fork keeps. Reads the source; creates nothing.
 */
export async function threadOriginFor(from: ThreadFrom) {
  const source = await theorem().chat.threads.get({ threadId: from.threadId })
  const origin: Theorem.ThreadOrigin =
    from.kind === 'forked'
      ? await forkOrigin(source, from.at)
      : { kind: 'continued', threadId: from.threadId }
  return {
    projectId: source.thread.projectId,
    origin,
    // A fork carries its source's history, so it keeps its name; a
    // continuation is named by its own first turn.
    title:
      from.kind === 'forked' ? source.thread.title || undefined : undefined,
  }
}

/** A thread's branches and where it stands, as the thread list's tree and the workbench's history draw them. */
export type ThreadTree = {
  rootBranchId: string
  /** Every branch but the root, oldest first. */
  forks: Theorem.Branch[]
  selectedBranchId: string
  /** A run in progress on the authority, which may belong to another tab or device. */
  activeRunId: string | null
  lastRunOutcome: Theorem.RunEnding | undefined
  lastReplyAtMs: number | undefined
  /** The thread this one was forked or continued from. */
  origin: Theorem.ThreadOrigin | undefined
}

/** Reads a thread's tree; a thread with no root branch has none. */
export async function loadThreadTree(
  threadId: string,
): Promise<ThreadTree | null> {
  const { thread, branches, messages } = await theorem().chat.threads.get({
    threadId,
  })
  const root = branches.find((branch) => !branch.parentBranchId)
  if (!root) return null
  return {
    rootBranchId: root.branchId,
    forks: branches
      .filter((branch) => branch !== root)
      .sort((a, b) => a.createdAtMs - b.createdAtMs),
    selectedBranchId: thread.selectedBranchId,
    activeRunId: thread.activeRunId,
    lastRunOutcome: thread.lastRun?.outcome,
    lastReplyAtMs: messages.findLast((message) => message.role === 'assistant')
      ?.createdAtMs,
    origin: thread.origin,
  }
}
