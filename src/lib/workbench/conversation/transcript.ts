// SOURCING: @assistant-ui/react's ThreadMessage parts as the runtime holds them, data parts named per @theoremharness/sdk/assistant-ui (`theorem-user_input`, `theorem-program`, `theorem-host_call`, `theorem-progress`, and a present call's `theorem-client_operation`, whose views view-reference's presentedViewSources reads), the chat's delegation part reader (working-runs readDelegation) and plainObjective, and the chat's own readApproval / approvalOutcome, run-input's inputReceipt and client's describeError and terminal-code's argsDiff for the code a write or edit carries while it streams; the reading follows components/terminal/terminal-transcript.ts without its terminal-only highlighting, and adds the stable ids and run state the workbench needs

import type { ThreadMessage } from '@assistant-ui/react'
import { approvalOutcome, readApproval } from '@/lib/theorem/approval'
import type { ApprovalOutcome, TheoremApproval } from '@/lib/theorem/approval'
import { describeError } from '@/lib/theorem/client'
import { presentedViewSources } from '@/lib/generative/view-reference'
import { plainObjective } from '@/lib/theorem/delegations'
import { DELEGATION_PART, readDelegation } from '@/lib/theorem/working-runs'
import { inputReceipt } from '@/lib/theorem/run-input'
import {
  argsDiff,
  openOf,
  pathOf,
  toolOutput,
} from '@/components/terminal/terminal-code'
import type { DiffLine, Open } from '@/components/terminal/terminal-code'

/** A tool result is cut at this many characters so one huge output cannot stall a frame (R41). */
export const RESULT_LIMIT = 64 * 1024

export type ToolStatus =
  'running' | 'complete' | 'error' | 'approval' | 'interrupted'

export type TranscriptPart =
  | { type: 'text'; text: string }
  | {
      type: 'reasoning'
      text: string
      /** When the thinking began and ended. Not sent today: the SDK's reasoning parts carry no times. */
      startedAtMs?: number
      endedAtMs?: number
    }
  | {
      type: 'tool'
      id: string
      /** When the call began and ended. Not sent today: the SDK's tool-call parts carry no times. */
      startedAtMs?: number
      endedAtMs?: number
      name: string
      args: string
      status: ToolStatus
      result?: string
      resultTruncated?: boolean
      approvalId?: string
      /** How the approval the call asked for stands: awaiting, approved, declined, failed or unanswered. */
      approvalOutcome?: ApprovalOutcome
      /** What the approval asked, in the words the run gave it, for the receipt once it is answered. */
      approvalSummary?: string
      /** An edit's result read as a diff, highlighted line by line; absent when the result is not a diff. */
      diff?: DiffLine[]
      /** The file the call worked on and the one-based lines it touched. */
      open?: Open
    }
  | { type: 'program'; source: string; language?: string; streaming: boolean }
  | {
      /** One delegation of the run, as Theorem's `theorem-delegation` part reports it; a later state replaces the part. */
      type: 'delegation'
      delegationId: string
      /** The run the delegation was made in (its `parentRunId`), which is where its changes are listed. */
      runId: string
      /** The specialist's role label. */
      label: string
      objective: string
      /** proposed, admitted, started, published, failed, cancelled, stale, reviewed or refused. */
      state: string
      /** The reviewer's verdict, once there is one. */
      verdict?: string
    }
  | {
      type: 'input'
      inputId?: string
      text: string
      status: string
      reason?: string
    }

export interface TranscriptAttachment {
  id: string
  name: string
  contentType?: string
}

export interface TranscriptMessage {
  /** The runtime's id for the message; it does not change while the message streams. */
  id: string
  role: 'user' | 'assistant' | 'system'
  /** The id the sender gave it, when it was sent from the workbench. */
  clientMessageId?: string
  runId?: string
  status: 'running' | 'complete' | 'incomplete' | 'requires-action'
  parts: TranscriptPart[]
  attachments: TranscriptAttachment[]
}

export type RunState =
  'idle' | 'streaming' | 'waiting_approval' | 'stopped' | 'failed'

export interface PendingApproval {
  runId: string
  approvalId: string
  toolCallId: string
  toolName: string
  summary: string
  risk: string
  options: TheoremApproval['options']
}

export interface Transcript {
  messages: TranscriptMessage[]
  run: { state: RunState; runId?: string; activity?: string; error?: string }
  approval?: PendingApproval
}

