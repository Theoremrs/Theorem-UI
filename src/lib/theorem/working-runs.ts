// SOURCING: none — the pure part of Follow the Agent's rule (which runs a working turn's edits come from), moved out of components/ide/follow.ts so the workbench's conversation owner reads the same rule without React; @assistant-ui/react supplies only the ThreadMessage type
import type { ThreadMessage } from '@assistant-ui/react'
import type { Theorem } from './client'

export const DELEGATION_PART = 'theorem-delegation'

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

export const isString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0

/** A delegation part's data, or undefined when it is not one. */
export function readDelegation(
  data: unknown,
): Theorem.DelegationPart | undefined {
  if (!isRecord(data)) return undefined
  return isString(data.delegationId) &&
    isString(data.parentRunId) &&
    isString(data.state) &&
    isRecord(data.intent)
    ? (data as unknown as Theorem.DelegationPart)
    : undefined
}

/**
 * The runs a working turn's edits come from: its own and those of the
 * delegations it started. They travel joined, so a selected value compares
 * by content; empty while no turn works.
 */
export function workingRuns(messages: readonly ThreadMessage[]): string {
  const last = messages.at(-1)
  const working =
    last?.status?.type === 'running' || last?.status?.type === 'requires-action'
  if (!last || !working) return ''
  const runId = (last.metadata.custom as { theoremRunId?: unknown })
    .theoremRunId
  return [
    runId,
    ...last.content.map((part) =>
      part.type === 'data' && part.name === DELEGATION_PART
        ? readDelegation(part.data)?.childRunId
        : undefined,
    ),
  ]
    .filter((id): id is string => typeof id === 'string' && id.length > 0)
    .join(' ')
}
