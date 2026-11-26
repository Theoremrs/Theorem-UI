// SOURCING: lib/theorem/organization (OrganizationRead: every thread's running state, and whether the read was complete) for threads; the terminal host's session listing and the conversation's side-chat list for the rest. Theorem serves no project-wide run list yet, so the inventory states what it covers instead of claiming all work (OW-02).
import type { OrganizationRead } from '@/lib/theorem/organization'
import type { ActivityEntry, Execution } from './projection'
import { keyOf } from './projection'

/** A terminal session as its host lists it. A raw terminal is not an agent (ID-01). */
export interface TerminalRow {
  workspace: string
  session: string
  label: string
  /** The host's own word: running, exited, and so on. */
  state?: string
  exitCode?: number | null
  /** The run that acted here last, where the page recorded one. */
  runId?: string
}

/** A side chat this session knows of: open, or closed with its thread kept to reopen. */
export interface SideChatRow {
  conversationId: string
  threadId?: string
  running?: boolean
  detached?: boolean
}

/** A delegated specialist run the page follows. */
export interface DelegationRow {
  runId: string
  parentRunId?: string
  label: string
  execution: Execution
}

/** What the inventory covers, and what it cannot. */
export interface Completeness {
  /** Every source read in full. False while any part is partial or missing. */
  complete: boolean
  /** In words, each part the inventory could not cover; empty when complete. */
  gaps: string[]
}

export interface Inventory {
  entries: ActivityEntry[]
  completeness: Completeness
}

export interface InventoryInputs {
  /** The organization read, when it has loaded. */
  organization?: OrganizationRead
  /** Terminal sessions per workspace the host has listed; a workspace not listed is not known. */
  terminals?: TerminalRow[]
  sideChats?: SideChatRow[]
  delegations?: DelegationRow[]
  /** When these were read, in ms. */
  at: number
}

/**
 * The work a person can see now, from each owner's own listing. Threads come first in the
 * organization's order, then terminals, side chats and delegations in their owners' order;
 * nothing is ranked by time across sources (EV-01). The run list Theorem would serve
 * (OW-02) does not exist yet, so runs outside a thread's current run, such as earlier
 * attempts or other users' runs in a shared project, are named as a gap rather than
 * left out silently.
 */
export function buildInventory(inputs: InventoryInputs): Inventory {
  const gaps: string[] = [
    'Theorem serves no project-wide run list yet: only each thread’s current run is shown.',
  ]
  const entries: ActivityEntry[] = []
  const entry = (
    e: Omit<ActivityEntry, 'key' | 'observation' | 'observedAt' | 'epoch' | 'seq'>,
  ): ActivityEntry => ({
    ...e,
    key: keyOf(e.source, e.resource),
    observation: 'current',
    observedAt: inputs.at,
    epoch: 0,
    seq: 0,
  })

  const org = inputs.organization
  if (!org) gaps.push('Threads have not loaded.')
  else {
    if (!org.complete) gaps.push('Only the first page of threads was read.')
    for (const thread of org.threads) {
      const reasons = thread.attention.reasons
      const failed = reasons.find((r) => r.kind === 'failed')
      const review = reasons.find((r) => r.kind === 'review')
      const approval = reasons.find((r) => r.kind === 'approval')
      const pending = reasons.find((r) => r.kind === 'pending_turn')
      // What the thread waits on comes first: a run held at an approval is running, but it is
      // the person it waits for.
      const waiting = approval
        ? { for: 'approval' as const, ref: approval.approvalId }
        : review
          ? { for: 'approval' as const, ref: review.reviewId }
          : undefined
      const execution: Execution = waiting
        ? 'waiting'
        : thread.attention.running
          ? 'running'
          : pending
            ? 'queued'
            : failed
              ? 'failed'
              : 'unknown'
      // A thread with no run, no queued turn and no failure is at rest; it is not unfinished work.
      if (execution === 'unknown') continue
      // The active run is the thread's own word; a failed or approval reason names an earlier one
      // only when no run is active.
      const runId = thread.attention.runId ?? approval?.runId ?? failed?.runId
      entries.push(
        entry({
          source: 'thread',
          resource: thread.threadId,
          label: thread.title,
          execution,
          ...(waiting ? { waiting } : {}),
          ...(runId ? { runId } : {}),
        }),
      )
    }
  }

  if (!inputs.terminals) gaps.push('Terminal sessions have not been listed.')
  for (const row of inputs.terminals ?? []) {
    const exited =
      row.state === 'exited' || row.state === 'killed' || row.exitCode != null
    // Only a session the host says is running is shown as running; a lost session, or a word
    // the page does not know, is shown as unknown and not current.
    const running = !exited && (row.state === undefined || row.state === 'running')
    entries.push({
      ...entry({
        source: 'terminal',
        resource: `${row.workspace}/${row.session}`,
        label: row.label,
        // A program's exit says how the program ended, not whether an agent's assignment did.
        execution: running ? 'running' : 'unknown',
        reported: true,
        ...(exited && row.exitCode != null
          ? { detail: `Program exited with code ${row.exitCode}` }
          : {}),
        ...(row.runId ? { runId: row.runId } : {}),
      }),
      ...(!running && !exited ? { observation: 'stale' as const } : {}),
    })
  }

  for (const chat of inputs.sideChats ?? []) {
    if (!chat.running && !chat.detached) continue
    entries.push(
      entry({
        source: 'sideChat',
        resource: chat.threadId ?? chat.conversationId,
        label: 'Side chat',
        execution: chat.running ? 'running' : 'unknown',
        ...(chat.detached ? { detail: 'Closed here; reopen to see it' } : {}),
      }),
    )
  }

  for (const run of inputs.delegations ?? [])
    entries.push(
      entry({
        source: 'delegation',
        resource: run.runId,
        label: run.label,
        execution: run.execution,
        runId: run.runId,
        ...(run.parentRunId ? { parentRunId: run.parentRunId } : {}),
      }),
    )

  // A side chat's thread is also a thread: keep the thread's own row, once.
  const seen = new Set<string>()
  const threads = new Set(
    entries.filter((e) => e.source === 'thread').map((e) => e.resource),
  )
  const unique = entries.filter((e) => {
    if (e.source === 'sideChat' && threads.has(e.resource)) return false
    if (seen.has(e.key)) return false
    seen.add(e.key)
    return true
  })
  return { entries: unique, completeness: { complete: false, gaps } }
}
