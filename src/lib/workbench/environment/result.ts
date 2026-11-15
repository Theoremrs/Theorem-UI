// SOURCING: none — the completion shape the workbench's effect dispatcher expects (ARCHITECTURE.md
// section 3), kept local until the generated wire types land; error reading reuses `reason` from
// ./workspace-recovery and reads the SDK's TheoremError by its fields, so no SDK value is imported.

import { reason as readableReason } from './workspace-recovery'

/** Which workspace and which request a result answers. A result for a workspace that is no longer current is the caller's to drop. */
export interface Answers {
  workspaceId: string
  requestId: string
}

export type Outcome<T> =
  | { outcome: 'accepted'; value: T }
  | { outcome: 'refused'; code: string; reason: string }
  | { outcome: 'uncertain'; reason: string }
  | { outcome: 'failed'; reason: string }

export type Completion<T> = Answers & Outcome<T>

/** Why the environment cannot serve requests right now. */
export type UnavailableCause =
  | 'opening'
  | 'signed_out'
  | 'forbidden'
  | 'not_found'
  | 'unsupported'
  | 'unconfigured'
  | 'host_unreachable'
  | 'host_error'
  | 'missing_capability'

export type Availability =
  | { status: 'available' }
  | { status: 'unavailable'; cause: UnavailableCause; reason: string }

export const accepted = <T>(answers: Answers, value: T): Completion<T> => ({
  ...answers,
  outcome: 'accepted',
  value,
})

export const refused = (
  answers: Answers,
  code: string,
  reason: string,
): Completion<never> => ({ ...answers, outcome: 'refused', code, reason })

export function statusOf(error: unknown): number | undefined {
  const status =
    error && typeof error === 'object'
      ? (error as { statusCode?: unknown }).statusCode
      : undefined
  return typeof status === 'number' ? status : undefined
}

/** The machine code in a problem body, such as `workspace_not_open` or `already_exists`. */
export function codeOf(error: unknown): string | undefined {
  const body =
    error && typeof error === 'object'
      ? (error as { body?: unknown }).body
      : undefined
  const code =
    body && typeof body === 'object'
      ? (body as { code?: unknown }).code
      : undefined
  return typeof code === 'string' && code ? code : undefined
}

/**
 * Turns a thrown request error into an outcome. A 4xx is the host's decision
 * and nothing was applied: refused. With no status (the connection dropped, the
 * request timed out, it was aborted) or a 5xx or 408, a read failed, but a
 * write may have been applied: uncertain, and never retried here.
 */
export function failure(
  answers: Answers,
  error: unknown,
  write: boolean,
): Completion<never> {
  const status = statusOf(error)
  const why = readableReason(error)
  if (status === 401) return refused(answers, 'signed_out', why)
  if (status === 403) return refused(answers, codeOf(error) ?? 'forbidden', why)
  if (status !== undefined && status >= 400 && status < 500 && status !== 408) {
    return refused(
      answers,
      codeOf(error) ?? (status === 404 ? 'not_found' : `http_${status}`),
      why,
    )
  }
  return write
    ? { ...answers, outcome: 'uncertain', reason: why }
    : { ...answers, outcome: 'failed', reason: why }
}

/** What a failed attempt to reach the workspace host means for availability. */
export function availabilityOf(error: unknown): Availability {
  const status = statusOf(error)
  const reason = readableReason(error)
  const unavailable = (cause: UnavailableCause): Availability => ({
    status: 'unavailable',
    cause,
    reason,
  })
  if (status === 401) return unavailable('signed_out')
  if (status === 403) return unavailable('forbidden')
  if (status === 404 || status === 501) return unavailable('unsupported')
  if (status === 503 && codeOf(error) === 'theorem_unconfigured')
    return unavailable('unconfigured')
  if (
    status === undefined ||
    status === 408 ||
    (status >= 502 && status <= 504)
  )
    return unavailable('host_unreachable')
  return unavailable('host_error')
}
