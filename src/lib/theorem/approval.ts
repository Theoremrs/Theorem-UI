// SOURCING: none — moved verbatim from components/chat/theorem-parts.tsx so the workbench's conversation owner reads an approval without importing a component file; no behavior change.

import { mutate, theorem } from '@/lib/theorem/client'

type Json = Record<string, unknown>

function object(value: unknown): Json {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Json)
    : {}
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

export type TheoremApproval = {
  approvalId: string
  toolCallId: string
  toolName: string
  summary: string
  risk: string
  status: string
  approved: boolean | undefined
  /** The host's words for an approval that settled unanswered: expired or replaced. */
  reason: string | undefined
  options: Array<{ optionId: string; name: string; kind: string }>
}

/** What became of an approval, as `ApprovalPart::outcome` in theorem-surface-contracts collapses it. */
export type ApprovalOutcome =
  'awaiting' | 'approved' | 'declined' | 'failed' | 'unanswered'

const AWAITING_STATUSES = new Set(['requires_action', 'pending', 'open'])

/**
 * An approval is awaited only while its status says so. An expired or
 * replaced request settles `incomplete` with `approved` still unset, so an
 * unset decision alone is not a question anyone can answer.
 */
export function approvalOutcome(
  approval: Pick<TheoremApproval, 'status' | 'approved'>,
): ApprovalOutcome {
  if (AWAITING_STATUSES.has(approval.status)) return 'awaiting'
  if (approval.approved === true) return 'approved'
  if (approval.approved === false) return 'declined'
  return approval.status === 'failed' ? 'failed' : 'unanswered'
}

/**
 * The approval a tool call carries, settled or not. The SDK keeps the latest
 * `tool_approval` snapshot on the part's `artifact.theoremApproval` and sets
 * its human `interrupt` only while the approval awaits a decision, so an
 * answered, expired or replaced approval is read here without holding the
 * message in requires-action.
 */
export function readApproval(toolCall: {
  readonly artifact?: unknown
}): TheoremApproval | undefined {
  const part = object(object(toolCall.artifact).theoremApproval)
  const approvalId = str(part.approvalId)
  const toolCallId = str(part.toolCallId)
  if (!approvalId || !toolCallId) return undefined
  const options = Array.isArray(part.options)
    ? part.options.map(object).flatMap((o) =>
        str(o.optionId) && str(o.kind)
          ? [
              {
                optionId: o.optionId as string,
                name: str(o.name) ?? (o.kind as string),
                kind: o.kind as string,
              },
            ]
          : [],
      )
    : []
  return {
    approvalId,
    toolCallId,
    toolName: str(part.toolName) ?? 'tool',
    summary:
      str(part.summary) ?? `Allow ${str(part.toolName) ?? 'this tool'} to run?`,
    risk: str(part.risk) ?? 'unknown',
    status: str(part.status) ?? 'pending',
    approved: typeof part.approved === 'boolean' ? part.approved : undefined,
    reason: str(part.reason),
    options,
  }
}

export type ApprovalChoice =
  { optionId: string } | { decision: 'allow' | 'deny' }

/** What a plain allow or deny sends: allow once, or reject; a bare decision when the approval offers no options. */
export function approvalChoice(
  options: TheoremApproval['options'],
  allow: boolean,
): ApprovalChoice | undefined {
  if (!options.length) return { decision: allow ? 'allow' : 'deny' }
  const byKind = (kind: string) => options.find((o) => o.kind === kind)
  const option = allow
    ? byKind('allow_once')
    : (byKind('reject_once') ?? byKind('reject_always'))
  return option && { optionId: option.optionId }
}

/** Sends a decision to the run that asked for the approval. */
export function sendApprovalDecision(
  runId: string,
  approval: Pick<TheoremApproval, 'approvalId' | 'toolCallId'>,
  choice: ApprovalChoice,
) {
  return mutate((headers) =>
    theorem().chat.runs.command({
      runId,
      command: 'approval',
      approvalId: approval.approvalId,
      toolCallId: approval.toolCallId,
      ...choice,
      ...headers,
    }),
  )
}