const record = (value: unknown) =>
  (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
const text = (value: unknown) => (typeof value === 'string' ? value : undefined)

function resultText(result: unknown): { text: string; truncated: boolean } {
  let full: string
  if (typeof result === 'string') full = result
  else {
    try {
      const json = JSON.stringify(result) as string | undefined
      full = json ?? String(result)
    } catch {
      full = String(result)
    }
  }
  return full.length > RESULT_LIMIT
    ? { text: full.slice(0, RESULT_LIMIT), truncated: true }
    : { text: full, truncated: false }
}

/** The run id a message carries in its custom metadata, which is how a pending approval finds its run. */
export function runIdOf(message: ThreadMessage): string | undefined {
  return text(record(message.metadata.custom).theoremRunId)
}

/** The transcript the workbench draws, read from the runtime's messages. */
export function transcriptOf(
  messages: readonly ThreadMessage[],
  isRunning: boolean,
): Transcript {
  const last = messages.at(-1)
  let approval: PendingApproval | undefined
  let activity: string | undefined

  const rows = messages.map((message): TranscriptMessage => {
    const runId = runIdOf(message)
    const live = message === last && isRunning
    const content: readonly ThreadMessage['content'][number][] = message.content
    const parts = content.flatMap((part): TranscriptPart[] => {
      if (part.type === 'text' || part.type === 'reasoning')
        return [{ type: part.type, text: part.text }]
      if (part.type === 'data' && part.name === 'theorem-user_input') {
        const input = inputReceipt(part.data)
        return input
          ? [
              {
                type: 'input',
                inputId: input.inputId,
                text: input.text,
                status: input.status,
                reason: input.reason,
              },
            ]
          : []
      }
      if (part.type === 'data' && part.name === 'theorem-client_operation')
        return presentedViewSources(part.data).map((source) => ({
          type: 'program',
          source,
          language: 'javascript',
          streaming: false,
        }))
      if (part.type === 'data' && part.name === 'theorem-program') {
        const program = record(part.data)
        const source = text(program.source)
        return source
          ? [
              {
                type: 'program',
                source,
                language: text(program.language),
                streaming: program.streaming === true && live,
              },
            ]
          : []
      }
      if (part.type === 'data' && part.name === DELEGATION_PART) {
        const delegation = readDelegation(part.data)
        return delegation
          ? [
              {
                type: 'delegation',
                delegationId: delegation.delegationId,
                runId: delegation.parentRunId,
                label: delegation.roleLabel,
                objective: plainObjective(delegation.objective),
                state: delegation.state,
                ...(delegation.verdict && { verdict: delegation.verdict }),
              },
            ]
          : []
      }
      if (part.type === 'data' && part.name === 'theorem-progress') {
        if (live) activity = text(record(part.data).label) ?? activity
        return []
      }
      if (part.type === 'data' && part.name === 'theorem-host_call') {
        const call = record(part.data)
        const state = text(call.state) ?? 'pending'
        return [
          {
            type: 'tool',
            id: text(call.id) ?? `${message.id}:host_call:${text(call.name)}`,
            name: text(call.name) ?? 'host call',
            args: text(call.effect) ?? '',
            status:
              state === 'failed'
                ? 'error'
                : state === 'pending'
                  ? live
                    ? 'running'
                    : 'interrupted'
                  : 'complete',
          },
        ]
      }
      if (part.type !== 'tool-call') return []
      const asked = readApproval(part)
      const waiting =
        asked !== undefined &&
        approvalOutcome(asked) === 'awaiting' &&
        part.result === undefined
      if (waiting && runId && !approval)
        approval = {
          runId,
          approvalId: asked.approvalId,
          toolCallId: asked.toolCallId,
          toolName: asked.toolName,
          summary: asked.summary,
          risk: asked.risk,
          options: asked.options,
        }
      const shown =
        part.result === undefined ? undefined : resultText(part.result)
      const path = pathOf(part.args)
      // An edit's diff from its result when it returned one, else from the code its
      // arguments carry, which is there while the call still streams.
      const written = argsDiff(part.args, path)
      const diff = toolOutput(part.result, path)?.diff ?? written?.diff
      const found = openOf(path, part.args, part.result)
      // A file written whole opens at its top.
      const open =
        found && written?.write && found.start === undefined
          ? { ...found, start: 1 }
          : found
      return [
        {
          type: 'tool',
          id: part.toolCallId,
          name: part.toolName,
          args: part.argsText,
          status: waiting
            ? 'approval'
            : part.result !== undefined
              ? part.isError
                ? 'error'
                : 'complete'
              : live
                ? 'running'
                : 'interrupted',
          ...(shown && {
            result: shown.text,
            resultTruncated: shown.truncated,
          }),
          ...(asked && {
            approvalId: asked.approvalId,
            approvalOutcome: approvalOutcome(asked),
            approvalSummary: asked.summary,
          }),
          ...(diff && diff.length > 0 && { diff }),
          ...(open && { open }),
        },
      ]
    })
    const attachments =
      message.role === 'user'
        ? message.attachments.map((a) => ({
            id: a.id,
            name: a.name,
            contentType: a.contentType,
          }))
        : []
    return {
      id: message.id,
      role: message.role,
      clientMessageId: text(record(message.metadata.custom).clientMessageId),
      runId,
      status:
        message.role === 'assistant'
          ? message.status.type === 'incomplete'
            ? 'incomplete'
            : message.status.type
          : 'complete',
      parts,
      attachments,
    }
  })

  const status = last?.role === 'assistant' ? last.status : undefined
  const failure =
    status?.type === 'incomplete' && status.reason === 'error'
      ? describeError(status.error)
      : undefined
  const state: RunState = approval
    ? 'waiting_approval'
    : isRunning
      ? 'streaming'
      : failure !== undefined
        ? 'failed'
        : status?.type === 'incomplete' && status.reason === 'cancelled'
          ? 'stopped'
          : 'idle'
  return {
    messages: rows,
    run: {
      state,
      runId: approval?.runId ?? (last ? runIdOf(last) : undefined),
      activity,
      error: failure,
    },
    approval,
  }
}
